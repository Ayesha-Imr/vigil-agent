----------------------------- MODULE Scheduler -----------------------------
(***************************************************************************)
(* vigil's job scheduler, as the code runs it.                             *)
(*                                                                         *)
(* Code (see .claude/skills/verify-scheduler/SKILL.md for the coverage    *)
(* record; every action has a "\* code: file:line" line at the sync commit) *)
(*   src/core/scheduler.ts  nextRunAt, countSlots, Scheduler.claimDue,     *)
(*                          complete, unfinishedRuns, recover              *)
(*   src/store/db.ts        triggers UNIQUE (source, external_id)          *)
(*   src/daemon.ts          Daemon.start (recover + unfinishedRuns, then   *)
(*                          after awaits the replayed runJob calls, then   *)
(*                          the timers), tickGovernorAndClock (claimDue    *)
(*                          every 30 s), runJob / finish                   *)
(*                                                                         *)
(* Atomicity, as in the code:                                              *)
(*  - claimDue is one Db.tx() over every due job: one step (ClaimDue).     *)
(*  - finish() is two synchronous db.run calls with no await between:      *)
(*    one step (Finish).                                                   *)
(*  - runJob's work (concierge turn, heartbeat, dream) awaits: the run     *)
(*    is in flight between its start and Finish, for any length of time.   *)
(*  - A crash kills the process: in-memory runs vanish, the DB stays.      *)
(*  - Daemon.start up to its first await (recover, unfinishedRuns) is one  *)
(*    step (Restart). The replayed runJob calls happen after the awaits of *)
(*    channel start and reprocessStuckTriggers (DispatchReplays), and the  *)
(*    30 s claim timer exists only after that: no ClaimDue while starting. *)
(*                                                                         *)
(* Time is abstract: `now` is Clock.now() in whole "units"; Period, LEASE  *)
(* (RUN_LEASE_MS) and MaxAge (unfinishedRuns' maxAgeMs = DAY) are in the   *)
(* same units. A unit is finer than a tick, so a claim can land exactly on *)
(* a slot.                                                                 *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
    EveryJobs,         \* jobs with kind 'every' (cron behaves the same here, see the SKILL)
    AtJobs,            \* jobs with kind 'at'
    Period,            \* "every" spec, in time units
    AtTime,            \* "at" spec: the instant it names
    LEASE,             \* RUN_LEASE_MS
    MaxAge,            \* unfinishedRuns(maxAgeMs): daemon.ts passes DAY
    MaxT,              \* the clock stops here (bound)
    MaxCrashes,        \* bound on process deaths
    RunsOutliveLease   \* TRUE: a run may still be going after RUN_LEASE_MS

Null == -1             \* SQL NULL for next_run_at / running_since

Jobs == EveryJobs \cup AtJobs                        \* rows of the jobs table
Kind == [j \in Jobs |-> IF j \in EveryJobs THEN "every" ELSE "at"]   \* jobs.kind

VARIABLES
    now,           \* Clock.now()
    up,            \* the daemon process is alive
    starting,      \* Daemon.start has not reached its timers yet
    crashes,       \* crashes so far (bound)
    nextRun,       \* jobs.next_run_at
    runningSince,  \* jobs.running_since
    enabled,       \* jobs.enabled
    lastSlot,      \* jobs.last_slot
    triggers,      \* rows of triggers with source 'clock': [id, job, slot, coalesced, at, status]
    tcount,        \* AUTOINCREMENT counter of triggers.id
    runs,          \* in memory: runJob calls whose finish() has not run: [job, tid, started]
    replay         \* in memory: the JobRun list unfinishedRuns returned, not yet given to runJob

vars == <<now, up, starting, crashes, nextRun, runningSince, enabled, lastSlot, triggers, tcount, runs, replay>>

\* A fixed injective numbering of jobs, to give each new trigger row its own id.
JobIdx == CHOOSE f \in [Jobs -> 1..Cardinality(Jobs)] : \A a, b \in Jobs : f[a] = f[b] => a = b

\* code: src/core/scheduler.ts:52-70 nextRunAt
NextRunAt(j, after) ==
    IF Kind[j] = "every" THEN after + Period              \* case "every": after + minutes * MINUTE
    ELSE IF AtTime > after THEN AtTime ELSE Null          \* case "at": t > after ? t : null

(***************************************************************************)
(* countSlots(kind, spec, from, to), the while loop step for step (the     *)
(* 1000 cap is never reached here). LoopBreak is the break test, so a      *)
(* mutant can put back the old `next >= to`.                               *)
(***************************************************************************)
\* code: src/core/scheduler.ts:72-84 countSlots (break test line 79)
RECURSIVE CountLoop(_, _, _, _, _)
CountLoop(j, t, to, n, Ge) ==
    LET next == NextRunAt(j, t) IN
    IF next = Null \/ (IF Ge THEN next >= to ELSE next > to) THEN n   \* if (next === null || next > to) break;
    ELSE CountLoop(j, next, to, n + 1, Ge)                            \* n++; t = next;

CountSlots(j, from, to) == IF Kind[j] = "at" THEN 0 ELSE CountLoop(j, from, to, 0, FALSE)
CountSlotsGe(j, from, to) == IF Kind[j] = "at" THEN 0 ELSE CountLoop(j, from, to, 0, TRUE)

-----------------------------------------------------------------------------
Init ==
    /\ now = 0
    /\ up = TRUE
    /\ starting = FALSE
    /\ crashes = 0
    \* Scheduler.create: next_run_at = nextRunAt(kind, spec, now), enabled = 1
    /\ nextRun = [j \in Jobs |-> NextRunAt(j, 0)]
    /\ runningSince = [j \in Jobs |-> Null]
    /\ enabled = [j \in Jobs |-> TRUE]
    /\ lastSlot = [j \in Jobs |-> Null]
    /\ triggers = {}
    /\ tcount = 0
    /\ runs = {}
    /\ replay = {}

(***************************************************************************)
(* The due query of claimDue:                                              *)
(*   enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= now        *)
(*   AND (running_since IS NULL OR running_since < now - RUN_LEASE_MS)     *)
(***************************************************************************)
\* code: src/core/scheduler.ts:146-151 claimDue due query
Due(j) ==
    /\ enabled[j]
    /\ nextRun[j] # Null
    /\ nextRun[j] <= now
    /\ runningSince[j] = Null \/ runningSince[j] < now - LEASE

\* INSERT ... ON CONFLICT(source, external_id) DO NOTHING with external_id `${job.id}:${slot}`:
\* ins.changes === 1 iff no trigger row has that key yet (db.ts triggers UNIQUE (source, external_id)).
\* code: src/core/scheduler.ts:157-164 INSERT ... ON CONFLICT DO NOTHING, fresh; src/store/db.ts:23 UNIQUE
Fresh(j) == ~\E tr \in triggers : tr.job = j /\ tr.slot = nextRun[j]

(***************************************************************************)
(* Scheduler.claimDue (one Db.tx) followed by `void this.runJob(run)` for  *)
(* every fresh run (daemon.ts tickGovernorAndClock). The JobRun carries    *)
(* claimedAt = now (the run's `started`). Parameterised so a mutant can    *)
(* swap one piece: DueOp = the due query, FreshOp = the unique key,        *)
(* CountOp = countSlots, NextOp = nextRunAt.                               *)
(***************************************************************************)
\* code: src/core/scheduler.ts:142-182 claimDue; src/daemon.ts:295 tickGovernorAndClock (void this.runJob)
ClaimDueWith(DueOp(_), FreshOp(_), CountOp(_, _, _), NextOp(_, _)) ==
    LET D   == {j \in Jobs : DueOp(j)}
        New == {j \in D : FreshOp(j)}
    IN
    /\ up
    /\ ~starting                 \* the 30 s timer is created at the end of Daemon.start
    /\ D # {}
    \* const next = nextRunAt(job.kind, job.spec, now, tz); ... next_run_at = ?
    /\ nextRun' = [j \in Jobs |-> IF j \in D THEN NextOp(j, now) ELSE nextRun[j]]
    \* running_since = CASE WHEN fresh THEN now ELSE running_since END
    /\ runningSince' = [j \in Jobs |-> IF j \in New THEN now ELSE runningSince[j]]
    \* last_slot = slot
    /\ lastSlot' = [j \in Jobs |-> IF j \in D THEN nextRun[j] ELSE lastSlot[j]]
    \* enabled = CASE WHEN next IS NULL AND kind = 'at' THEN 0 ELSE enabled END
    /\ enabled' = [j \in Jobs |-> IF j \in D /\ NextOp(j, now) = Null /\ Kind[j] = "at"
                                   THEN FALSE ELSE enabled[j]]
    \* INSERT INTO triggers (... payload {jobId, slot, coalesced}, created_at = now)
    /\ triggers' = triggers \cup
         {[id |-> tcount + JobIdx[j], job |-> j, slot |-> nextRun[j],
           coalesced |-> CountOp(j, nextRun[j], now), at |-> now, status |-> "received"] : j \in New}
    /\ tcount' = tcount + Cardinality(Jobs)
    \* if (fresh) runs.push({..., claimedAt: now}); then daemon: void this.runJob(run)
    /\ runs' = runs \cup {[job |-> j, tid |-> tcount + JobIdx[j], started |-> now] : j \in New}
    /\ UNCHANGED <<now, up, starting, crashes, replay>>

ClaimDue == ClaimDueWith(Due, Fresh, CountSlots, NextRunAt)

(***************************************************************************)
(* runJob's finish(status) (daemon.ts):                                    *)
(*   s.scheduler.complete(job.id, status, run.claimedAt)                   *)
(*     -> running_since = CASE WHEN claimedAt IS NULL OR running_since =   *)
(*        claimedAt THEN NULL ELSE running_since END                       *)
(*   UPDATE triggers SET status = 'done' ... WHERE id = run.triggerId      *)
(* Release is a parameter so a mutant can put back the old "by id only".   *)
(***************************************************************************)
\* code: src/daemon.ts:323-326 runJob finish; src/core/scheduler.ts:184-197 complete
FinishWith(r, Release(_)) ==
    /\ up
    /\ r \in runs
    /\ runningSince' = Release(r)
    /\ triggers' = {IF tr.id = r.tid THEN [tr EXCEPT !.status = "done"] ELSE tr : tr \in triggers}
    /\ runs' = runs \ {r}
    /\ UNCHANGED <<now, up, starting, crashes, nextRun, enabled, lastSlot, tcount, replay>>

ReleaseMine(r) ==
    IF runningSince[r.job] = r.started THEN [runningSince EXCEPT ![r.job] = Null] ELSE runningSince

ReleaseById(r) == [runningSince EXCEPT ![r.job] = Null]

Finish(r) == FinishWith(r, ReleaseMine)

\* Some in-flight run reaches finish() (its concierge turn / heartbeat / dream returned,
\* or the concierge loop's catch releases it).
RunFinishes == \E r \in runs : Finish(r)

(* The process dies (kill, OOM, power). runJob promises, the concierge     *)
(* queue and the replay list are memory: gone. Every DB row stays.         *)
\* code: (process death: no code)
Crash ==
    /\ up
    /\ crashes < MaxCrashes
    /\ up' = FALSE
    /\ starting' = FALSE
    /\ crashes' = crashes + 1
    /\ runs' = {}
    /\ replay' = {}
    /\ UNCHANGED <<now, nextRun, runningSince, enabled, lastSlot, triggers, tcount>>

(***************************************************************************)
(* Daemon.start up to its first await:                                     *)
(*   s.scheduler.recover()  -> running_since = NULL for every job          *)
(*   s.scheduler.unfinishedRuns(DAY): clock triggers with status           *)
(*     'received' and created_at > now - maxAge, newest first: the newest  *)
(*     per job is replayed (claimedAt = now, running_since = now), older   *)
(*     ones are marked 'dropped' ("superseded after restart").             *)
(* Flags for mutants: Rewind = recover() also rewinds next_run_at to       *)
(* last_slot (MutOneTrigger), Replay = unfinishedRuns is called (S3 fix),  *)
(* Hold = the replayed run sets running_since.                             *)
(***************************************************************************)
Stuck(j) == {tr \in triggers : tr.job = j /\ tr.status = "received" /\ tr.at > now - MaxAge}
Newest(j) == CHOOSE tr \in Stuck(j) : \A o \in Stuck(j) : o.id <= tr.id

\* code: src/daemon.ts:218-224 start (takeLock, recover, unfinishedRuns) -> src/core/scheduler.ts:223-225 recover, 199-220 unfinishedRuns
RestartWith(Rewind, Replay, Hold) ==
    LET R == IF Replay THEN {j \in Jobs : Stuck(j) # {}} ELSE {} IN
    /\ ~up
    /\ up' = TRUE
    /\ starting' = TRUE
    /\ nextRun' = IF Rewind THEN [j \in Jobs |-> IF runningSince[j] # Null THEN lastSlot[j] ELSE nextRun[j]]
                  ELSE nextRun
    /\ runningSince' = [j \in Jobs |-> IF j \in R /\ Hold THEN now ELSE Null]
    /\ triggers' = {IF tr.job \in R /\ tr \in Stuck(tr.job) /\ tr # Newest(tr.job)
                    THEN [tr EXCEPT !.status = "dropped"] ELSE tr : tr \in triggers}
    /\ replay' = {[job |-> j, tid |-> Newest(j).id, started |-> now] : j \in R}
    /\ UNCHANGED <<now, crashes, enabled, lastSlot, tcount, runs>>

Restart == RestartWith(FALSE, TRUE, TRUE)

(* Daemon.start after `await this.reprocessStuckTriggers()`:               *)
(*   for (const run of unfinished) void this.runJob(run);                  *)
(* then the timers (30 s claimDue) are created.                            *)
\* code: src/daemon.ts:238-252 start (replayed runJob calls, then the timers)
DispatchReplays ==
    /\ up /\ starting
    /\ runs' = runs \cup replay
    /\ replay' = {}
    /\ starting' = FALSE
    /\ UNCHANGED <<now, up, crashes, nextRun, runningSince, enabled, lastSlot, triggers, tcount>>

(* Time passes, also while vigil is down or starting. Unless              *)
(* RunsOutliveLease, a run must finish before it has held its job for      *)
(* longer than LEASE (counted from its claimedAt, also while it waits in   *)
(* the replay list for Daemon.start's awaits to finish).                   *)
\* code: src/core/time.ts Clock.now (systemClock)
Tick ==
    /\ now < MaxT
    \* a replayed run's lease starts at unfinishedRuns (claimedAt = running_since = then)
    /\ RunsOutliveLease \/ \A r \in runs \cup replay : now + 1 <= r.started + LEASE
    /\ now' = now + 1
    /\ UNCHANGED <<up, starting, crashes, nextRun, runningSince, enabled, lastSlot, triggers, tcount, runs, replay>>

Next ==
    \/ Tick
    \/ ClaimDue
    \/ RunFinishes
    \/ Crash
    \/ Restart
    \/ DispatchReplays

Fairness ==
    /\ WF_vars(Tick)
    /\ WF_vars(ClaimDue)
    /\ WF_vars(Restart)
    /\ WF_vars(DispatchReplays)
    /\ \A j \in Jobs : WF_vars(\E r \in runs : r.job = j /\ Finish(r))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
TypeOK ==
    /\ now \in 0..MaxT
    /\ up \in BOOLEAN /\ starting \in BOOLEAN
    /\ nextRun \in [Jobs -> Int]
    /\ runningSince \in [Jobs -> Int]
    /\ enabled \in [Jobs -> BOOLEAN]
    /\ \A tr \in triggers : tr.status \in {"received", "done", "dropped"}

\* A slot never yields two triggers.
OneTriggerPerSlot ==
    \A a, b \in triggers : (a.job = b.job /\ a.slot = b.slot) => a.id = b.id

\* A job never has two runs in flight at once (with runs that end within the lease).
NoOverlap ==
    \A j \in Jobs : Cardinality({r \in runs : r.job = j}) <= 1

\* When runs can outlive the lease, a second run starts only after the older
\* one has held the job for longer than LEASE.
OverlapOnlyAfterLease ==
    \A a, b \in runs :
        (a # b /\ a.job = b.job /\ a.started <= b.started) => a.started + LEASE < b.started

\* Every due slot is either the trigger's own slot or counted in its
\* `coalesced`: the slots of the job's schedule in (slot, created_at] number
\* exactly `coalesced`, and no slot is accounted twice.
DueAfter(j, s, at) ==
    IF Kind[j] = "at" THEN 0 ELSE Cardinality({k \in 1..MaxT : s + k * Period <= at})

Covered(tr) ==
    IF Kind[tr.job] = "at" THEN {tr.slot}
    ELSE {tr.slot + k * Period : k \in 0..MaxT} \cap 0..tr.at

NoLostSlot ==
    /\ \A tr \in triggers : tr.coalesced = DueAfter(tr.job, tr.slot, tr.at)
    /\ \A a, b \in triggers : (a # b /\ a.job = b.job) => Covered(a) \cap Covered(b) = {}

\* An "at" job yields at most one trigger.
AtJobsFireOnce ==
    \A j \in Jobs : Kind[j] = "at" => Cardinality({tr \in triggers : tr.job = j}) <= 1

\* Liveness: every claimed slot's run eventually finishes (trigger 'done').
\* With MaxT bounding time, "eventually always all done" is the same thing.
ClaimedRunCompletes ==
    \A j \in Jobs : <>[](\A tr \in triggers : tr.job = j => tr.status = "done")

\* Liveness: an "at" job whose time is within the bound eventually runs to completion.
AtJobRuns ==
    \A j \in Jobs : (Kind[j] = "at" /\ AtTime <= MaxT) =>
        <>(\E tr \in triggers : tr.job = j /\ tr.status = "done")
=============================================================================
