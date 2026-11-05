---------------------------- MODULE OutboxTrace ----------------------------
(***************************************************************************)
(* Trace validation of the outbox (Cirstea, Kuppe, Merz et al.,            *)
(* "Validating Traces of Distributed Programs Against TLA+ Specifications"),*)
(* built like verification/governor/trace/GovernorTrace.tla.               *)
(*                                                                         *)
(* record.ts drives a real Outbox (src/core/outbox.ts) on a real in-memory *)
(* Db with a scripted channel and writes one NDJSON file per run: line 1   *)
(* holds the scenario (Outbox.tla's Items) and the initial state; every    *)
(* other line one model step (action, args), the deliveries the owner got  *)
(* in it (row, how), and the state after it: the outbox and message_refs   *)
(* rows read from the DB, the passes (deliverDue calls in memory: phase,   *)
(* row in flight, the rest of the snapshot) and the abandoned sends, mapped *)
(* to Outbox.tla's variables.  This module is Outbox.tla with two more     *)
(* variables: tr (the trace; one TLC run checks a batch of traces that     *)
(* share one scenario) and l (the last line matched).  Its next-state      *)
(* relation takes exactly the model action the next line names, as a step  *)
(* of Next, and only if the model's state after it equals the logged one   *)
(* and the deliveries the step adds to `log` are the logged ones.          *)
(*                                                                         *)
(* Verdicts per trace, as in GovernorTrace: ResultDir/accepted-<tr>.json   *)
(* when a state matches the last line; ResultDir/rejected-<tr>-<l>.json    *)
(* when a state has no matching successor, with the first unmatched line   *)
(* and what differs.  No file: no initial state matched the header.        *)
(*                                                                         *)
(* Not compared (the model's own bookkeeping, or not in the code): the     *)
(* history flags in log and pass[p].fl, the bound counters (crashes,       *)
(* fails, drops, timeouts, stale; the .cfg sets their bounds out of        *)
(* reach), and the lock variables (Daemons = 1: one daemon, as assumed).   *)
(* A line's state.dueAny lists rows whose `due` the line does not check    *)
(* (record.ts: rows that came due at the same instant as the step).        *)
(* The model's invariants are checked along every trace too.               *)
(***************************************************************************)
EXTENDS Outbox, Json, TLC, Sequences, Integers, FiniteSets

CONSTANTS
    TraceFiles,  \* tuple of absolute paths of NDJSON traces (check.sh writes them into a module)
    ResultDir    \* absolute path of the directory for the verdict files

Traces == [i \in 1..Len(TraceFiles) |-> ndJsonDeserialize(TraceFiles[i])]
K == Len(TraceFiles)

ToSet(s) == {s[i] : i \in DOMAIN s}

\* The batch's scenario (the .cfg binds Items to it); TraceInit checks every header has the same.
TraceItems == Traces[1][1].items

VARIABLES
    tr,   \* which trace of the batch
    l     \* the last line of it matched (1 = the header)
traceVars == <<vars, tr, l>>

Log == Traces[tr]

-----------------------------------------------------------------------------
(* The abstraction check: the model's values equal the logged ones. *)
PassEq(m, s) == m.ph = s.ph /\ m.cur = s.cur /\ m.att = s.att /\ m.todo = s.todo
OrphanRows(o) == [k \in DOMAIN o |-> o[k].row]

Match(s, vEnq, vStatus, vAtt, vDue, vOkey, vExt, vRefs, vUp, vChan, vPass, vOrph) ==
    /\ Len(s.status) = NRows                 \* the code made as many rows as the scenario's parts
    /\ vEnq = s.enq
    /\ \A r \in Rows :
         /\ vStatus[r] = s.status[r]
         /\ vAtt[r] = s.attempts[r]
         /\ vOkey[r] = s.okey[r]
         /\ vExt[r] = s.ext[r]
         /\ r \notin ToSet(s.dueAny) => vDue[r] = s.due[r]
    /\ vRefs = ToSet(s.refs)
    /\ vUp = s.up
    /\ vChan = s.chanUp
    /\ \A p \in Slots : PassEq(vPass[p], s.pass[p])
    /\ OrphanRows(vOrph) = s.orphans

\* What differs, for the rejection report: <<variable, model value, logged (code) value>>.
Diff(s, vEnq, vStatus, vAtt, vDue, vOkey, vExt, vRefs, vUp, vChan, vPass, vOrph) ==
    IF Len(s.status) # NRows THEN {<<"rows", NRows, Len(s.status)>>} ELSE
    (IF vEnq # s.enq THEN {<<"enq", vEnq, s.enq>>} ELSE {})
    \cup {<<"status[" \o ToString(r) \o "]", vStatus[r], s.status[r]>> : r \in {r \in Rows : vStatus[r] # s.status[r]}}
    \cup {<<"attempts[" \o ToString(r) \o "]", vAtt[r], s.attempts[r]>> : r \in {r \in Rows : vAtt[r] # s.attempts[r]}}
    \cup {<<"okey[" \o ToString(r) \o "]", vOkey[r], s.okey[r]>> : r \in {r \in Rows : vOkey[r] # s.okey[r]}}
    \cup {<<"ext[" \o ToString(r) \o "]", vExt[r], s.ext[r]>> : r \in {r \in Rows : vExt[r] # s.ext[r]}}
    \cup {<<"due[" \o ToString(r) \o "]", vDue[r], s.due[r]>> :
            r \in {r \in Rows : r \notin ToSet(s.dueAny) /\ vDue[r] # s.due[r]}}
    \cup (IF vRefs # ToSet(s.refs) THEN {<<"refs", vRefs, ToSet(s.refs)>>} ELSE {})
    \cup (IF vUp # s.up THEN {<<"up", vUp, s.up>>} ELSE {})
    \cup (IF vChan # s.chanUp THEN {<<"chanUp", vChan, s.chanUp>>} ELSE {})
    \cup {<<"pass[" \o ToString(p) \o "]", [ph |-> vPass[p].ph, cur |-> vPass[p].cur, att |-> vPass[p].att,
                                           todo |-> vPass[p].todo], s.pass[p]>> :
            p \in {p \in Slots : ~PassEq(vPass[p], s.pass[p])}}
    \cup (IF OrphanRows(vOrph) # s.orphans THEN {<<"orphans", OrphanRows(vOrph), s.orphans>>} ELSE {})

\* The deliveries the model's step appends to the ghost `log` are the ones the channel received.
NewSends == [k \in 1..(Len(log') - Len(log)) |-> [row |-> log'[Len(log) + k].row, how |-> log'[Len(log) + k].how]]
SendsEq(sent) ==
    /\ Len(log') - Len(log) = Len(sent)
    /\ \A k \in 1..Len(sent) : NewSends[k].row = sent[k].row /\ NewSends[k].how = sent[k].how

-----------------------------------------------------------------------------
(* One logged step -> the Outbox.tla action it names (record.ts says where each line is cut). *)
(* deliver-noop is deliverDue returning at once (`this.running`): the model has no action for  *)
(* it, and the stutter is allowed only while no PassStart is enabled.                          *)
Do(e) ==
    CASE e.action = "enqueue"      -> Enqueue
      [] e.action = "pass-start"   -> PassStart(e.args.p)
      [] e.action = "deliver-noop" -> ~ENABLED (\E p \in Slots : PassStart(p)) /\ UNCHANGED vars
      [] e.action = "continue"     -> Continue(e.args.p)
      [] e.action = "succeed"      -> SucceedWith(e.args.p, TRUE)
      [] e.action = "fail"         -> FailTransient(e.args.p)
      [] e.action = "drop"         -> FailPermanent(e.args.p)
      [] e.action = "timeout"      -> TimeoutFires(e.args.p)
      [] e.action = "orphan-lands" -> OrphanLands(e.args.i)
      [] e.action = "orphan-fails" -> OrphanFails(e.args.i)
      [] e.action = "backoff"      -> BackoffElapses(e.args.r)
      [] e.action = "crash"        -> Crash
      [] e.action = "restart"      -> Restart
      [] OTHER                     -> FALSE

(* Do(e) is a step of [Next]_vars when its arguments are in the domains Next quantifies over:
   each Do(e) is then one disjunct of Next instantiated, or a stuttering step. *)
InNext(e) ==
    CASE e.action \in {"pass-start", "continue", "succeed", "fail", "drop", "timeout"} -> e.args.p \in Slots
      [] e.action \in {"orphan-lands", "orphan-fails"} -> e.args.i \in DOMAIN orphans
      [] e.action = "backoff"      -> e.args.r \in Rows
      [] OTHER                     -> e.action \in {"enqueue", "deliver-noop", "crash", "restart"}

MatchStep ==
    /\ l < Len(Log)
    /\ l' = l + 1
    /\ UNCHANGED tr
    /\ LET e == Log[l + 1] IN
         /\ InNext(e)
         /\ Do(e)
         /\ Match(e.state, enq', status', attempts', due', okey', ext', refs', up', chanUp', pass', orphans')
         /\ SendsEq(e.sent)

RejectFile == ResultDir \o "/rejected-" \o ToString(tr) \o "-" \o ToString(l + 1) \o ".json"

(* No successor matches line l+1: write why, and add no state. *)
Explain ==
    /\ l < Len(Log)
    /\ ~ENABLED MatchStep
    /\ LET e == Log[l + 1] IN
         \/ /\ ~InNext(e)
            /\ JsonSerialize(RejectFile,
                 [trace |-> TraceFiles[tr], line |-> l + 1, action |-> e.action, args |-> ToString(e.args),
                  why |-> "not a step of Next: a step the model does not have (unexplained-*: the code wrote, sent or finished where no model step does), or arguments outside its domains"])
            /\ FALSE
         \/ /\ InNext(e)
            /\ ~ENABLED Do(e)
            /\ JsonSerialize(RejectFile,
                 [trace |-> TraceFiles[tr], line |-> l + 1, action |-> e.action, args |-> ToString(e.args),
                  why |-> "the model cannot take this step in this state (a guard of the action is false)"])
            /\ FALSE
         \/ /\ InNext(e)
            /\ Do(e)
            /\ JsonSerialize(RejectFile,
                 [trace |-> TraceFiles[tr], line |-> l + 1, action |-> e.action, args |-> ToString(e.args),
                  why |-> "after the step the model's state differs from the code's: <<variable, model, code>>",
                  diff |-> ToString(
                      Diff(e.state, enq', status', attempts', due', okey', ext', refs', up', chanUp', pass', orphans')
                      \cup (IF ~SendsEq(e.sent) THEN {<<"sent", NewSends, e.sent>>} ELSE {}))])
            /\ FALSE

TraceInit ==
    /\ tr \in 1..K
    /\ Init
    /\ Traces[tr][1].items = Items        \* every trace of the batch has the batch's scenario
    /\ l = 1
    /\ Match(Traces[tr][1].state, enq, status, attempts, due, okey, ext, refs, up, chanUp, pass, orphans)

TraceNext == MatchStep \/ Explain

TraceSpec == TraceInit /\ [][TraceNext]_traceVars

(* Invariant with a side effect: a state that matched the last line of its trace records it. *)
Accepted ==
    l = Len(Log) =>
        JsonSerialize(ResultDir \o "/accepted-" \o ToString(tr) \o ".json",
                      [trace |-> TraceFiles[tr], lines |-> l])
=============================================================================
