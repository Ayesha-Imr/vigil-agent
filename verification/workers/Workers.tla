------------------------------ MODULE Workers ------------------------------
(***************************************************************************)
(* vigil's worker pool and ticket inputs, as the code runs them.           *)
(*                                                                         *)
(* Code (coverage record and sync commit:                                  *)
(*   .claude/skills/verify-worker-slots/SKILL.md; every action has a      *)
(*   "\* code: file:line" line at the sync commit):                        *)
(*   src/agent/workers.ts  WorkerPool.pump, run, session, recover          *)
(*   src/core/tickets.ts   Tickets.runnable, addInput, takeInputs, report, *)
(*                         stop, setStage, setSessionFile                  *)
(*   src/daemon.ts         start (workers.recover, then pump), the 15 s    *)
(*                         pump timer, route (addInput then pump), /stop   *)
(*   src/agent/tools.ts    report / ask_owner (worker), ticket_message /   *)
(*                         ticket_stop (concierge)                         *)
(*                                                                         *)
(* Atomicity, as in the code (Node runs one callback at a time; code       *)
(* between two awaits is one step; Db.tx() is atomic anyway):              *)
(*  - pump() is synchronous: one step, including the synchronous start of  *)
(*    every run() it calls (setStage 'working', up to `await session`).    *)
(*  - route()/ticket_message: addInput(...) then pump(): one step.         *)
(*  - run(): `await this.session(t)` and `await promptWithFallback(...)`   *)
(*    are the interleaving points. Everything from one await to the next   *)
(*    (takeInputs, the loop test, the post-loop report) is one step.       *)
(*  - The `.finally(() => { running.delete; pump() })` callback is its own *)
(*    step (a microtask after run() settles).                              *)
(*  - Microtasks run before any macrotask (timer, I/O, model reply). The   *)
(*    model tracks this with Micro: while a run has a microtask pending,   *)
(*    no macrotask step can happen.                                        *)
(*  - A crash kills the process: runs and their sessions vanish; every DB  *)
(*    row stays. Restart = Daemon.start -> WorkerPool.recover().           *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    NT,            \* number of tickets; ticket i was created i-th (tickets.runnable() order)
    MAX,           \* cfg.workers.max
    TURNS,         \* WorkerPool.run turn cap (20 in the code)
    MaxInputs,     \* bound: inputs added by the owner or the concierge
    MaxCrashes,    \* bound: process deaths
    ModelOutage,   \* TRUE: the worker role can lose every model (buildSession throws)
    MaxFlips,      \* bound: model available <-> unavailable changes
    ToolKinds,     \* worker tool calls modelled: subset of {"ready", "blocked", "progress", "ask"}
    Outcomes       \* how a turn can end: subset of {"ok", "error", "timeout"}

TicketOrder == [i \in 1..NT |-> i]
Tickets == 1..NT

(***************************************************************************)
(* Variants. The model of the current code is Base. A mutant or a fix     *)
(* flips one flag; each flag is read at the code point it mirrors.         *)
(***************************************************************************)
Base == [ skipRunning     |-> TRUE,   \* pump: if (this.running.has(t.id)) continue;
          ownerKindsOnly  |-> TRUE,   \* pump: ownerWaiting counts only owner_message/answer
          runnableInputs  |-> TRUE,   \* runnable(): ... || (stage !== 'working' && hasPendingInputs)
          takeAtCap       |-> FALSE,  \* run(): takeInputs happens before the turn-cap test
          checkStopped    |-> TRUE,   \* addInput: if (!t || t.stopped_by_owner) return false;
          recheckAfterSession |-> FALSE, \* FIX W1: run() re-reads the ticket after `await session`
          pumpAfterFailedStart |-> TRUE, \* finally re-pumps also after a failed session start
          fileBeforePrompt |-> FALSE,   \* FIX W3: session_file stored before the first prompt
          reservedSlot    |-> TRUE,   \* pump: limit = ownerWaiting ? max + 1 : max
          reportKeepsOpen |-> FALSE ] \* FIX W2: report ready/dropped keeps a ticket with pending input open

VARIABLES
    status,     \* tickets.status: "open" | "ended"
    stage,      \* tickets.stage
    stopped,    \* tickets.stopped_by_owner
    lastRep,    \* tickets.last_report IS NOT NULL (the code reads only that, and the kind
                \* of a report made since the run started, which the run tracks as `rep`)
    sessFile,   \* tickets.session_file IS NOT NULL
    inputs,     \* ticket_inputs, abstracted: [own |-> t -> some pending owner_message/answer row,
                \*   oth |-> t -> some pending note/recovery row, lost |-> some row was marked
                \*   delivered but never reached a turn that returned or a session that is reopened].
                \* The code only asks whether pending rows exist (COUNT > 0) and takeInputs takes
                \* ALL pending rows of a ticket at once, so "this row is eventually taken" is
                \* the same as "the ticket has no pending row again". `added` bounds the rows.
                \* A run's `taken` says its turn in flight holds rows.
    added,      \* inputs added by owner/concierge so far (bound)
    runs,       \* WorkerPool.running: [tk, k, ph, turn, rep, fresh, owner, taken, failedStart]
    up, crashes, modelOk, flips,
    pumped,     \* the last step ended with a call to pump()
    hist        \* history for StoppedStaysStopped: [addedAfterStop, runAfterStop, turnAfterStop]

vars == <<status, stage, stopped, lastRep, sessFile, inputs, added, runs,
          up, crashes, modelOk, flips, pumped, hist>>

OwnerKinds == {"owner"}            \* 'owner_message' and 'answer'
InputKinds == {"owner", "note"}    \* note: concierge ticket_message from a system origin
Requeue    == {"blocked", "failed", "idle", "answer", "review"}   \* addInput: back to 'queued'

-----------------------------------------------------------------------------
(* Queries, over an explicit state so pump() can read the state that the   *)
(* synchronous code just before it produced.                               *)
\* hasPendingInputs: SELECT COUNT(*) ... WHERE ticket_id = ? AND status = 'pending'
HasPendingIn(t, inp) == inp.own[t] \/ inp.oth[t]

\* SELECT COUNT(*) ... status = 'pending' AND kind IN ('owner_message', 'answer')
OwnerWaitingIn(t, inp) == inp.own[t]

\* Tickets.runnable(): open AND (stage = 'queued' OR (stage != 'working' AND hasPendingInputs))
\* code: src/core/tickets.ts:215-222 hasPendingInputs, runnable
RunnableIn(V, t, sts, sgs, inp) ==
    /\ sts[t] = "open"
    /\ \/ sgs[t] = "queued"
       \/ V.runnableInputs /\ sgs[t] # "working" /\ HasPendingIn(t, inp)

RunsOf(t, rs) == {r \in rs : r.tk = t}

(***************************************************************************)
(* WorkerPool.pump(), the for loop over runnable() in created_at order:    *)
(*   if (running.has(t.id)) continue;                                      *)
(*   limit = ownerWaiting ? max + 1 : max;                                 *)
(*   if (running.size >= limit) continue;                                  *)
(*   start run(t)                                                          *)
(* Returns the set of tickets it starts.                                   *)
(***************************************************************************)
\* code: src/agent/workers.ts:37-47 pump
PumpStarts(V, base, sts, sgs, inp) ==
    LET N == Len(TicketOrder)
        st[i \in 0..N] ==
            IF i = 0 THEN {}
            ELSE LET t     == TicketOrder[i]
                     prev  == st[i - 1]
                     size  == Cardinality(base) + Cardinality(prev)
                     wait  == IF V.ownerKindsOnly THEN OwnerWaitingIn(t, inp) ELSE HasPendingIn(t, inp)
                     limit == IF wait /\ V.reservedSlot THEN MAX + 1 ELSE MAX
                 IN IF /\ RunnableIn(V, t, sts, sgs, inp)
                       /\ ~(V.skipRunning /\ RunsOf(t, base) # {})
                       /\ size < limit
                    THEN prev \cup {t} ELSE prev
    IN st[N]

\* The synchronous start of run(t): startedAt; setStage(t.id, 'working'); then `await session`.
\* code: src/agent/workers.ts:48, 87-89 run() start
NewRun(t, base, inp) ==
    [tk |-> t,
     k |-> Cardinality(RunsOf(t, base)) + 1,   \* tells apart two runs of one ticket (never > 1 in Base)
     ph |-> "starting",
     turn |-> 0,
     rep |-> FALSE,                     \* reported: the last report since startedAt is not 'progress'
     fresh |-> ~lastRep[t],             \* !t.last_report, from the runnable() snapshot
     owner |-> OwnerWaitingIn(t, inp),  \* started with owner input pending
     taken |-> FALSE,
     failedStart |-> FALSE]

\* pump() as the last statement of a step. base = running map, sts/sgs/inp/h =
\* the state the code before it left. Sets runs', stage', pumped', hist'.
\* code: src/agent/workers.ts:37-55 pump
Pump(V, base, sts, sgs, inp, h) ==
    LET S == PumpStarts(V, base, sts, sgs, inp) IN
    /\ runs' = base \cup {NewRun(t, base, inp) : t \in S}
    /\ stage' = [t \in Tickets |-> IF t \in S THEN "working" ELSE sgs[t]]
    /\ pumped' = TRUE
    /\ hist' = [h EXCEPT !.runAfterStop = @ \/ \E t \in S : stopped[t]]

\* A microtask is pending: a run settled (its finally callback is queued), or a
\* run is about to fail its session without I/O (buildSession throws at once
\* because s.models.pick("worker") is undefined). WorkerPool.sessions holds a
\* session only during a run (run() and its finally both dispose it), so a
\* run always builds its session, from tickets.session_file.
Micro == \E r \in runs :
            \/ r.ph = "ending"
            \/ r.ph = "starting" /\ ~modelOk

-----------------------------------------------------------------------------
Init ==
    /\ status = [t \in Tickets |-> "open"]       \* Tickets.create: status 'open', stage 'queued'
    /\ stage = [t \in Tickets |-> "queued"]
    /\ stopped = [t \in Tickets |-> FALSE]
    /\ lastRep = [t \in Tickets |-> FALSE]
    /\ sessFile = [t \in Tickets |-> FALSE]
    /\ inputs = [own |-> [t \in Tickets |-> FALSE], oth |-> [t \in Tickets |-> FALSE], lost |-> FALSE]
    /\ added = 0
    /\ runs = {}
    /\ up = TRUE
    /\ crashes = 0
    /\ modelOk = TRUE
    /\ flips = 0
    /\ pumped = FALSE
    /\ hist = [addedAfterStop |-> FALSE, runAfterStop |-> FALSE, turnAfterStop |-> FALSE]

(* daemon.ts start(): every(15_000, () => this.workers.pump()), and the     *)
(* pump() at the end of start(), wakeWorkers from spawn_ticket, /resume.    *)
\* code: src/daemon.ts:192, 201 (15 s timer, end of start); src/daemon.ts:81 wakeWorkers
TimerPump(V) ==
    /\ up /\ ~Micro
    /\ Pump(V, runs, status, stage, inputs, hist)
    /\ UNCHANGED <<status, stopped, lastRep, sessFile, inputs, added, up, crashes, modelOk, flips>>

(* daemon.ts route(): s.tickets.addInput(ref.id, "owner_message", text) or  *)
(* addInput(at.ticket_id, "answer", ...), then this.workers.pump(); and the *)
(* concierge's ticket_message tool (kind 'note' from a system origin).      *)
(* Tickets.addInput: reject a stopped ticket; insert the row; an ended      *)
(* ticket reopens as queued; blocked/failed/idle/answer/review -> queued.   *)
\* code: src/daemon.ts:455-471, 554-555 route; src/agent/tools.ts:152-162 ticket_message; src/core/tickets.ts:188-204 addInput
OwnerMessage(V, t, kind) ==
    /\ up /\ ~Micro
    /\ added < MaxInputs
    /\ ~(V.checkStopped /\ stopped[t])        \* rejected: no row, no pump (nothing changes)
    /\ LET inp == IF kind \in OwnerKinds THEN [inputs EXCEPT !.own[t] = TRUE]
                  ELSE [inputs EXCEPT !.oth[t] = TRUE]
           sts == IF status[t] = "ended" THEN [status EXCEPT ![t] = "open"] ELSE status
           sgs == IF status[t] = "ended" THEN [stage EXCEPT ![t] = "queued"]
                  ELSE IF stage[t] \in Requeue THEN [stage EXCEPT ![t] = "queued"]
                  ELSE stage
       IN /\ inputs' = inp
          /\ status' = sts
          /\ added' = added + 1
          /\ Pump(V, runs, sts, sgs, inp, [hist EXCEPT !.addedAfterStop = @ \/ stopped[t]])
    /\ UNCHANGED <<stopped, lastRep, sessFile, up, crashes, modelOk, flips>>

(* /stop <id> (daemon.ts handleCommand) and the ticket_stop tool:           *)
(* Tickets.stop: status 'ended', stage 'stopped', stopped_by_owner = 1, its *)
(* pending inputs 'delivered'. It does not touch a run in flight.           *)
\* code: src/daemon.ts:669 /stop; src/agent/tools.ts:163-173 ticket_stop; src/core/tickets.ts:173-185 stop
Stop(t) ==
    /\ up /\ ~Micro
    /\ ~stopped[t]
    /\ status' = [status EXCEPT ![t] = "ended"]
    /\ stage' = [stage EXCEPT ![t] = "stopped"]
    /\ stopped' = [stopped EXCEPT ![t] = TRUE]
    /\ inputs' = [inputs EXCEPT !.own[t] = FALSE, !.oth[t] = FALSE]   \* pending -> 'delivered'
    /\ pumped' = FALSE
    /\ UNCHANGED <<lastRep, sessFile, added, runs, up, crashes, modelOk, flips, hist>>

(***************************************************************************)
(* run(), after the post-loop code: workers.ts                             *)
(*   const now = tickets.get(t.id);                                        *)
(*   reported = last_report since startedAt and kind !== 'progress'        *)
(*   if (ended && stage === 'stopped') { dispose; return }                 *)
(*   if (!reported && stage === 'working') report(t.id, 'waiting', ...)    *)
(*   dispose(t.id)                                                         *)
(* sg/lr: stage and lastRep as the same step left them.                    *)
(***************************************************************************)
\* code: src/agent/workers.ts:124-137; src/core/tickets.ts:151-170 report
PostLoop(r, rs, sg, lr) ==
    LET t == r.tk
        reported == r.rep
        waiting  == ~reported /\ sg[t] = "working" /\ ~(status[t] = "ended" /\ sg[t] = "stopped")
    IN
    /\ stage' = IF waiting THEN [sg EXCEPT ![t] = "idle"] ELSE sg          \* report 'waiting' -> idle
    /\ lastRep' = IF waiting THEN [lr EXCEPT ![t] = TRUE] ELSE lr
    /\ runs' = (rs \ {r}) \cup {[r EXCEPT !.ph = "ending", !.taken = FALSE]}

(***************************************************************************)
(* One pass of run()'s loop from `takeInputs` to the next await:           *)
(*   for (turn; turn < 20; turn++) {                                       *)
(*     const inputs = takeInputs(t.id);                                    *)
(*     const first = turn === 0 && !t.last_report && inputs.length === 0;  *)
(*     if (!first && inputs.length === 0) break;                           *)
(*     await promptWithFallback(...)        <- the step ends here          *)
(*   }  ... post-loop                                                      *)
(* inp/sg/lr: the state the same step left before the loop test.          *)
(***************************************************************************)
\* code: src/agent/workers.ts:98-102, 111; src/core/tickets.ts:207-213 takeInputs
LoopStep(V, r, turn, inp, sg, lr) ==
    LET t      == r.tk
        P      == HasPendingIn(t, inp)
        capped == turn >= TURNS
        first  == turn = 0 /\ r.fresh /\ ~P
    IN
    IF ~capped /\ (first \/ P)
    THEN \* takeInputs marks them delivered; the turn starts
         /\ inputs' = [inp EXCEPT !.own[t] = FALSE, !.oth[t] = FALSE]
         /\ runs' = (runs \ {r}) \cup {[r EXCEPT !.ph = "prompting", !.turn = turn, !.taken = P]}
         /\ stage' = sg /\ lastRep' = lr
         /\ hist' = [hist EXCEPT !.turnAfterStop = @ \/ stopped[t]]
    ELSE \* the loop ends (no input, or the cap)
         /\ inputs' = IF capped /\ V.takeAtCap   \* mutant: taken, then the cap breaks the loop
                      THEN [inp EXCEPT !.own[t] = FALSE, !.oth[t] = FALSE, !.lost = @ \/ P]
                      ELSE inp
         /\ PostLoop(r, runs, sg, lr)
         /\ hist' = hist

(* `session = await this.session(t)` resolves: buildSession succeeds       *)
(* (needs a model for the role; it does I/O, so this is a macrotask).       *)
\* code: src/agent/workers.ts:92 (session 57-85)
SessionStart(V, r) ==
    /\ up /\ ~Micro
    /\ r \in runs /\ r.ph = "starting"
    /\ modelOk
    /\ IF V.recheckAfterSession /\ status[r.tk] = "ended" /\ stopped[r.tk]
       THEN \* FIX W1: re-read the ticket; the owner stopped it while the session was built
            /\ stage' = stage /\ lastRep' = lastRep /\ inputs' = inputs /\ hist' = hist
            /\ runs' = (runs \ {r}) \cup {[r EXCEPT !.ph = "ending"]}
       ELSE LoopStep(V, r, 0, inputs, stage, lastRep)
    /\ sessFile' = IF V.fileBeforePrompt THEN [sessFile EXCEPT ![r.tk] = TRUE] ELSE sessFile
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stopped, added, up, crashes, modelOk, flips>>

(* buildSession throws (no model with credentials for "worker"):           *)
(*   report(t.id, 'failed', 'Could not start a worker: ...'); return;      *)
\* code: src/agent/workers.ts:93-96; src/agent/sessions.ts:68-72 buildSession throws
SessionFail(r) ==
    /\ up
    /\ r \in runs /\ r.ph = "starting"
    /\ ~modelOk
    /\ lastRep' = [lastRep EXCEPT ![r.tk] = TRUE]
    /\ stage' = [stage EXCEPT ![r.tk] = "failed"]
    /\ runs' = (runs \ {r}) \cup {[r EXCEPT !.ph = "ending", !.failedStart = TRUE]}
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stopped, sessFile, inputs, added, up, crashes, modelOk, flips, hist>>

(* The worker calls a tool during its turn (tools.ts workerTools):         *)
(*   report ready|dropped -> stage done, status ended; blocked -> blocked; *)
(*   failed -> failed; progress -> working; ask_owner -> stage 'answer'.   *)
(* Tickets.report does not look at stopped_by_owner.                       *)
\* code: src/agent/tools.ts:287-308 report, 311-333 ask_owner; src/core/tickets.ts:151-170 report, 142-144 setStage
WorkerTool(V, r, kind) ==
    /\ up /\ ~Micro
    /\ r \in runs /\ r.ph = "prompting"
    /\ LET t == r.tk IN
       CASE kind = "ready" /\ V.reportKeepsOpen /\ HasPendingIn(t, inputs) ->
              \* FIX W2: ends = (ready || dropped) && !hasPendingInputs(id): stage 'review', open
              /\ lastRep' = [lastRep EXCEPT ![t] = TRUE]
              /\ stage' = [stage EXCEPT ![t] = "review"]
              /\ status' = status
         [] kind = "ready" ->
              /\ lastRep' = [lastRep EXCEPT ![t] = TRUE]
              /\ stage' = [stage EXCEPT ![t] = "done"]
              /\ status' = [status EXCEPT ![t] = "ended"]
         [] kind = "blocked" ->
              /\ lastRep' = [lastRep EXCEPT ![t] = TRUE]
              /\ stage' = [stage EXCEPT ![t] = "blocked"]
              /\ status' = status
         [] kind = "progress" ->
              /\ lastRep' = [lastRep EXCEPT ![t] = TRUE]
              /\ stage' = [stage EXCEPT ![t] = "working"]
              /\ status' = status
         [] kind = "ask" ->
              /\ lastRep' = lastRep
              /\ stage' = [stage EXCEPT ![t] = "answer"]
              /\ status' = status
    /\ runs' = (runs \ {r}) \cup {[r EXCEPT !.rep = IF kind = "ask" THEN r.rep ELSE kind # "progress"]}
    /\ pumped' = FALSE
    /\ UNCHANGED <<stopped, sessFile, inputs, added, up, crashes, modelOk, flips, hist>>

(* `await promptWithFallback(...)` returns (a macrotask: the model replied,*)
(* or the turn timer aborted it):                                          *)
(*   "timeout": if (timedOut) { report 'failed'; return }  -- BEFORE        *)
(*              setSessionFile, so a first turn leaves session_file NULL    *)
(*   "error":   setSessionFile; if (r.error) { report 'failed'; notify;     *)
(*              return }                                                    *)
(*   "ok":      setSessionFile; (pause is not modelled) next turn           *)
\* code: src/agent/workers.ts:111-122
PromptReturn(V, r, out) ==
    /\ up /\ ~Micro
    /\ r \in runs /\ r.ph = "prompting"
    /\ LET t == r.tk IN
       IF out = "ok"
       THEN /\ sessFile' = [sessFile EXCEPT ![t] = TRUE]
            /\ LoopStep(V, r, r.turn + 1, inputs, stage, lastRep)
       ELSE /\ sessFile' = IF out = "error" THEN [sessFile EXCEPT ![t] = TRUE] ELSE sessFile
            \* After a timeout the next run builds a new session (session_file NULL):
            \* the rows this turn took never reach a session that is reopened.
            /\ inputs' = IF out = "timeout" /\ r.taken /\ ~sessFile[t]
                         THEN [inputs EXCEPT !.lost = TRUE] ELSE inputs
            /\ lastRep' = [lastRep EXCEPT ![t] = TRUE]
            /\ stage' = [stage EXCEPT ![t] = "failed"]
            /\ runs' = (runs \ {r}) \cup {[r EXCEPT !.ph = "ending", !.taken = FALSE]}
            /\ hist' = hist
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stopped, added, up, crashes, modelOk, flips>>

(* run(t).finally(() => { running.delete(t.id); dispose(t.id); pump(); })  *)
\* code: src/agent/workers.ts:48-52
Finally(V, r) ==
    /\ up
    /\ r \in runs /\ r.ph = "ending"
    /\ IF V.pumpAfterFailedStart \/ ~r.failedStart
       THEN Pump(V, runs \ {r}, status, stage, inputs, hist)
       ELSE /\ runs' = runs \ {r} /\ stage' = stage /\ pumped' = FALSE /\ hist' = hist
    /\ UNCHANGED <<status, stopped, lastRep, sessFile, inputs, added, up, crashes, modelOk, flips>>

(* The process dies. A turn in flight is cut: its inputs were marked       *)
(* delivered. The session reopened on restart (tickets.session_file) holds *)
(* them only if session_file was already stored.                           *)
\* code: (process death: no code)
Crash ==
    /\ up
    /\ crashes < MaxCrashes
    /\ up' = FALSE
    /\ crashes' = crashes + 1
    /\ runs' = {}
    \* rows of a turn in flight: kept if the session file is reopened, else lost
    /\ inputs' = [inputs EXCEPT !.lost = @ \/ \E r \in runs : r.taken /\ ~sessFile[r.tk]]
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stage, stopped, lastRep, sessFile, added, modelOk, flips, hist>>

(* Daemon.start -> WorkerPool.recover(): each open ticket at stage         *)
(* 'working' gets addInput('recovery', ...) and setStage('queued'). The    *)
(* pump() at the end of start() comes later (after awaits): TimerPump.     *)
\* code: src/daemon.ts:162-165 start -> src/agent/workers.ts:141-154 recover
Restart ==
    /\ ~up
    /\ up' = TRUE
    /\ LET Wset == {t \in Tickets : status[t] = "open" /\ stage[t] = "working"}
       IN /\ inputs' = [inputs EXCEPT !.oth = [t \in Tickets |-> IF t \in Wset THEN TRUE ELSE @[t]]]
          /\ stage' = [t \in Tickets |-> IF t \in Wset THEN "queued" ELSE stage[t]]
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stopped, lastRep, sessFile, added, runs, crashes, modelOk, flips, hist>>

(* The worker role loses or regains its models (login expires, vigil login).*)
\* code: src/agent/models.ts pick (credentials appear / disappear)
ModelFlip ==
    /\ ModelOutage /\ up /\ ~Micro
    /\ flips < MaxFlips
    /\ modelOk' = ~modelOk
    /\ flips' = flips + 1
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stage, stopped, lastRep, sessFile, inputs, added, runs, up, crashes, hist>>

-----------------------------------------------------------------------------
\* Named steps (TLC and /statechart label a trace step with these names).
OwnerOrConciergeWrites(V) == \E t \in Tickets, k \in InputKinds : OwnerMessage(V, t, k)
OwnerStops                == \E t \in Tickets : Stop(t)
SessionReady(V)           == \E r \in runs : SessionStart(V, r)
SessionThrows             == \E r \in runs : SessionFail(r)
WorkerCallsTool(V)        == \E r \in runs, k \in ToolKinds : WorkerTool(V, r, k)
TurnReturns(V)            == \E r \in runs, out \in Outcomes : PromptReturn(V, r, out)
RunSettles(V)             == \E r \in runs : Finally(V, r)

NextWith(V) ==
    \/ TimerPump(V)
    \/ OwnerOrConciergeWrites(V)
    \/ OwnerStops
    \/ SessionReady(V)
    \/ SessionThrows
    \/ WorkerCallsTool(V)
    \/ TurnReturns(V)
    \/ RunSettles(V)
    \/ Crash
    \/ Restart
    \/ ModelFlip

FairWith(V) ==
    /\ WF_vars(TimerPump(V))
    /\ WF_vars(Restart)
    /\ \A t \in Tickets :
        /\ WF_vars(\E r \in runs : r.tk = t /\ SessionStart(V, r))
        /\ WF_vars(\E r \in runs : r.tk = t /\ SessionFail(r))
        /\ WF_vars(\E r \in runs, out \in Outcomes : r.tk = t /\ PromptReturn(V, r, out))
        /\ WF_vars(\E r \in runs : r.tk = t /\ Finally(V, r))

SpecWith(V) == Init /\ [][NextWith(V)]_vars /\ FairWith(V)

Next == NextWith(Base)
Spec == SpecWith(Base)

\* Every fix of the SKILL's findings at once (fixes/FixAll.cfg).
Fixed == [Base EXCEPT !.recheckAfterSession = TRUE, !.pumpAfterFailedStart = FALSE,
                      !.fileBeforePrompt = TRUE, !.reportKeepsOpen = TRUE]
SpecFixed == SpecWith(Fixed)

\* Each fix alone, against its finding's config.
SpecFixW1 == SpecWith([Base EXCEPT !.recheckAfterSession = TRUE])
SpecFixW2 == SpecWith([Base EXCEPT !.reportKeepsOpen = TRUE])
SpecFixW3 == SpecWith([Base EXCEPT !.fileBeforePrompt = TRUE])
SpecFixW4 == SpecWith([Base EXCEPT !.pumpAfterFailedStart = FALSE])

-----------------------------------------------------------------------------
(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
Running(t) == RunsOf(t, runs) # {}
Runnable(t) == RunnableIn(Base, t, status, stage, inputs)
OwnerWaiting(t) == OwnerWaitingIn(t, inputs)

TypeOK ==
    /\ status \in [Tickets -> {"open", "ended"}]
    /\ stage \in [Tickets -> {"queued", "working", "answer", "review", "blocked", "failed", "idle", "done", "stopped"}]
    /\ inputs.own \in [Tickets -> BOOLEAN] /\ inputs.oth \in [Tickets -> BOOLEAN]
    /\ lastRep \in [Tickets -> BOOLEAN]

\* A ticket never has two runs at once.
NoDoubleRun == \A t \in Tickets : Cardinality(RunsOf(t, runs)) <= 1

\* At most max runs, plus one only for a ticket that had owner input when it started.
SlotLimit ==
    \/ Cardinality(runs) <= MAX
    \/ Cardinality(runs) = MAX + 1 /\ \E r \in runs : r.owner

\* Right after a pump, a ticket with owner input waits only if all max+1 slots are taken.
ReservedSlotWorks ==
    pumped => \A t \in Tickets :
        (Runnable(t) /\ OwnerWaiting(t) /\ ~Running(t)) => Cardinality(runs) >= MAX + 1

\* CHARACTERISATION (expected to fail): right after a pump, every ticket with owner input runs.
SecondOwnerNeverWaits ==
    pumped => \A t \in Tickets : (Runnable(t) /\ OwnerWaiting(t)) => Running(t)

\* A stopped ticket rejects inputs and stays ended.
StoppedRejectsInputs ==
    /\ ~hist.addedAfterStop
    /\ \A t \in Tickets : stopped[t] => status[t] = "ended"

\* A stopped ticket starts no run and no turn after the stop. (A turn already
\* in flight at the stop is not cut: see the SKILL's "not covered".)
StoppedNeverRunsAgain == ~hist.runAfterStop /\ ~hist.turnAfterStop

StoppedStaysStopped == StoppedRejectsInputs /\ StoppedNeverRunsAgain

\* Liveness: owner input never waits for ever (it is taken by a turn, or the
\* owner stops the ticket).
OwnerNeverStarved ==
    \A t \in Tickets : inputs.own[t] ~> ~inputs.own[t]

\* Every input reaches a turn that returns (or the session reopened after a
\* crash), unless the owner stopped the ticket: none is ever lost, and none
\* stays pending for ever.
InputNeverLost == ~inputs.lost

NoInputLost ==
    /\ []InputNeverLost
    /\ \A t \in Tickets : HasPendingIn(t, inputs) ~> ~HasPendingIn(t, inputs)

\* Liveness: the event loop keeps getting back to timers and I/O.
EventLoopProgress == []<>(~Micro)
=============================================================================
