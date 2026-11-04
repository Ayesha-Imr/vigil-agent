------------------------------ MODULE Governor ------------------------------
(***************************************************************************)
(* The attention governor, src/core/governor.ts, as the daemon drives it   *)
(* through src/core/notifier.ts, src/agent/concierge.ts and src/daemon.ts. *)
(*                                                                         *)
(* One TLA+ action per call. Each governor call is one pure function that  *)
(* Notifier runs inside one db.tx(), so it is one indivisible step:        *)
(*                                                                         *)
(*  Offer          offer()            Notifier.notify                      *)
(*  Tick           tick()             Notifier.tick (daemon, every 30 s)   *)
(*  DigestCommand  takeForReply()     Notifier.takeForReply (/digest)      *)
(*  Mute           mute()             Notifier.mute                        *)
(*  Unmute         unmute()           Notifier.unmute                      *)
(*  Penalize       penalize()         Notifier.dislike                     *)
(*  ConciergePeek  waiting()          Concierge, owner message: the        *)
(*                                    waiting notices go into the prompt   *)
(*  ConciergeReply this.reply() then  Concierge, after the model answers:  *)
(*                 markDelivered()    reply stored, then                   *)
(*                                    Notifier.confirmDelivered(ids)       *)
(*  Advance        the wall clock moves on (Clock.now() grows)             *)
(*                                                                         *)
(* Between ConciergePeek and ConciergeReply the concierge awaits the model *)
(* (promptWithFallback), so every other action can happen in between.      *)
(*                                                                         *)
(* Time is discrete: one unit is a "slot" and a day (DAY in time.ts) is D  *)
(* slots. The model is the code run with a policy whose durations are      *)
(* whole slots and with every event at a slot boundary, in a time zone     *)
(* without DST (crossed()'s DST handling is not modeled). Quiet hours and  *)
(* digest times are slots of the day. Policies (GovernorPolicy) are chosen *)
(* in Init, like the property test's random policies.                      *)
(*                                                                         *)
(* Notices are offered in id order (ids are opaque, so this only removes   *)
(* symmetric copies). Ghost variables (log, sends, ownerMute) record what  *)
(* reached the owner and what the owner said; the code has no such state.  *)
(* The runtime guard checkSend() (src/core/invariants.ts) is NOT modeled:  *)
(* it can only refuse a send, so the rules are checked without that net.   *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    N,             \* notices offered in one behavior: ids 1..N
    Topics,        \* NoticeInput.topic values
    Keys,          \* NoticeInput.dedupKey values
    D,             \* slots per day (DAY)
    Policies,      \* set of GovernorPolicy records, see MCGovernor.tla
    MaxTime,       \* the clock stops at this slot (bound of the model)
    MuteFor,       \* durations (slots) the owner can mute a topic for (Notifier.mute forMs)
    PenaltySlots,  \* Notifier.dislike lowers a topic for 7 * DAY
    HistorySlots,  \* HISTORY_MS = 7 * DAY: tick() forgets resolved notices older than this
    CustomExpiry,  \* offsets (slots) a caller may give as NoticeInput.expiresAt; the default is pol.expiry
    Feedback,      \* TRUE: the owner's mute / unmute / dislike actions are in the model
    Concierge,     \* TRUE: the concierge's peek-then-confirm reply path is in the model
    ReplyOutcomes, \* subset of {"stored", "partial", "none"}: how a concierge turn can end
    ClaimOnPeek    \* FALSE: the code as it is. TRUE: the SUGGESTED FIX (not in the code), see ConciergePeek

NONE == -1          \* "no entry" in mutes / penalties (the key is absent)
Notices == 1..N
Urgencies == {"critical", "high", "normal", "low"}
Waiting == {"queued", "held"}                         \* isWaiting()
Final == {"delivered", "digested", "dropped", "expired"}
Statuses == {"none", "telling"} \cup Waiting \cup Final  \* "none" = not offered yet;
                                                     \* "telling" exists only with ClaimOnPeek

VARIABLES
    now,         \* Clock.now()
    lastTickAt,  \* GovernorState.lastTickAt
    pol,         \* the GovernorPolicy (fixed for a behavior)
    st,          \* Notice.status per notice id
    nt,          \* the rest of each Notice: effective, topic, dedupKey, createdAt, expiresAt
                 \* (Notice.urgency is not read again after offer(), so it is left out)
    kept,        \* whether the notice is still in GovernorState.notices (tick() prunes history)
    interrupts,  \* GovernorState.interrupts (delivery slots of high/normal interrupts)
    criticals,   \* GovernorState.criticals
    mutes,       \* GovernorState.mutes: topic -> until, or NONE
    penalties,   \* GovernorState.penalties: topic -> until, or NONE
    busy,        \* the concierge is in a turn for an owner message
    peeked,      \* the notice ids that turn put into the prompt (const waiting = notifier.waiting())
    \* ghosts
    log,         \* every delivery to the owner: [n, at, how, muted]
    sends,       \* how many times each notice reached the owner
    ownerMute    \* what the owner last said about each topic: muted until, or NONE

vars == <<now, lastTickAt, pol, st, nt, kept, interrupts, criticals, mutes, penalties,
          busy, peeked, log, sends, ownerMute>>

\* prev: the status a claimed notice returns to when the reply fails (ClaimOnPeek only)
NoNotice == [eff |-> "low", topic |-> "none", key |-> "none", createdAt |-> 0, expiresAt |-> 0, prev |-> "none"]

-----------------------------------------------------------------------------
(* Helpers, each a function of governor.ts or time.ts *)

Max2(a, b) == IF a > b THEN a ELSE b
Min2(a, b) == IF a < b THEN a ELSE b

\* An "until" past the end of the run is only ever compared with now <= MaxTime, so every such
\* value acts the same. Capping it keeps the state space finite and changes no outcome.
Until(t) == Min2(t, MaxTime + 1)

\* time.ts inWindow(m, start, end)
InWindow(m, s, e) == IF s = e THEN FALSE
                     ELSE IF s < e THEN m >= s /\ m < e
                     ELSE m >= s \/ m < e

\* governor.ts isQuiet(t, policy); hasQuiet = FALSE is quietHours: null
IsQuiet(t) == pol.hasQuiet /\ InWindow(t % D, pol.qStart, pol.qEnd)

\* governor.ts within24h(times, now)
Within24h(s, t) == Cardinality({i \in 1..Len(s) : s[i] > t - D})

\* Math.max(...state.interrupts)
MaxOf(s) == CHOOSE x \in {s[i] : i \in 1..Len(s)} : \A i \in 1..Len(s) : s[i] <= x

\* governor.ts crossed(from, to, target): the local clock passed time of day `target` in
\* (from, to], looking back at most one day (startK >= b - 1440). Without DST every step of the
\* local clock is one minute, so this is "some slot k in the range has time of day target".
Crossed(from, to, target) == \E k \in Max2(from + 1, to - D)..to : k % D = target

\* governor.ts lower(u)
Lower(u) == IF u = "high" THEN "normal" ELSE IF u = "normal" THEN "low" ELSE u

\* Ghost counter of how often a notice reached the owner. Every rule only asks whether it is
\* 0, 1 or more, so it stops at 2; this keeps a reply that tells a notice again and again finite.
Bump(k) == Min2(k + 1, 2)

MutedNow(tp) == ownerMute[tp] > now
Delivery(n, how) == [n |-> n, at |-> now, how |-> how, muted |-> MutedNow(nt[n].topic)]

IsWaiting(m) == kept[m] /\ st[m] \in Waiting

-----------------------------------------------------------------------------
Init ==
    /\ now = 0
    /\ lastTickAt = 0                       \* initialState(now)
    /\ pol \in Policies
    /\ st = [n \in Notices |-> "none"]
    /\ nt = [n \in Notices |-> NoNotice]
    /\ kept = [n \in Notices |-> FALSE]
    /\ interrupts = <<>>
    /\ criticals = <<>>
    /\ mutes = [t \in Topics |-> NONE]
    /\ penalties = [t \in Topics |-> NONE]
    /\ busy = FALSE
    /\ peeked = {}
    /\ log = {}
    /\ sends = [n \in Notices |-> 0]
    /\ ownerMute = [t \in Topics |-> NONE]

(***************************************************************************)
(* offer(): steps 1..7 in the order of the code.                           *)
(***************************************************************************)
Offer(n, u, tp, k, dur) ==
    /\ st[n] = "none"
    /\ IF n = 1 THEN TRUE ELSE st[n - 1] # "none"
    /\ now + dur <= MaxTime     \* bound: every offered notice can still reach its expiry in the model
    /\ LET
         \* 1. muted topic
         muted == mutes[tp] # NONE /\ mutes[tp] > now
         \* 2. duplicate of news delivered or waiting, within the dedup window
         windowStart == now - pol.dedup
         dup == \E m \in Notices :
                  /\ kept[m]
                  /\ nt[m].key = k
                  /\ nt[m].createdAt > windowStart
                  /\ st[m] # "dropped" /\ st[m] # "expired"
         \* feedback penalty lowers non-critical urgency one step
         e0 == IF u # "critical" /\ penalties[tp] # NONE /\ penalties[tp] > now THEN Lower(u) ELSE u
         \* 3. critical within its own cap
         critOk == Within24h(criticals, now) < pol.critCap
         e1 == IF e0 = "critical" /\ ~critOk THEN "high" ELSE e0
         \* 6. budget and spacing
         spaced == Len(interrupts) = 0 \/ now - MaxOf(interrupts) >= pol.minGap
         withinBudget == Within24h(interrupts, now) < pol.maxInt
         branch ==
           IF muted THEN "muted"                             \* 1.
           ELSE IF dup THEN "duplicate"                      \* 2.
           ELSE IF e0 = "critical" /\ critOk THEN "critical" \* 3.
           ELSE IF e1 = "low" THEN "low"                     \* 4.
           ELSE IF IsQuiet(now) THEN "quiet"                 \* 5.
           ELSE IF withinBudget /\ spaced THEN "interrupt"   \* 6.
           ELSE "overBudget"                                 \* 7.
         status == CASE branch \in {"muted", "duplicate"} -> "dropped"
                     [] branch \in {"critical", "interrupt"} -> "delivered"
                     [] branch = "quiet" -> "held"
                     [] OTHER -> "queued"
         \* the `effective` argument each finish() call passes
         eff == CASE branch \in {"muted", "duplicate"} -> u       \* finish(input.urgency, ...)
                  [] branch = "critical" -> "critical"           \* finish("critical", ...)
                  [] OTHER -> e1                                 \* finish(effective, ...)
       IN
         /\ st' = [st EXCEPT ![n] = status]
         /\ nt' = [nt EXCEPT ![n] = [eff |-> eff, topic |-> tp, key |-> k,
                                     createdAt |-> now, expiresAt |-> now + dur, prev |-> "none"]]
         /\ kept' = [kept EXCEPT ![n] = TRUE]
         /\ criticals' = IF branch = "critical" THEN Append(criticals, now) ELSE criticals
         /\ interrupts' = IF branch = "interrupt" THEN Append(interrupts, now) ELSE interrupts
         /\ log' = IF status = "delivered"
                     THEN log \cup {[n |-> n, at |-> now, how |-> "alone", muted |-> MutedNow(tp)]}
                     ELSE log
         /\ sends' = IF status = "delivered" THEN [sends EXCEPT ![n] = Bump(@)] ELSE sends
         /\ UNCHANGED <<now, lastTickAt, pol, mutes, penalties, busy, peeked, ownerMute>>

OfferAny ==
    \E n \in Notices, u \in Urgencies, tp \in Topics, k \in Keys, dur \in {pol.expiry} \cup CustomExpiry :
        Offer(n, u, tp, k, dur)

(***************************************************************************)
(* tick(): expire, then flush one digest when a digest time or the end of  *)
(* quiet hours was crossed since lastTickAt, then prune history.           *)
(***************************************************************************)
Tick ==
    LET expired == {m \in Notices : st[m] \in Waiting /\ nt[m].expiresAt <= now}
        st1 == [m \in Notices |-> IF m \in expired THEN "expired" ELSE st[m]]
        quiet == IsQuiet(now)
        digestDue == ~quiet /\ \E d \in pol.digest : Crossed(lastTickAt, now, d)
        quietEnded == /\ ~quiet
                      /\ pol.hasQuiet
                      /\ Crossed(lastTickAt, now, pol.qEnd)
                      /\ \E m \in Notices : st1[m] = "held"
        flushed == IF digestDue \/ quietEnded THEN {m \in Notices : st1[m] \in Waiting} ELSE {}
        st2 == [m \in Notices |-> IF m \in flushed THEN "digested" ELSE st1[m]]
    IN
        /\ st' = st2
        /\ kept' = [m \in Notices |-> kept[m] /\ (st2[m] \in Waiting \cup {"telling"} \/ nt[m].createdAt > now - HistorySlots)]
        /\ interrupts' = SelectSeq(interrupts, LAMBDA t : t > now - D)
        /\ criticals' = SelectSeq(criticals, LAMBDA t : t > now - D)
        /\ mutes' = [t \in Topics |-> IF mutes[t] # NONE /\ mutes[t] > now THEN mutes[t] ELSE NONE]
        /\ penalties' = [t \in Topics |-> IF penalties[t] # NONE /\ penalties[t] > now THEN penalties[t] ELSE NONE]
        /\ lastTickAt' = now
        /\ log' = log \cup {Delivery(m, "digest") : m \in flushed}
        /\ sends' = [m \in Notices |-> IF m \in flushed THEN Bump(sends[m]) ELSE sends[m]]
        /\ UNCHANGED <<now, pol, nt, busy, peeked, ownerMute>>

(* /digest: takeForReply() flushes every waiting notice and the daemon says them, in one call. *)
DigestCommand ==
    LET flushed == {m \in Notices : IsWaiting(m)}
    IN /\ flushed # {}
       /\ st' = [m \in Notices |-> IF m \in flushed THEN "digested" ELSE st[m]]
       /\ log' = log \cup {Delivery(m, "reply") : m \in flushed}
       /\ sends' = [m \in Notices |-> IF m \in flushed THEN Bump(sends[m]) ELSE sends[m]]
       /\ UNCHANGED <<now, lastTickAt, pol, nt, kept, interrupts, criticals, mutes, penalties,
                      busy, peeked, ownerMute>>

(* Concierge, owner message: const waiting = this.s.notifier.waiting(); the list goes into the
   prompt, then the turn awaits the model. Nothing in GovernorState changes.
   SUGGESTED FIX (ClaimOnPeek): claim the notices instead, status "telling", which tick(),
   takeForReply() and mute() leave alone because it is not isWaiting(). *)
ConciergePeek ==
    /\ Concierge
    /\ ~busy
    /\ busy' = TRUE
    /\ peeked' = {m \in Notices : IsWaiting(m)}
    /\ IF ClaimOnPeek
         THEN /\ st' = [m \in Notices |-> IF IsWaiting(m) THEN "telling" ELSE st[m]]
              /\ nt' = [m \in Notices |-> IF IsWaiting(m) THEN [nt[m] EXCEPT !.prev = st[m]] ELSE nt[m]]
         ELSE UNCHANGED <<st, nt>>
    /\ UNCHANGED <<now, lastTickAt, pol, kept, interrupts, criticals, mutes, penalties,
                   log, sends, ownerMute>>

(* Concierge, the model answered. outcome:
     "stored"  : a reply without error: this.reply(input, out) stores it, and then
                 confirmDelivered(waiting ids) -> markDelivered() marks those still waiting;
     "partial" : r.error with some text: the reply is stored but nothing is confirmed;
     "none"    : no text, or a SILENT answer: nothing is sent, nothing confirmed.
   Assumption: a stored reply tells the owner every notice the prompt listed. *)
ConciergeReply(outcome) ==
    /\ busy
    /\ busy' = FALSE
    /\ peeked' = {}
    /\ LET told == IF outcome = "none" THEN {} ELSE peeked
           \* code: confirmDelivered -> markDelivered marks those still waiting, only when "stored".
           \* fix: a stored or partial reply marks every claimed notice; "none" releases them.
           marked == IF ClaimOnPeek
                       THEN IF outcome = "none" THEN {} ELSE peeked
                       ELSE IF outcome = "stored" THEN {m \in peeked : IsWaiting(m)} ELSE {}
           released == IF ClaimOnPeek /\ outcome = "none" THEN peeked ELSE {}
       IN /\ log' = log \cup {Delivery(m, "reply") : m \in told}
          /\ sends' = [m \in Notices |-> IF m \in told THEN Bump(sends[m]) ELSE sends[m]]
          /\ st' = [m \in Notices |-> IF m \in marked THEN "digested"
                                      ELSE IF m \in released THEN nt[m].prev
                                      ELSE st[m]]
    /\ UNCHANGED <<now, lastTickAt, pol, nt, kept, interrupts, criticals, mutes, penalties, ownerMute>>

(* mute(): set the mute, drop waiting notices on the topic. *)
Mute(tp, dur) ==
    /\ mutes' = [mutes EXCEPT ![tp] = Until(now + dur)]
    /\ st' = [m \in Notices |-> IF IsWaiting(m) /\ nt[m].topic = tp THEN "dropped" ELSE st[m]]
    /\ ownerMute' = [ownerMute EXCEPT ![tp] = Until(now + dur)]
    /\ UNCHANGED <<now, lastTickAt, pol, nt, kept, interrupts, criticals, penalties, busy, peeked, log, sends>>

(* unmute() *)
Unmute(tp) ==
    /\ mutes[tp] # NONE \/ ownerMute[tp] # NONE
    /\ mutes' = [mutes EXCEPT ![tp] = NONE]
    /\ ownerMute' = [ownerMute EXCEPT ![tp] = NONE]
    /\ UNCHANGED <<now, lastTickAt, pol, st, nt, kept, interrupts, criticals, penalties, busy, peeked, log, sends>>

(* Notifier.dislike(noticeId): finds the notice in state.notices, then penalize(topic, now + 7d). *)
Penalize(n) ==
    /\ kept[n]
    /\ penalties' = [penalties EXCEPT ![nt[n].topic] = Until(now + PenaltySlots)]
    /\ UNCHANGED <<now, lastTickAt, pol, st, nt, kept, interrupts, criticals, mutes, busy, peeked, log, sends, ownerMute>>

(* The wall clock moves on. Nothing in GovernorState changes until the next call. *)
Advance ==
    /\ now < MaxTime
    /\ now' = now + 1
    \* ghost normalisation: a mute that has run out is the same as no mute
    /\ ownerMute' = [t \in Topics |-> IF ownerMute[t] > now + 1 THEN ownerMute[t] ELSE NONE]
    /\ UNCHANGED <<lastTickAt, pol, st, nt, kept, interrupts, criticals, mutes, penalties, busy, peeked, log, sends>>

ConciergeReplyAny == \E o \in ReplyOutcomes : ConciergeReply(o)
MuteAny     == Feedback /\ \E tp \in Topics, dur \in MuteFor : Mute(tp, dur)
UnmuteAny   == Feedback /\ \E tp \in Topics : Unmute(tp)
PenalizeAny == Feedback /\ \E n \in Notices : Penalize(n)

Next ==
    \/ OfferAny
    \/ Tick
    \/ DigestCommand
    \/ ConciergePeek
    \/ ConciergeReplyAny
    \/ MuteAny
    \/ UnmuteAny
    \/ PenalizeAny
    \/ Advance

\* The daemon keeps ticking (every 30 s) and the clock keeps moving.
\* With ClaimOnPeek, a claimed notice also needs the concierge's turn to end.
Fairness == WF_vars(Tick) /\ WF_vars(Advance) /\ (ClaimOnPeek => WF_vars(ConciergeReplyAny))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(***************************************************************************)
(* State fingerprint for TLC (VIEW). Two states with the same view have the *)
(* same future, so TLC explores one of them:                               *)
(*  - an until <= now in mutes / penalties / ownerMute acts as no entry,   *)
(*    because the code only ever tests until > now and now never falls;    *)
(*  - crossed(lastTickAt, now, _) never looks back more than one day, so   *)
(*    any lastTickAt older than now - D acts as now - D - 1.               *)
(* The variables themselves keep the values the code would hold.           *)
(***************************************************************************)
Live(u) == IF u # NONE /\ u > now THEN u ELSE NONE
View == <<now, Max2(lastTickAt, now - D - 1), pol, st, nt, kept, interrupts, criticals,
          [t \in Topics |-> Live(mutes[t])], [t \in Topics |-> Live(penalties[t])],
          busy, peeked, log, sends, [t \in Topics |-> Live(ownerMute[t])]>>

-----------------------------------------------------------------------------
(* Properties. Each is the rule from docs/DESIGN.md, stated over what reached the owner. *)

TypeOK ==
    /\ now \in 0..MaxTime
    /\ st \in [Notices -> Statuses]
    /\ sends \in [Notices -> 0..2]
    /\ peeked \subseteq Notices

Alone == {e \in log : e.how = "alone" /\ nt[e.n].eff # "critical"}
Crit  == {e \in log : e.how = "alone" /\ nt[e.n].eff = "critical"}

\* Budget: in every rolling day, high/normal interrupts <= maxInterruptsPerDay, and two of them
\* are at least minGapMinutes apart.
Budget ==
    /\ \A e \in Alone : Cardinality({f \in Alone : f.at > e.at - D /\ f.at <= e.at}) <= pol.maxInt
    /\ \A e, f \in Alone : (e.n # f.n /\ e.at >= f.at) => e.at - f.at >= pol.minGap

\* CriticalCap: critical deliveries in every rolling day <= criticalPerDay.
CriticalCap ==
    \A e \in Crit : Cardinality({f \in Crit : f.at > e.at - D /\ f.at <= e.at}) <= pol.critCap

\* Quiet: nothing but critical reaches the owner unasked during quiet hours, digests included.
\* A reply (the concierge's, or /digest) is solicited: the owner wrote first.
Quiet ==
    \A e \in log : (e.how = "digest" \/ e \in Alone) => ~IsQuiet(e.at)

\* NoMuted: nothing reaches the owner on a topic while the owner has it muted.
NoMuted == \A e \in log : ~e.muted

\* NoDuplicate: two notices that reached the owner never share a dedup key within the dedup window.
NoDuplicate ==
    \A e, f \in log :
        (e.n # f.n /\ nt[e.n].key = nt[f.n].key) =>
            (nt[e.n].createdAt - nt[f.n].createdAt >= pol.dedup \/ nt[f.n].createdAt - nt[e.n].createdAt >= pol.dedup)

\* Conservation: every offered notice has exactly one status, a waiting notice is never forgotten,
\* a notice reaches the owner at most once, and it reached the owner iff its status says so.
Conservation ==
    \A n \in Notices :
        /\ st[n] # "none" => st[n] \in Waiting \cup Final \cup {"telling"}
        /\ st[n] \in Waiting \cup {"telling"} => kept[n]
        /\ sends[n] <= 1
        /\ (sends[n] = 1) <=> (st[n] \in {"delivered", "digested"})

\* A final status never changes again.
FinalStable == [][\A n \in Notices : st[n] \in Final => st'[n] = st[n]]_vars

\* EventuallyResolved: every waiting notice is eventually delivered, digested, dropped or expired.
EventuallyResolved == \A n \in Notices : (st[n] \in Waiting \cup {"telling"}) ~> (st[n] \in Final)

\* Extra (finding check, not a DESIGN.md rule): nothing reaches the owner at or after its expiresAt.
NoStaleDelivery == \A e \in log : e.at < nt[e.n].expiresAt
=============================================================================
