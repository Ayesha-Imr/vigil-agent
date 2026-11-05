------------------------------ MODULE Governor ------------------------------
(***************************************************************************)
(* The attention governor, src/core/governor.ts, as the daemon drives it   *)
(* through src/core/notifier.ts, src/agent/concierge.ts and src/daemon.ts. *)
(*                                                                         *)
(* One TLA+ action per call. Each governor call is one pure function that  *)
(* Notifier runs inside one db.tx() (or one synchronous commit), so it is  *)
(* one indivisible step:                                                   *)
(*                                                                         *)
(*  Offer          offer()            Notifier.notify                      *)
(*  Tick           tick()             Notifier.tick (daemon, every 30 s)   *)
(*  DigestCommand  takeForReply()     Notifier.takeForReply (/digest)      *)
(*  Mute           mute()             Notifier.mute                        *)
(*  Unmute         unmute()           Notifier.unmute                      *)
(*  Penalize       penalize()         Notifier.dislike                     *)
(*  ConciergeClaim claim()            Notifier.claimForReply, at the start *)
(*                                    of the concierge's turn for an owner *)
(*                                    message; the claimed notices go into *)
(*                                    the prompt                           *)
(*  ConciergeReply this.reply() then  the turn ends: a reply with model    *)
(*                 markDelivered()    text is stored and confirmDelivered; *)
(*                 or release()       otherwise releaseClaim               *)
(*  Restart        release()          the Notifier constructor releases    *)
(*                                    every claim; the turn is gone        *)
(*  Advance        the wall clock moves on (Clock.now() grows)             *)
(*                                                                         *)
(* Between ConciergeClaim and ConciergeReply the concierge awaits the model *)
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
    Concierge,     \* TRUE: the concierge's claim / reply path and restarts are in the model
    ReplyOutcomes  \* subset of {"stored", "partial", "none"}: how a concierge turn can end

NONE == -1          \* "no entry" in mutes / penalties (the key is absent)
Notices == 1..N
Urgencies == {"critical", "high", "normal", "low"}
Waiting == {"queued", "held"}                         \* isWaiting()
Final == {"delivered", "digested", "dropped", "expired"}
Statuses == {"none", "claimed"} \cup Waiting \cup Final  \* "none" = not offered yet

VARIABLES
    now,         \* Clock.now()
    lastTickAt,  \* GovernorState.lastTickAt
    pol,         \* the GovernorPolicy (fixed for a behavior)
    st,          \* Notice.status per notice id
    nt,          \* the rest of each Notice: effective, topic, dedupKey, createdAt, expiresAt,
                 \* claimedFrom (Notice.urgency is not read again after offer(), so it is left out)
    kept,        \* whether the notice is still in GovernorState.notices (tick() prunes history)
    interrupts,  \* GovernorState.interrupts (delivery slots of high/normal interrupts)
    criticals,   \* GovernorState.criticals
    mutes,       \* GovernorState.mutes: topic -> until, or NONE
    penalties,   \* GovernorState.penalties: topic -> until, or NONE
    busy,        \* the concierge is in a turn for an owner message
    peeked,      \* the ids that turn claimed and put into the prompt (const waiting = claimForReply())
    \* ghosts
    log,         \* every delivery to the owner: [n, at, how, muted]
    sends,       \* how many times each notice reached the owner (stops at 2)
    shown,       \* when a concierge turn last claimed each notice for its prompt, or NONE
    ownerMute    \* what the owner last said about each topic: muted until, or NONE

vars == <<now, lastTickAt, pol, st, nt, kept, interrupts, criticals, mutes, penalties,
          busy, peeked, log, sends, shown, ownerMute>>

NoNotice == [eff |-> "low", topic |-> "none", key |-> "none", createdAt |-> 0, expiresAt |-> 0,
             claimedFrom |-> "none"]

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
\* 0, 1 or more, so it stops at 2.
Bump(k) == Min2(k + 1, 2)

MutedNow(tp) == ownerMute[tp] > now
Delivery(n, how) == [n |-> n, at |-> now, how |-> how, muted |-> MutedNow(nt[n].topic)]

\* isWaiting(n) for a notice still in state.notices
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
    /\ shown = [n \in Notices |-> NONE]
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
         \* 2. duplicate of news delivered or waiting (or claimed), within the dedup window
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
                                     createdAt |-> now, expiresAt |-> now + dur, claimedFrom |-> "none"]]
         /\ kept' = [kept EXCEPT ![n] = TRUE]
         /\ criticals' = IF branch = "critical" THEN Append(criticals, now) ELSE criticals
         /\ interrupts' = IF branch = "interrupt" THEN Append(interrupts, now) ELSE interrupts
         /\ log' = IF status = "delivered"
                     THEN log \cup {[n |-> n, at |-> now, how |-> "alone", muted |-> MutedNow(tp)]}
                     ELSE log
         /\ sends' = IF status = "delivered" THEN [sends EXCEPT ![n] = Bump(@)] ELSE sends
         /\ UNCHANGED <<now, lastTickAt, pol, mutes, penalties, busy, peeked, shown, ownerMute>>

OfferAny ==
    \E n \in Notices, u \in Urgencies, tp \in Topics, k \in Keys, dur \in {pol.expiry} \cup CustomExpiry :
        Offer(n, u, tp, k, dur)

(***************************************************************************)
(* tick(): expire, then flush one digest when a digest time or the end of  *)
(* quiet hours was crossed since lastTickAt, then prune history. A claimed *)
(* notice is not isWaiting(), so tick() neither expires nor flushes it.    *)
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
        \* notices.filter((n) => isWaiting(n) || n.status === "claimed" || n.createdAt > now - HISTORY_MS)
        /\ kept' = [m \in Notices |-> kept[m] /\ (st2[m] \in Waiting \cup {"claimed"} \/ nt[m].createdAt > now - HistorySlots)]
        /\ interrupts' = SelectSeq(interrupts, LAMBDA t : t > now - D)
        /\ criticals' = SelectSeq(criticals, LAMBDA t : t > now - D)
        /\ mutes' = [t \in Topics |-> IF mutes[t] # NONE /\ mutes[t] > now THEN mutes[t] ELSE NONE]
        /\ penalties' = [t \in Topics |-> IF penalties[t] # NONE /\ penalties[t] > now THEN penalties[t] ELSE NONE]
        /\ lastTickAt' = now
        /\ log' = log \cup {Delivery(m, "digest") : m \in flushed}
        /\ sends' = [m \in Notices |-> IF m \in flushed THEN Bump(sends[m]) ELSE sends[m]]
        /\ UNCHANGED <<now, pol, nt, busy, peeked, shown, ownerMute>>

(* /digest: takeForReply() expires stale waiting notices first, then flushes the rest, and the
   daemon says them, in one call. *)
DigestCommand ==
    LET stale == {m \in Notices : IsWaiting(m) /\ nt[m].expiresAt <= now}
        flushed == {m \in Notices : IsWaiting(m) /\ m \notin stale}
    IN /\ stale \cup flushed # {}
       /\ st' = [m \in Notices |-> IF m \in flushed THEN "digested"
                                   ELSE IF m \in stale THEN "expired" ELSE st[m]]
       /\ log' = log \cup {Delivery(m, "command") : m \in flushed}
       /\ sends' = [m \in Notices |-> IF m \in flushed THEN Bump(sends[m]) ELSE sends[m]]
       /\ UNCHANGED <<now, lastTickAt, pol, nt, kept, interrupts, criticals, mutes, penalties,
                      busy, peeked, shown, ownerMute>>

(* Concierge, owner message: const waiting = this.s.notifier.claimForReply() -> claim(): every
   waiting, unexpired notice becomes "claimed" (claimedFrom = its status); the list goes into the
   prompt, then the turn awaits the model. *)
ConciergeClaim ==
    /\ Concierge
    /\ ~busy
    /\ LET c == {m \in Notices : IsWaiting(m) /\ nt[m].expiresAt > now}
       IN /\ busy' = TRUE
          /\ peeked' = c
          /\ st' = [m \in Notices |-> IF m \in c THEN "claimed" ELSE st[m]]
          /\ nt' = [m \in Notices |-> IF m \in c THEN [nt[m] EXCEPT !.claimedFrom = st[m]] ELSE nt[m]]
          /\ shown' = [m \in Notices |-> IF m \in c THEN now ELSE shown[m]]
    /\ UNCHANGED <<now, lastTickAt, pol, kept, interrupts, criticals, mutes, penalties,
                   log, sends, ownerMute>>

\* release(state, ids, now): every claimed notice among ids (still in state.notices) waits again,
\* as it was, unless its topic is muted now: then it is dropped (drop:muted), as mute() would have.
Released(ids) == {m \in ids : kept[m] /\ st[m] = "claimed"}
StAfterRelease(ids) ==
    [m \in Notices |-> IF m \in Released(ids)
                        THEN IF mutes[nt[m].topic] # NONE /\ mutes[nt[m].topic] > now
                               THEN "dropped"                \* (state.mutes[n.topic] ?? 0) > now
                               ELSE nt[m].claimedFrom        \* n.claimedFrom ?? "queued"
                        ELSE st[m]]
\* both release() and markDelivered() clear claimedFrom
NtClear(ids) == [m \in Notices |-> IF m \in ids THEN [nt[m] EXCEPT !.claimedFrom = "none"] ELSE nt[m]]

(* Concierge, the turn ends. outcome:
     "stored"  : the model wrote text, without error: this.reply(input, out) stores it, then
                 confirmDelivered(ids) -> markDelivered();
     "partial" : the model wrote text but r.error is set: the same (a stored reply counts as told);
     "none"    : no text (the error message is sent, without the notices) or a SILENT answer:
                 releaseClaim(ids) -> release().
   Assumption: a stored reply tells the owner every notice the prompt listed. *)
ConciergeReply(outcome) ==
    /\ busy
    /\ busy' = FALSE
    /\ peeked' = {}
    /\ LET told == IF outcome = "none" THEN {} ELSE peeked
           \* markDelivered(): ids that are claimed or waiting (and still in state.notices)
           marked == {m \in told : kept[m] /\ (st[m] = "claimed" \/ st[m] \in Waiting)}
       IN /\ log' = log \cup {Delivery(m, "reply") : m \in told}
          /\ sends' = [m \in Notices |-> IF m \in told THEN Bump(sends[m]) ELSE sends[m]]
          /\ st' = IF outcome = "none"
                     THEN StAfterRelease(peeked)
                     ELSE [m \in Notices |-> IF m \in marked THEN "digested" ELSE st[m]]
          /\ nt' = NtClear(IF outcome = "none" THEN Released(peeked) ELSE marked)
    /\ UNCHANGED <<now, lastTickAt, pol, kept, interrupts, criticals, mutes, penalties, shown, ownerMute>>

(* The daemon restarts during a turn: the turn is gone, and the new Notifier's constructor runs
   release(state) on the stored state, so every claimed notice waits again. *)
Restart ==
    /\ Concierge
    /\ busy
    /\ busy' = FALSE
    /\ peeked' = {}
    /\ st' = StAfterRelease(Notices)
    /\ nt' = NtClear(Released(Notices))
    /\ UNCHANGED <<now, lastTickAt, pol, kept, interrupts, criticals, mutes, penalties,
                   log, sends, shown, ownerMute>>

(* mute(): set the mute, drop waiting notices on the topic (a claimed notice is not waiting). *)
Mute(tp, dur) ==
    /\ mutes' = [mutes EXCEPT ![tp] = Until(now + dur)]
    /\ st' = [m \in Notices |-> IF IsWaiting(m) /\ nt[m].topic = tp THEN "dropped" ELSE st[m]]
    /\ ownerMute' = [ownerMute EXCEPT ![tp] = Until(now + dur)]
    /\ UNCHANGED <<now, lastTickAt, pol, nt, kept, interrupts, criticals, penalties, busy, peeked, log, sends, shown>>

(* unmute() *)
Unmute(tp) ==
    /\ mutes[tp] # NONE \/ ownerMute[tp] # NONE
    /\ mutes' = [mutes EXCEPT ![tp] = NONE]
    /\ ownerMute' = [ownerMute EXCEPT ![tp] = NONE]
    /\ UNCHANGED <<now, lastTickAt, pol, st, nt, kept, interrupts, criticals, penalties, busy, peeked, log, sends, shown>>

(* Notifier.dislike(noticeId): finds the notice in state.notices, then penalize(topic, now + 7d). *)
Penalize(n) ==
    /\ kept[n]
    /\ penalties' = [penalties EXCEPT ![nt[n].topic] = Until(now + PenaltySlots)]
    /\ UNCHANGED <<now, lastTickAt, pol, st, nt, kept, interrupts, criticals, mutes, busy, peeked, log, sends, shown, ownerMute>>

(* The wall clock moves on. Nothing in GovernorState changes until the next call. *)
Advance ==
    /\ now < MaxTime
    /\ now' = now + 1
    \* ghost normalisation: a mute that has run out is the same as no mute
    /\ ownerMute' = [t \in Topics |-> IF ownerMute[t] > now + 1 THEN ownerMute[t] ELSE NONE]
    /\ UNCHANGED <<lastTickAt, pol, st, nt, kept, interrupts, criticals, mutes, penalties, busy, peeked, log, sends, shown>>

ConciergeReplyAny == \E o \in ReplyOutcomes : ConciergeReply(o)
MuteAny     == Feedback /\ \E tp \in Topics, dur \in MuteFor : Mute(tp, dur)
UnmuteAny   == Feedback /\ \E tp \in Topics : Unmute(tp)
PenalizeAny == Feedback /\ \E n \in Notices : Penalize(n)

Next ==
    \/ OfferAny
    \/ Tick
    \/ DigestCommand
    \/ ConciergeClaim
    \/ ConciergeReplyAny
    \/ Restart
    \/ MuteAny
    \/ UnmuteAny
    \/ PenalizeAny
    \/ Advance

\* The daemon keeps ticking (every 30 s), the clock keeps moving, and a concierge turn ends.
Fairness == WF_vars(Tick) /\ WF_vars(Advance) /\ WF_vars(ConciergeReplyAny)

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
          busy, peeked, log, sends, shown, [t \in Topics |-> Live(ownerMute[t])]>>

-----------------------------------------------------------------------------
(* Properties. Each is the rule from docs/DESIGN.md, stated over what reached the owner. *)

TypeOK ==
    /\ now \in 0..MaxTime
    /\ st \in [Notices -> Statuses]
    /\ sends \in [Notices -> 0..2]
    /\ peeked \subseteq Notices

Alone == {e \in log : e.how = "alone" /\ nt[e.n].eff # "critical"}
Crit  == {e \in log : e.how = "alone" /\ nt[e.n].eff = "critical"}
\* Sends vigil starts on its own: "alone" and "digest". A concierge "reply" and the /digest
\* "command" are solicited: the owner wrote first.
Unsolicited == {e \in log : e.how \in {"alone", "digest"}}

\* Budget: in every rolling day, high/normal interrupts <= maxInterruptsPerDay, and two of them
\* are at least minGapMinutes apart.
Budget ==
    /\ \A e \in Alone : Cardinality({f \in Alone : f.at > e.at - D /\ f.at <= e.at}) <= pol.maxInt
    /\ \A e, f \in Alone : (e.n # f.n /\ e.at >= f.at) => e.at - f.at >= pol.minGap

\* CriticalCap: critical deliveries in every rolling day <= criticalPerDay.
CriticalCap ==
    \A e \in Crit : Cardinality({f \in Crit : f.at > e.at - D /\ f.at <= e.at}) <= pol.critCap

\* Quiet: nothing but critical reaches the owner unasked during quiet hours, digests included.
Quiet ==
    \A e \in Unsolicited : (e.how = "digest" \/ e \in Alone) => ~IsQuiet(e.at)

\* NoMuted: nothing vigil sends unasked (alone or in a digest) is on a topic the owner has muted.
\* A reply the owner asked for is solicited and exempt, like Quiet (owner decision, 2026-11-04).
NoMuted == \A e \in Unsolicited : ~e.muted

\* NoDuplicate: two notices that reached the owner never share a dedup key within the dedup window.
NoDuplicate ==
    \A e, f \in log :
        (e.n # f.n /\ nt[e.n].key = nt[f.n].key) =>
            (nt[e.n].createdAt - nt[f.n].createdAt >= pol.dedup \/ nt[f.n].createdAt - nt[e.n].createdAt >= pol.dedup)

\* Conservation: every offered notice has exactly one status, a waiting or claimed notice is never
\* forgotten, a notice reaches the owner at most once, and it reached the owner iff its status says so.
Conservation ==
    \A n \in Notices :
        /\ st[n] # "none" => st[n] \in Waiting \cup Final \cup {"claimed"}
        /\ st[n] \in Waiting \cup {"claimed"} => kept[n]
        /\ sends[n] <= 1
        /\ (sends[n] = 1) <=> (st[n] \in {"delivered", "digested"})

\* A final status never changes again.
FinalStable == [][\A n \in Notices : st[n] \in Final => st'[n] = st[n]]_vars

\* EventuallyResolved: every waiting or claimed notice is eventually delivered, digested, dropped
\* or expired.
EventuallyResolved == \A n \in Notices : (st[n] \in Waiting \cup {"claimed"}) ~> (st[n] \in Final)

\* NoStaleDelivery (not a DESIGN.md rule): nothing reaches the owner at or after its expiresAt.
\* For a concierge "reply" the time that counts is when the turn claimed the notice for its prompt:
\* claim() takes only unexpired notices, but one can expire while the model writes, and the reply
\* still tells it (characterized in README.md, not a finding).
NoStaleDelivery ==
    \A e \in log : IF e.how = "reply" THEN shown[e.n] < nt[e.n].expiresAt ELSE e.at < nt[e.n].expiresAt
=============================================================================
