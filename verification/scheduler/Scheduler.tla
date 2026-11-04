----------------------------- MODULE Scheduler -----------------------------
(***************************************************************************)
(* vigil's job scheduler, as the code runs it.                             *)
(*                                                                         *)
(* Code (see .claude/skills/verify-scheduler/SKILL.md for the coverage    *)
(* record; every action has a "\* code: file:line" line at the sync commit) *)
(* record and sync commit):                                                *)
(*   src/core/scheduler.ts  nextRunAt, countSlots, Scheduler.claimDue,     *)
(*                          Scheduler.complete, Scheduler.recover          *)
(*   src/store/db.ts        triggers UNIQUE (source, external_id)          *)
(*   src/daemon.ts          Daemon.start (recover on boot),                *)
(*                          tickGovernorAndClock (claimDue every 30 s),    *)
(*                          runJob / finish (complete + trigger 'done'),   *)
(*                          reprocessStuckTriggers (skips source 'clock')  *)
(*                                                                         *)
(* Atomicity, as in the code:                                              *)
(*  - claimDue is one Db.tx() over every due job: one step (ClaimDue).     *)
(*  - finish() is two synchronous db.run calls with no await between:      *)
(*    one step (Finish).                                                   *)
(*  - runJob's work (concierge turn, heartbeat, dream) awaits: the run     *)
(*    is in flight between ClaimDue and Finish, for any length of time.    *)
(*  - A crash kills the process: in-memory runs vanish, the DB stays.      *)
(*  - Restart = Daemon.start -> Scheduler.recover(). The first claim after *)
(*    restart is an ordinary ClaimDue (the 30 s timer).                    *)
(*                                                                         *)
(* Time is abstract: `now` is Clock.now() in whole "units"; Period and     *)
(* LEASE (RUN_LEASE_MS) are in the same units. A unit is finer than a      *)
(* tick, so a claim can land exactly on a slot.                            *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
    EveryJobs,         \* jobs with kind 'every' (cron behaves the same here, see the SKILL)
    AtJobs,            \* jobs with kind 'at'
    Period,            \* "every" spec, in time units
    AtTime,            \* "at" spec: the instant it names
    LEASE,             \* RUN_LEASE_MS
    MaxT,              \* the clock stops here (bound)
    MaxCrashes,        \* bound on process deaths
    RunsOutliveLease   \* TRUE: a run may still be going after RUN_LEASE_MS

Null == -1             \* SQL NULL for next_run_at / running_since

Jobs == EveryJobs \cup AtJobs                        \* rows of the jobs table
Kind == [j \in Jobs |-> IF j \in EveryJobs THEN "every" ELSE "at"]   \* jobs.kind

VARIABLES
    now,           \* Clock.now()
    up,            \* the daemon process is alive
    crashes,       \* crashes so far (bound)
    nextRun,       \* jobs.next_run_at
    runningSince,  \* jobs.running_since
    enabled,       \* jobs.enabled
    lastSlot,      \* jobs.last_slot
    triggers,      \* rows of triggers with source 'clock': [id, job, slot, coalesced, at, status]
    tcount,        \* AUTOINCREMENT counter of triggers.id
    runs           \* in memory: runJob calls whose finish() has not run: [job, tid, started]

vars == <<now, up, crashes, nextRun, runningSince, enabled, lastSlot, triggers, tcount, runs>>

\* A fixed injective numbering of jobs, to give each new trigger row its own id.
JobIdx == CHOOSE f \in [Jobs -> 1..Cardinality(Jobs)] : \A a, b \in Jobs : f[a] = f[b] => a = b

(***************************************************************************)
(* nextRunAt(kind, spec, after)   src/core/scheduler.ts nextRunAt          *)
(***************************************************************************)
\* code: src/core/scheduler.ts:50-67 nextRunAt
NextRunAt(j, after) ==
    IF Kind[j] = "every" THEN after + Period              \* case "every": after + minutes * MINUTE
    ELSE IF AtTime > after THEN AtTime ELSE Null          \* case "at": t > after ? t : null

(***************************************************************************)
(* countSlots(kind, spec, from, to)   src/core/scheduler.ts countSlots     *)
(* The while loop, step for step (the 1000 cap is never reached here).     *)
(***************************************************************************)
\* code: src/core/scheduler.ts:69-81 countSlots
RECURSIVE CountLoop(_, _, _, _)
CountLoop(j, t, to, n) ==
    LET next == NextRunAt(j, t) IN
    IF next = Null \/ next >= to THEN n              \* if (next === null || next >= to) break;
    ELSE CountLoop(j, next, to, n + 1)               \* n++; t = next;

CountSlots(j, from, to) == IF Kind[j] = "at" THEN 0 ELSE CountLoop(j, from, to, 0)

-----------------------------------------------------------------------------
Init ==
    /\ now = 0
    /\ up = TRUE
    /\ crashes = 0
    \* Scheduler.create: next_run_at = nextRunAt(kind, spec, now), enabled = 1
    /\ nextRun = [j \in Jobs |-> NextRunAt(j, 0)]
    /\ runningSince = [j \in Jobs |-> Null]
    /\ enabled = [j \in Jobs |-> TRUE]
    /\ lastSlot = [j \in Jobs |-> Null]
    /\ triggers = {}
    /\ tcount = 0
    /\ runs = {}

(***************************************************************************)
(* The due query of claimDue:                                              *)
(*   enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= now        *)
(*   AND (running_since IS NULL OR running_since < now - RUN_LEASE_MS)     *)
(***************************************************************************)
\* code: src/core/scheduler.ts:143-148 claimDue due query
Due(j) ==
    /\ enabled[j]
    /\ nextRun[j] # Null
    /\ nextRun[j] <= now
    /\ runningSince[j] = Null \/ runningSince[j] < now - LEASE

\* INSERT ... ON CONFLICT(source, external_id) DO NOTHING with external_id `${job.id}:${slot}`:
\* ins.changes === 1 iff no trigger row has that key yet (db.ts triggers UNIQUE (source, external_id)).
\* code: src/core/scheduler.ts:154-161 INSERT ... ON CONFLICT DO NOTHING, fresh; src/store/db.ts:23 UNIQUE
Fresh(j) == ~\E tr \in triggers : tr.job = j /\ tr.slot = nextRun[j]

(***************************************************************************)
(* Scheduler.claimDue (one Db.tx) followed by `void this.runJob(run)` for  *)
(* every fresh run (daemon.ts tickGovernorAndClock). Parameterised so a    *)
(* mutant can swap one piece: DueOp = the due query, FreshOp = the unique  *)
(* key, CountOp = countSlots, NextOp = nextRunAt.                          *)
(***************************************************************************)
\* code: src/core/scheduler.ts:139-179 claimDue; src/daemon.ts:233 tickGovernorAndClock (void this.runJob)
ClaimDueWith(DueOp(_), FreshOp(_), CountOp(_, _, _), NextOp(_, _)) ==
    LET D   == {j \in Jobs : DueOp(j)}
        New == {j \in D : FreshOp(j)}
    IN
    /\ up
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
    \* if (fresh) runs.push(...); then daemon: void this.runJob(run)
    /\ runs' = runs \cup {[job |-> j, tid |-> tcount + JobIdx[j], started |-> now] : j \in New}
    /\ UNCHANGED <<now, up, crashes>>

ClaimDue == ClaimDueWith(Due, Fresh, CountSlots, NextRunAt)

(***************************************************************************)
(* runJob's finish(status) (daemon.ts):                                    *)
(*   s.scheduler.complete(job.id, status)                                  *)
(*     -> UPDATE jobs SET running_since = NULL ... WHERE id = ?            *)
(*   UPDATE triggers SET status = 'done' ... WHERE id = run.triggerId      *)
(* complete() frees the job by id only: it does not check that the job is  *)
(* still held by this run. Release is a parameter for the fix variant.     *)
(***************************************************************************)
\* code: src/daemon.ts:261-264 runJob finish; src/core/scheduler.ts:182-189 complete
FinishWith(r, Release(_)) ==
    /\ up
    /\ r \in runs
    /\ runningSince' = Release(r)
    /\ triggers' = {IF tr.id = r.tid THEN [tr EXCEPT !.status = "done"] ELSE tr : tr \in triggers}
    /\ runs' = runs \ {r}
    /\ UNCHANGED <<now, up, crashes, nextRun, enabled, lastSlot, tcount>>

ReleaseById(r) == [runningSince EXCEPT ![r.job] = Null]

Finish(r) == FinishWith(r, ReleaseById)

(* The process dies (kill, OOM, power). runJob promises and the concierge  *)
(* queue are memory: gone. Every DB row stays as committed.                *)
\* code: (process death: no code)
Crash ==
    /\ up
    /\ crashes < MaxCrashes
    /\ up' = FALSE
    /\ crashes' = crashes + 1
    /\ runs' = {}
    /\ UNCHANGED <<now, nextRun, runningSince, enabled, lastSlot, triggers, tcount>>

(* Daemon.start: s.scheduler.recover() -> UPDATE jobs SET running_since =  *)
(* NULL WHERE running_since IS NOT NULL. reprocessStuckTriggers skips      *)
(* source 'clock', so a 'received' clock trigger is never run again.       *)
\* code: src/daemon.ts:162-164 start -> src/core/scheduler.ts:192-194 recover; src/daemon.ts:740-755 reprocessStuckTriggers skips clock
Restart ==
    /\ ~up
    /\ up' = TRUE
    /\ runningSince' = [j \in Jobs |-> Null]
    /\ UNCHANGED <<now, crashes, nextRun, enabled, lastSlot, triggers, tcount, runs>>

(* Time passes, also while vigil is down. Unless RunsOutliveLease, a run   *)
(* must finish before it has held its job for longer than LEASE.           *)
\* code: src/core/time.ts Clock.now (systemClock)
Tick ==
    /\ now < MaxT
    /\ RunsOutliveLease \/ \A r \in runs : now + 1 <= r.started + LEASE
    /\ now' = now + 1
    /\ UNCHANGED <<up, crashes, nextRun, runningSince, enabled, lastSlot, triggers, tcount, runs>>

\* Some in-flight run reaches finish() (its concierge turn / heartbeat / dream returned).
RunFinishes == \E r \in runs : Finish(r)

Next ==
    \/ Tick
    \/ ClaimDue
    \/ RunFinishes
    \/ Crash
    \/ Restart

Fairness ==
    /\ WF_vars(Tick)
    /\ WF_vars(ClaimDue)
    /\ WF_vars(Restart)
    /\ \A j \in Jobs : WF_vars(\E r \in runs : r.job = j /\ Finish(r))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
TypeOK ==
    /\ now \in 0..MaxT
    /\ up \in BOOLEAN
    /\ nextRun \in [Jobs -> Int]
    /\ runningSince \in [Jobs -> Int]
    /\ enabled \in [Jobs -> BOOLEAN]
    /\ \A tr \in triggers : tr.status \in {"received", "done"}

\* A slot never yields two triggers.
OneTriggerPerSlot ==
    \A a, b \in triggers : (a.job = b.job /\ a.slot = b.slot) => a.id = b.id

\* A job never has two runs in flight at once.
NoOverlap ==
    \A j \in Jobs : Cardinality({r \in runs : r.job = j}) <= 1

\* What the lease promises when runs can outlive it: a second run of a job
\* starts only after the older one has held the job for longer than LEASE.
OverlapOnlyAfterLease ==
    \A a, b \in runs :
        (a # b /\ a.job = b.job /\ a.started <= b.started) => a.started + LEASE < b.started

\* Every due slot is either the trigger's own slot or counted in its
\* `coalesced`: the slots of the job's schedule in (slot, created_at] number
\* exactly `coalesced`. (After the claim next_run_at > now, so no due slot is
\* left behind; this checks that the ones folded in are all counted.)
DueAfter(j, s, at) ==
    IF Kind[j] = "at" THEN 0 ELSE Cardinality({k \in 1..MaxT : s + k * Period <= at})

\* The slots of the job's schedule that trigger tr stands for: its own slot
\* and every later slot of the chain slot, slot+Period, ... that was due
\* (<= created_at) when it was claimed.
Covered(tr) ==
    IF Kind[tr.job] = "at" THEN {tr.slot}
    ELSE {tr.slot + k * Period : k \in 0..MaxT} \cap 0..tr.at

NoLostSlot ==
    /\ \A tr \in triggers : tr.coalesced = DueAfter(tr.job, tr.slot, tr.at)
    \* ... and no slot is accounted twice (triggered and also folded in elsewhere)
    /\ \A a, b \in triggers : (a # b /\ a.job = b.job) => Covered(a) \cap Covered(b) = {}

\* An "at" job yields at most one trigger (one run).
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
