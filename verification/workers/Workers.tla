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
(*  - pump()'s continuation `.then((started) => { running.delete; dispose; *)
(*    if (started) pump() })` is its own step (a microtask after run()     *)
(*    settles). run() resolves false after a failed start or a cut turn.   *)
(*  - Microtasks run before any macrotask (timer, I/O, model reply). The   *)
(*    model tracks this with Micro: while a run has a microtask pending,   *)
(*    no macrotask step can happen.                                        *)
(*  - A crash kills the process: runs, their sessions and the failedStart  *)
(*    and cutTurns maps vanish; every DB row stays. Restart =              *)
(*    Daemon.start -> WorkerPool.recover().                                *)
(*  - The 60 s of failedStart is a macrotask step of its own (MinutePasses).*)
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
          reservedSlot    |-> TRUE,   \* pump: limit = ownerWaiting ? max + 1 : max
          recheckAfterSession |-> TRUE,  \* W1 fix: run() re-reads the ticket after `await session`
          reportKeepsOpen |-> TRUE,   \* W2 fix: report ready/dropped does not end a ticket with pending input
          readd           |-> TRUE,   \* W3 fix: a cut turn whose session file never reached disk re-adds its inputs
          readdCap        |-> TRUE,   \* ... only while cutTurns <= 2 (4e2683a)
          pumpAfterFailedStart |-> FALSE, \* W4 fix: no re-pump after a failed start or a cut turn
          cooldown        |-> TRUE,   \* W4 fix: pump skips a ticket whose failedStart is < 60 s old
          fileBeforePrompt |-> FALSE ] \* SUGGESTED fix for W3c: session_file stored before the first prompt

VARIABLES
    status,     \* tickets.status: "open" | "ended"
    stage,      \* tickets.stage
    stopped,    \* tickets.stopped_by_owner
    lastRep,    \* tickets.last_report IS NOT NULL (the code reads only that, and the kind
                \* of a report made since the run started, which the run tracks as `rep`)
    sessFile,   \* tickets.session_file IS NOT NULL
    inputs,     \* ticket_inputs, abstracted: [own |-> t -> some pending owner_message/answer row,
                \*   oth |-> t -> some pending note/recovery row, and how a row marked delivered
                \*   failed to reach a turn that returned or a session file that is reopened:
                \*   lost |-> silently (a crash; nobody is told), dropNotified |-> after the
                \*   owner was told the turn failed (the 3rd cut turn in a row), droppedEarly
                \*   |-> before two re-queues (never, in the current code)].
                \* The code only asks whether pending rows exist (COUNT > 0) and takeInputs takes
                \* ALL pending rows of a ticket at once, so "this row is eventually taken" is
                \* the same as "the ticket has no pending row again". `added` bounds the rows.
                \* A run's tOwn/tOth say which kinds of rows its turn in flight holds.
    added,      \* inputs added by owner/concierge so far (bound)
    runs,       \* WorkerPool.running: [tk, k, ph, turn, rep, fresh, owner, tOwn, tOth, onDisk, noPump]
    cooling,    \* WorkerPool.failedStart has the ticket and it is < 60 s old (memory)
    cut,        \* WorkerPool.cutTurns: consecutive cut turns, 0..3 (memory)
    up, crashes, modelOk, flips,
    pumped,     \* the last step ended with a call to pump()
    hist        \* history: [addedAfterStop, runAfterStop, turnAfterStop] for StoppedStaysStopped,
                \* readds (t -> re-queues since the last clean turn, 0..3), startedCooling

vars == <<status, stage, stopped, lastRep, sessFile, inputs, added, runs, cooling, cut,
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
\* code: src/core/tickets.ts:229-236 hasPendingInputs, runnable
RunnableIn(V, t, sts, sgs, inp) ==
    /\ sts[t] = "open"
    /\ \/ sgs[t] = "queued"
       \/ V.runnableInputs /\ sgs[t] # "working" /\ HasPendingIn(t, inp)

RunsOf(t, rs) == {r \in rs : r.tk = t}

(***************************************************************************)
(* WorkerPool.pump(), the for loop over runnable() in created_at order:    *)
(*   if (running.has(t.id)) continue;                                      *)
(*   if (failedStart.get(t.id) > now - 60_000) continue;                   *)
(*   limit = ownerWaiting ? max + 1 : max;                                 *)
(*   if (running.size >= limit) continue;                                  *)
(*   start run(t)                                                          *)
(* Returns the set of tickets it starts.                                   *)
(***************************************************************************)
\* code: src/agent/workers.ts:43-54 pump
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
                       /\ ~(V.cooldown /\ cooling[t])
                       /\ size < limit
                    THEN prev \cup {t} ELSE prev
    IN st[N]

\* The synchronous start of run(t): startedAt; setStage(t.id, 'working'); then `await session`.
\* code: src/agent/workers.ts:55, 115-117 run() start
NewRun(t, base, inp) ==
    [tk |-> t,
     k |-> Cardinality(RunsOf(t, base)) + 1,   \* tells apart two runs of one ticket (never > 1 in Base)
     ph |-> "starting",
     turn |-> 0,
     rep |-> FALSE,                     \* reported: the last report since startedAt is not 'progress'
     fresh |-> ~lastRep[t],             \* !t.last_report, from the runnable() snapshot
     owner |-> OwnerWaitingIn(t, inp),  \* started with owner input pending
     tOwn |-> FALSE, tOth |-> FALSE,    \* kinds of the rows the turn in flight took
     onDisk |-> FALSE,                  \* pi has written this run's session file
     noPump |-> FALSE]                  \* run() resolved false: its continuation does not pump

\* pump() as the last statement of a step. base = running map, sts/sgs/inp/h =
\* the state the code before it left. Sets runs', stage', pumped', hist'.
\* code: src/agent/workers.ts:43-74 pump
Pump(V, base, sts, sgs, inp, h) ==
    LET S == PumpStarts(V, base, sts, sgs, inp) IN
    /\ runs' = base \cup {NewRun(t, base, inp) : t \in S}
    /\ stage' = [t \in Tickets |-> IF t \in S THEN "working" ELSE sgs[t]]
    /\ pumped' = TRUE
    /\ hist' = [h EXCEPT !.runAfterStop = @ \/ \E t \in S : stopped[t],
                         !.startedCooling = @ \/ \E t \in S : cooling[t]]

\* A microtask is pending: a run settled (its continuation is queued), or a
\* run is about to fail its session without I/O (buildSession throws at once
\* because s.models.pick("worker") is undefined). WorkerPool.sessions holds a
\* session only during a run (pump's continuation disposes it), so a
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
    /\ inputs = [own |-> [t \in Tickets |-> FALSE], oth |-> [t \in Tickets |-> FALSE],
                 lost |-> FALSE, dropNotified |-> FALSE, droppedEarly |-> FALSE]
    /\ cooling = [t \in Tickets |-> FALSE]
    /\ cut = [t \in Tickets |-> 0]
    /\ added = 0
    /\ runs = {}
    /\ up = TRUE
    /\ crashes = 0
    /\ modelOk = TRUE
    /\ flips = 0
    /\ pumped = FALSE
    /\ hist = [addedAfterStop |-> FALSE, runAfterStop |-> FALSE, turnAfterStop |-> FALSE,
               readds |-> [t \in Tickets |-> 0], startedCooling |-> FALSE]

(* daemon.ts start(): every(15_000, () => this.workers.pump()), and the     *)
(* pump() at the end of start(), wakeWorkers from spawn_ticket, /resume.    *)
\* code: src/daemon.ts:254, 263 (15 s timer, end of start); src/daemon.ts:104 wakeWorkers
TimerPump(V) ==
    /\ up /\ ~Micro
    /\ Pump(V, runs, status, stage, inputs, hist)
    /\ UNCHANGED <<status, stopped, lastRep, sessFile, inputs, added, cooling, cut, up, crashes, modelOk, flips>>

(* daemon.ts route(): s.tickets.addInput(ref.id, "owner_message", text) or  *)
(* addInput(at.ticket_id, "answer", ...), then this.workers.pump(); and the *)
(* concierge's ticket_message tool (kind 'note' from a system origin).      *)
(* Tickets.addInput: reject a stopped ticket; insert the row; an ended      *)
(* ticket reopens as queued; blocked/failed/idle/answer/review -> queued.   *)
\* code: src/daemon.ts:528-544, 638-639 route/answer button; src/agent/tools.ts:154-165 ticket_message; src/core/tickets.ts:202-218 addInput
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
    /\ UNCHANGED <<stopped, lastRep, sessFile, cooling, cut, up, crashes, modelOk, flips>>

(* /stop <id> (daemon.ts handleCommand) and the ticket_stop tool:           *)
(* Tickets.stop: status 'ended', stage 'stopped', stopped_by_owner = 1, its *)
(* pending inputs 'delivered'. It does not touch a run in flight.           *)
\* code: src/daemon.ts:785 /stop; src/agent/tools.ts:165-175 ticket_stop; src/core/tickets.ts:187-199 stop
Stop(t) ==
    /\ up /\ ~Micro
    /\ ~stopped[t]
    /\ status' = [status EXCEPT ![t] = "ended"]
    /\ stage' = [stage EXCEPT ![t] = "stopped"]
    /\ stopped' = [stopped EXCEPT ![t] = TRUE]
    /\ inputs' = [inputs EXCEPT !.own[t] = FALSE, !.oth[t] = FALSE]   \* pending -> 'delivered'
    /\ pumped' = FALSE
    /\ UNCHANGED <<lastRep, sessFile, added, runs, cooling, cut, up, crashes, modelOk, flips, hist>>

(***************************************************************************)
(* run(), after the post-loop code: workers.ts                             *)
(*   const now = tickets.get(t.id);                                        *)
(*   reported = last_report since startedAt and kind !== 'progress'        *)
(*   if (ended && stage === 'stopped') return true;                        *)
(*   if (!reported && stage === 'working') report(t.id, 'waiting', ...)    *)
(*   return true      (pump's continuation disposes the session)           *)
(* sg/lr: stage and lastRep as the same step left them.                    *)
(***************************************************************************)
\* code: src/agent/workers.ts:166-176; src/core/tickets.ts:164-184 report
PostLoop(r, rs, sg, lr) ==   \* rs: the running set without this run's old record
    LET t == r.tk
        reported == r.rep
        waiting  == ~reported /\ sg[t] = "working" /\ ~(status[t] = "ended" /\ sg[t] = "stopped")
    IN
    /\ stage' = IF waiting THEN [sg EXCEPT ![t] = "idle"] ELSE sg          \* report 'waiting' -> idle
    /\ lastRep' = IF waiting THEN [lr EXCEPT ![t] = TRUE] ELSE lr
    /\ runs' = rs \cup {[r EXCEPT !.ph = "ending", !.tOwn = FALSE, !.tOth = FALSE]}

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
\* code: src/agent/workers.ts:131-135, 144; src/core/tickets.ts:221-227 takeInputs
LoopStep(V, r, turn, inp, sg, lr, rs, h) ==   \* rs: the running set without this run's old record
    LET t      == r.tk
        P      == HasPendingIn(t, inp)
        capped == turn >= TURNS
        first  == turn = 0 /\ r.fresh /\ ~P
    IN
    IF ~capped /\ (first \/ P)
    THEN \* takeInputs marks them delivered; the turn starts
         /\ inputs' = [inp EXCEPT !.own[t] = FALSE, !.oth[t] = FALSE]
         /\ runs' = rs \cup {[r EXCEPT !.ph = "prompting", !.turn = turn,
                                                !.tOwn = inp.own[t], !.tOth = inp.oth[t]]}
         /\ stage' = sg /\ lastRep' = lr
         /\ hist' = [h EXCEPT !.turnAfterStop = @ \/ stopped[t]]
    ELSE \* the loop ends (no input, or the cap)
         /\ inputs' = IF capped /\ V.takeAtCap   \* mutant: taken, then the cap breaks the loop
                      THEN [inp EXCEPT !.own[t] = FALSE, !.oth[t] = FALSE, !.droppedEarly = @ \/ P]
                      ELSE inp
         /\ PostLoop(r, rs, sg, lr)
         /\ hist' = h

(* `session = await this.session(t)` resolves: buildSession succeeds       *)
(* (needs a model for the role; it does I/O, so this is a macrotask).       *)
(*   failedStart.delete(t.id);                                             *)
(*   const t = tickets.get(t0.id);                                         *)
(*   if (!t || t.stopped_by_owner || t.status === "ended") return true;    *)
(* and the loop then computes `first` from that fresh row.                 *)
\* code: src/agent/workers.ts:125-130 (session 76-112)
SessionStart(V, r) ==
    /\ up /\ ~Micro
    /\ r \in runs /\ r.ph = "starting"
    /\ modelOk
    /\ LET t  == r.tk
           r1 == [r EXCEPT !.fresh = IF V.recheckAfterSession THEN ~lastRep[t] ELSE r.fresh,
                           !.onDisk = sessFile[t] \/ V.fileBeforePrompt]
       IN IF V.recheckAfterSession /\ (stopped[t] \/ status[t] = "ended")
          THEN /\ stage' = stage /\ lastRep' = lastRep /\ inputs' = inputs /\ hist' = hist
               /\ runs' = (runs \ {r}) \cup {[r1 EXCEPT !.ph = "ending"]}
          ELSE LoopStep(V, r1, 0, inputs, stage, lastRep, runs \ {r}, hist)
    /\ cooling' = [cooling EXCEPT ![r.tk] = FALSE]
    /\ sessFile' = IF V.fileBeforePrompt THEN [sessFile EXCEPT ![r.tk] = TRUE] ELSE sessFile
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stopped, added, cut, up, crashes, modelOk, flips>>

(* buildSession throws (no model with credentials for "worker"):           *)
(*   failedStart.set(t0.id, now); report(t0.id, 'failed', ...);            *)
(*   return false;          -> pump's continuation does not re-pump        *)
\* code: src/agent/workers.ts:118-124; src/agent/sessions.ts:73 buildSession throws
SessionFail(V, r) ==
    /\ up
    /\ r \in runs /\ r.ph = "starting"
    /\ ~modelOk
    /\ lastRep' = [lastRep EXCEPT ![r.tk] = TRUE]
    /\ stage' = [stage EXCEPT ![r.tk] = "failed"]
    /\ cooling' = [cooling EXCEPT ![r.tk] = TRUE]
    /\ runs' = (runs \ {r}) \cup {[r EXCEPT !.ph = "ending", !.noPump = ~V.pumpAfterFailedStart]}
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stopped, sessFile, inputs, added, cut, up, crashes, modelOk, flips, hist>>

(* The worker calls a tool during its turn (tools.ts workerTools):         *)
(*   report ready|dropped -> stage done, status ended; blocked -> blocked; *)
(*   failed -> failed; progress -> working; ask_owner -> stage 'answer'.   *)
(* Tickets.report does not look at stopped_by_owner.                       *)
\* code: src/agent/tools.ts:290-314 report, 314-340 ask_owner; src/core/tickets.ts:164-184 report, 155-157 setStage
WorkerTool(V, r, kind) ==
    /\ up /\ ~Micro
    /\ r \in runs /\ r.ph = "prompting"
    /\ LET t == r.tk IN
       CASE kind = "ready" /\ V.reportKeepsOpen /\ HasPendingIn(t, inputs) ->
              \* W2: ends = (ready || dropped) && !hasPendingInputs(id): stage 'review', open
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
    /\ UNCHANGED <<stopped, sessFile, inputs, added, cooling, cut, up, crashes, modelOk, flips, hist>>

(***************************************************************************)
(* `await promptWithFallback(...)` returns (a macrotask: the model replied,*)
(* or the turn timer aborted it):                                          *)
(*   persisted = session.sessionFile && existsSync(session.sessionFile)    *)
(*   if (persisted) setSessionFile(...)                                    *)
(*   "ok":  cutTurns.delete(t.id); (pause is not modelled) next turn       *)
(*   "error" | "timeout" (a cut turn):                                     *)
(*     fails = cutTurns + 1;                                               *)
(*     if (!persisted && fails <= 2) for (i of inputs) addInput(...)       *)
(*     failedStart.set(t.id, now); report 'failed' (+ notify on error);    *)
(*     return false     -> no re-pump; the 15 s timer retries after 60 s   *)
(* pi writes the session file when the prompt's user message is appended:  *)
(* a prompt that fails before that (no API key, auth check failed) leaves  *)
(* no file, so `persisted` of a cut turn is either value (`d`).            *)
(***************************************************************************)
\* code: src/agent/workers.ts:144-164; src/core/tickets.ts:202-218 addInput
PromptReturn(V, r, out) ==
    /\ up /\ ~Micro
    /\ r \in runs /\ r.ph = "prompting"
    /\ LET t == r.tk IN
       IF out = "ok"
       THEN /\ sessFile' = [sessFile EXCEPT ![t] = TRUE]
            /\ cut' = [cut EXCEPT ![t] = 0]
            /\ cooling' = cooling
            /\ status' = status
            \* a clean turn: cutTurns.delete(t.id)
            /\ LoopStep(V, [r EXCEPT !.onDisk = TRUE], r.turn + 1, inputs, stage, lastRep, runs \ {r},
                        [hist EXCEPT !.readds[t] = 0])
       ELSE \E d \in BOOLEAN :
            LET persisted == r.onDisk \/ d
                fails     == IF cut[t] < 3 THEN cut[t] + 1 ELSE 3
                took      == r.tOwn \/ r.tOth
                readd     == V.readd /\ ~persisted /\ took /\ (fails <= 2 \/ ~V.readdCap)
                accepted  == readd /\ ~(V.checkStopped /\ stopped[t])
                \* addInput for each taken row: an ended ticket reopens (its stage is then
                \* overwritten by report('failed'))
                sts1 == IF accepted /\ status[t] = "ended" THEN [status EXCEPT ![t] = "open"] ELSE status
                dropped == ~persisted /\ took /\ ~readd /\ ~stopped[t]
            IN
            /\ sessFile' = IF persisted THEN [sessFile EXCEPT ![t] = TRUE] ELSE sessFile
            /\ cut' = [cut EXCEPT ![t] = fails]
            /\ cooling' = [cooling EXCEPT ![t] = TRUE]
            /\ status' = sts1
            /\ inputs' = [inputs EXCEPT !.own[t] = @ \/ (accepted /\ r.tOwn),
                                         !.oth[t] = @ \/ (accepted /\ r.tOth),
                                         !.dropNotified = @ \/ (dropped /\ fails > 2),
                                         !.droppedEarly = @ \/ (dropped /\ fails <= 2)]
            /\ lastRep' = [lastRep EXCEPT ![t] = TRUE]
            /\ stage' = [stage EXCEPT ![t] = "failed"]      \* report 'failed' comes after addInput
            /\ runs' = (runs \ {r}) \cup {[r EXCEPT !.ph = "ending", !.tOwn = FALSE, !.tOth = FALSE,
                                                     !.noPump = ~V.pumpAfterFailedStart]}
            /\ hist' = [hist EXCEPT !.readds[t] = IF readd /\ @ < 3 THEN @ + 1 ELSE @]
    /\ pumped' = FALSE
    /\ UNCHANGED <<stopped, added, up, crashes, modelOk, flips>>

(* pump()'s continuation of run(t):                                      *)
(*   .then((started) => { running.delete(t.id); dispose(t.id);             *)
(*                        if (started) this.pump(); })                     *)
\* code: src/agent/workers.ts:55-71
Finally(V, r) ==
    /\ up
    /\ r \in runs /\ r.ph = "ending"
    /\ IF ~r.noPump
       THEN Pump(V, runs \ {r}, status, stage, inputs, hist)
       ELSE /\ runs' = runs \ {r} /\ stage' = stage /\ pumped' = FALSE /\ hist' = hist
    /\ UNCHANGED <<status, stopped, lastRep, sessFile, inputs, added, cooling, cut, up, crashes, modelOk, flips>>

(* 60 s pass: failedStart no longer makes pump skip the ticket.            *)
\* code: src/agent/workers.ts:48 (failedStart > now - 60_000)
MinutePasses(t) ==
    /\ up /\ ~Micro
    /\ cooling[t]
    /\ cooling' = [cooling EXCEPT ![t] = FALSE]
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stage, stopped, lastRep, sessFile, inputs, added, runs, cut, up, crashes, modelOk, flips, hist>>

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
    /\ cooling' = [t \in Tickets |-> FALSE]     \* failedStart and cutTurns are memory
    /\ cut' = [t \in Tickets |-> 0]
    /\ hist' = [hist EXCEPT !.readds = [t \in Tickets |-> 0]]   \* the re-queue count is per process
    \* rows of a turn in flight: kept if tickets.session_file reopens the session, else lost,
    \* and nobody is told (the recovery note goes to the worker)
    /\ inputs' = [inputs EXCEPT !.lost = @ \/ \E r \in runs : (r.tOwn \/ r.tOth) /\ ~sessFile[r.tk]]
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stage, stopped, lastRep, sessFile, added, modelOk, flips>>

(* Daemon.start -> WorkerPool.recover(): each open ticket at stage         *)
(* 'working' gets addInput('recovery', ...) and setStage('queued'). The    *)
(* pump() at the end of start() comes later (after awaits): TimerPump.     *)
\* code: src/daemon.ts:218-225 start -> src/agent/workers.ts:180-193 recover
Restart ==
    /\ ~up
    /\ up' = TRUE
    /\ LET Wset == {t \in Tickets : status[t] = "open" /\ stage[t] = "working"}
       IN /\ inputs' = [inputs EXCEPT !.oth = [t \in Tickets |-> IF t \in Wset THEN TRUE ELSE @[t]]]
          /\ stage' = [t \in Tickets |-> IF t \in Wset THEN "queued" ELSE stage[t]]
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stopped, lastRep, sessFile, added, runs, cooling, cut, crashes, modelOk, flips, hist>>

(* The worker role loses or regains its models (login expires, vigil login).*)
\* code: src/agent/models.ts pick (credentials appear / disappear)
ModelFlip ==
    /\ ModelOutage /\ up /\ ~Micro
    /\ flips < MaxFlips
    /\ modelOk' = ~modelOk
    /\ flips' = flips + 1
    /\ pumped' = FALSE
    /\ UNCHANGED <<status, stage, stopped, lastRep, sessFile, inputs, added, runs, cooling, cut, up, crashes, hist>>

-----------------------------------------------------------------------------
\* Named steps (TLC and /statechart label a trace step with these names).
OwnerOrConciergeWrites(V) == \E t \in Tickets, k \in InputKinds : OwnerMessage(V, t, k)
OwnerStops                == \E t \in Tickets : Stop(t)
SessionReady(V)           == \E r \in runs : SessionStart(V, r)
SessionThrows(V)          == \E r \in runs : SessionFail(V, r)
AMinutePasses             == \E t \in Tickets : MinutePasses(t)
WorkerCallsTool(V)        == \E r \in runs, k \in ToolKinds : WorkerTool(V, r, k)
TurnReturns(V)            == \E r \in runs, out \in Outcomes : PromptReturn(V, r, out)
RunSettles(V)             == \E r \in runs : Finally(V, r)

NextWith(V) ==
    \/ TimerPump(V)
    \/ OwnerOrConciergeWrites(V)
    \/ OwnerStops
    \/ SessionReady(V)
    \/ SessionThrows(V)
    \/ AMinutePasses
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
        /\ WF_vars(\E r \in runs : r.tk = t /\ SessionFail(V, r))
        /\ WF_vars(MinutePasses(t))
        /\ WF_vars(\E r \in runs, out \in Outcomes : r.tk = t /\ PromptReturn(V, r, out))
        /\ WF_vars(\E r \in runs : r.tk = t /\ Finally(V, r))

SpecWith(V) == Init /\ [][NextWith(V)]_vars /\ FairWith(V)

Next == NextWith(Base)
Spec == SpecWith(Base)

\* The suggested fix for the open finding W3c (fixes/FixW3c.cfg).
Fixed == [Base EXCEPT !.fileBeforePrompt = TRUE]
SpecFixed == SpecWith(Fixed)

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

\* Right after a pump, a ticket with owner input waits only if all max+1 slots are taken
\* or its worker failed to start, or its turn was cut, less than a minute ago (since 166ea0c).
ReservedSlotWorks ==
    pumped => \A t \in Tickets :
        (Runnable(t) /\ OwnerWaiting(t) /\ ~Running(t) /\ ~cooling[t]) => Cardinality(runs) >= MAX + 1

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

\* An input marked delivered reaches a turn that returns, or a session file
\* that is reopened. Split by how it can fail:
\*   InputNeverLostSilently: never dropped without the owner hearing of it (a crash)
\*   InputKeptForTwoCuts:    never dropped before two re-queues
\*   InputNeverLost:         never dropped at all (the strict promise)
InputNeverLostSilently == ~inputs.lost
InputKeptForTwoCuts    == ~inputs.droppedEarly
InputNeverLost         == ~inputs.lost /\ ~inputs.dropNotified /\ ~inputs.droppedEarly

\* Liveness: no input stays pending for ever.
NoInputStuck == \A t \in Tickets : HasPendingIn(t, inputs) ~> ~HasPendingIn(t, inputs)

NoInputLost == []InputNeverLost /\ NoInputStuck

\* A cut turn's inputs are re-queued at most twice in a row (4e2683a).
RetriesBounded == \A t \in Tickets : hist.readds[t] <= 2

\* No run starts within a minute of the ticket's failed start or cut turn.
RetryBackoff == ~hist.startedCooling

\* Liveness: the event loop keeps getting back to timers and I/O.
EventLoopProgress == []<>(~Micro)
=============================================================================
