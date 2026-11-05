--------------------------- MODULE GovernorTrace ---------------------------
(***************************************************************************)
(* Trace validation of the attention governor (Cirstea, Kuppe, Merz et al., *)
(* "Validating Traces of Distributed Programs Against TLA+ Specifications"). *)
(*                                                                         *)
(* record.ts drives the real src/core/governor.ts and writes one NDJSON    *)
(* file per run: line 1 holds the run's constants and initial state, every *)
(* other line one call (action, args), the notices the code handed out for *)
(* sending, and the state after the call mapped to Governor.tla's          *)
(* variables. This module is Governor.tla with two more variables: tr (the *)
(* trace, chosen in Init: one TLC run checks a batch of traces) and l (the *)
(* last line matched). Its next-state relation takes exactly the model     *)
(* action the next line names, only as a step of the model's Next, and     *)
(* only if the model's state after it equals the logged one. A trace is    *)
(* accepted iff some path reaches its last line: then the code's run is a  *)
(* behavior of Spec, up to the abstraction (the logged variables).         *)
(*                                                                         *)
(* Verdicts: TLC's statistics (the diameter used by the paper's             *)
(* TraceAccepted) cover the whole batch, so each trace reports its own:    *)
(* reaching the last line writes ResultDir/accepted-<tr>.json, and a state *)
(* with no matching successor writes ResultDir/rejected-<tr>-<l>.json with *)
(* the first unmatched line and what differs. check.sh reads them; no file *)
(* for a trace means no initial state matched its header.                  *)
(*                                                                         *)
(* The ghost variables (log, sends, shown, ownerMute) are not in the code; *)
(* the model computes them, and each line's `sent` must equal the notices  *)
(* the model's step adds to log. The model's properties are checked as     *)
(* invariants along every trace too, at the traces' (larger) bounds.       *)
(***************************************************************************)
EXTENDS MCGovernor, Json, TLC, Sequences, Integers, FiniteSets

CONSTANTS
    TraceFiles,  \* tuple of absolute paths of NDJSON traces (check.sh writes it into the .cfg)
    ResultDir    \* absolute path of the directory for the verdict files

Traces == [i \in 1..Len(TraceFiles) |-> ndJsonDeserialize(TraceFiles[i])]
K == Len(TraceFiles)

ToSet(s) == {s[i] : i \in DOMAIN s}
MaxSet(S) == CHOOSE x \in S : \A y \in S : y <= x

\* Constants shared by the batch (the .cfg binds Governor's constants to these): the topics and
\* keys of all headers; N is the most notices any trace offers (the others leave the rest "none").
\* MaxTime is the recorder's MAX_TIME, set in the .cfg (each trace may stop earlier).
TraceN == MaxSet({Traces[i][1].n : i \in 1..K})
TraceTopics == UNION {ToSet(Traces[i][1].topics) : i \in 1..K}
TraceKeys == UNION {ToSet(Traces[i][1].keys) : i \in 1..K}
TraceCustomExpiry == 1..24
HeaderPolicy(h) == [hasQuiet |-> h.policy.hasQuiet, qStart |-> h.policy.qStart,
                    qEnd |-> h.policy.qEnd, digest |-> ToSet(h.policy.digest),
                    maxInt |-> h.policy.maxInt, minGap |-> h.policy.minGap,
                    critCap |-> h.policy.critCap, dedup |-> h.policy.dedup,
                    expiry |-> h.policy.expiry]

VARIABLES
    tr,   \* which trace of the batch
    l     \* the last line of it matched (1 = the header)
traceVars == <<vars, tr, l>>

Log == Traces[tr]

-----------------------------------------------------------------------------
(* The abstraction check: the model's values equal the logged ones. A notice the code pruned *)
(* from state.notices ("*") is only checked to be pruned in the model too: its status and     *)
(* fields are no longer in the code's state. Ids above the trace's own N are never offered.  *)
NtOf(j) == [eff |-> j.eff, topic |-> j.topic, key |-> j.key, createdAt |-> j.createdAt,
            expiresAt |-> j.expiresAt, claimedFrom |-> j.claimedFrom]

SeqEq(a, b) == Len(a) = Len(b) /\ \A i \in 1..Len(a) : a[i] = b[i]

LSt(s, i)   == IF i <= Len(s.st) THEN s.st[i] ELSE "none"
LKept(s, i) == i <= Len(s.kept) /\ s.kept[i]

Match(s, vNow, vLast, vSt, vNt, vKept, vInt, vCrit, vMutes, vPen, vBusy, vPeeked) ==
    /\ vNow = s.now
    /\ vLast = s.lastTickAt
    /\ \A i \in Notices :
         /\ vKept[i] = LKept(s, i)
         /\ LSt(s, i) # "*" => vSt[i] = LSt(s, i)
         /\ LKept(s, i) => vNt[i] = NtOf(s.nt[i])
    /\ SeqEq(vInt, s.interrupts)
    /\ SeqEq(vCrit, s.criticals)
    /\ \A t \in Topics : vMutes[t] = s.mutes[t] /\ vPen[t] = s.penalties[t]
    /\ vBusy = s.busy
    /\ vPeeked = ToSet(s.peeked)

\* What differs, for the rejection report: <<variable, model value, logged (code) value>>.
Diff(s, vNow, vLast, vSt, vNt, vKept, vInt, vCrit, vMutes, vPen, vBusy, vPeeked) ==
    (IF vNow # s.now THEN {<<"now", vNow, s.now>>} ELSE {})
    \cup (IF vLast # s.lastTickAt THEN {<<"lastTickAt", vLast, s.lastTickAt>>} ELSE {})
    \cup {<<"kept[" \o ToString(i) \o "]", vKept[i], LKept(s, i)>> : i \in {i \in Notices : vKept[i] # LKept(s, i)}}
    \cup {<<"st[" \o ToString(i) \o "]", vSt[i], LSt(s, i)>> :
            i \in {i \in Notices : LSt(s, i) # "*" /\ vSt[i] # LSt(s, i)}}
    \cup {<<"nt[" \o ToString(i) \o "]", vNt[i], NtOf(s.nt[i])>> :
            i \in {i \in Notices : LKept(s, i) /\ vNt[i] # NtOf(s.nt[i])}}
    \cup (IF ~SeqEq(vInt, s.interrupts) THEN {<<"interrupts", vInt, s.interrupts>>} ELSE {})
    \cup (IF ~SeqEq(vCrit, s.criticals) THEN {<<"criticals", vCrit, s.criticals>>} ELSE {})
    \cup {<<"mutes[" \o t \o "]", vMutes[t], s.mutes[t]>> : t \in {t \in Topics : vMutes[t] # s.mutes[t]}}
    \cup {<<"penalties[" \o t \o "]", vPen[t], s.penalties[t]>> : t \in {t \in Topics : vPen[t] # s.penalties[t]}}
    \cup (IF vBusy # s.busy THEN {<<"busy", vBusy, s.busy>>} ELSE {})
    \cup (IF vPeeked # ToSet(s.peeked) THEN {<<"peeked", vPeeked, ToSet(s.peeked)>>} ELSE {})

\* The notices the model's step told the owner (new entries of the ghost log) are the ones the
\* code handed out for sending (offer's deliverNow, tick's digest, takeForReply's list, the
\* claimed notices a stored reply told).
NewlyTold == {e.n : e \in log' \ log}

-----------------------------------------------------------------------------
(* One logged call -> the Governor.tla action it names. A call that changes nothing in the code *)
(* (/digest with nothing waiting, unmute of a topic that is not muted) is a stuttering step:    *)
(* the model has no action for it, and the stutter is allowed only when the action is disabled. *)
Do(e) ==
    CASE e.action = "offer"    -> Offer(e.args.n, e.args.u, e.args.tp, e.args.k, e.args.dur)
      [] e.action = "tick"     -> Tick
      [] e.action = "advance"  -> Advance
      [] e.action = "digest"   -> DigestCommand \/ (~ENABLED DigestCommand /\ UNCHANGED vars)
      [] e.action = "claim"    -> ConciergeClaim
      [] e.action = "reply"    -> ConciergeReply(e.args.outcome)
      [] e.action = "restart"  -> Restart
      [] e.action = "mute"     -> Mute(e.args.tp, e.args.dur)
      [] e.action = "unmute"   -> Unmute(e.args.tp) \/ (~ENABLED Unmute(e.args.tp) /\ UNCHANGED vars)
      [] e.action = "penalize" -> Penalize(e.args.n)
      [] OTHER                 -> FALSE

(* Do(e) is a step of [Next]_vars when the arguments are in the domains Next quantifies over and
   the switch that enables the action (Feedback, Concierge) is on: each Do(e) is then one disjunct
   of Next instantiated (OfferAny, Tick, ..., PenalizeAny), or a stuttering step. Stated this way
   instead of conjoining [Next]_vars, which TLC would evaluate as a predicate over every disjunct
   of Next (much slower). *)
InNext(e) ==
    CASE e.action = "offer"    -> /\ e.args.u \in Urgencies /\ e.args.tp \in Topics /\ e.args.k \in Keys
                                  /\ e.args.n \in Notices /\ e.args.dur \in {pol.expiry} \cup CustomExpiry
      [] e.action = "claim"    -> Concierge
      [] e.action = "reply"    -> e.args.outcome \in ReplyOutcomes
      [] e.action = "restart"  -> Concierge
      [] e.action = "mute"     -> Feedback /\ e.args.tp \in Topics /\ e.args.dur \in MuteFor
      [] e.action = "unmute"   -> Feedback /\ e.args.tp \in Topics
      [] e.action = "penalize" -> Feedback /\ e.args.n \in Notices
      [] OTHER                 -> e.action \in {"tick", "advance", "digest"}

MatchStep ==
    /\ l < Len(Log)
    /\ l' = l + 1
    /\ UNCHANGED tr
    /\ LET e == Log[l + 1] IN
         /\ InNext(e)            \* the step is one the model's Next allows
         /\ Do(e)
         /\ Match(e.state, now', lastTickAt', st', nt', kept', interrupts', criticals', mutes',
                  penalties', busy', peeked')
         /\ NewlyTold = ToSet(e.sent)

RejectFile == ResultDir \o "/rejected-" \o ToString(tr) \o "-" \o ToString(l + 1) \o ".json"

(* No successor matches line l+1: write why, and add no state. *)
Explain ==
    /\ l < Len(Log)
    /\ ~ENABLED MatchStep
    /\ LET e == Log[l + 1] IN
         \/ /\ ~InNext(e)
            /\ JsonSerialize(RejectFile,
                 [trace |-> TraceFiles[tr], line |-> l + 1, action |-> e.action, args |-> ToString(e.args),
                  why |-> "not a step of Next: an unknown call, or arguments outside the model's domains"])
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
                      Diff(e.state, now', lastTickAt', st', nt', kept', interrupts', criticals', mutes',
                           penalties', busy', peeked')
                      \cup (IF NewlyTold # ToSet(e.sent) THEN {<<"told", NewlyTold, ToSet(e.sent)>>} ELSE {}))])
            /\ FALSE

TraceInit ==
    /\ tr \in 1..K
    /\ Init
    /\ pol = HeaderPolicy(Traces[tr][1])   \* the recorder's GovernorPolicy is one of the model's Policies
    /\ l = 1
    /\ Match(Traces[tr][1].state, now, lastTickAt, st, nt, kept, interrupts, criticals, mutes, penalties,
             busy, peeked)

TraceNext == MatchStep \/ Explain

TraceSpec == TraceInit /\ [][TraceNext]_traceVars

(* Invariant with a side effect: a state that matched the last line of its trace records it. *)
Accepted ==
    l = Len(Log) =>
        JsonSerialize(ResultDir \o "/accepted-" \o ToString(tr) \o ".json",
                      [trace |-> TraceFiles[tr], lines |-> l])
=============================================================================
