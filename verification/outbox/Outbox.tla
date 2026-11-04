------------------------------- MODULE Outbox -------------------------------
(***************************************************************************)
(* vigil's outbox, as the code runs it.                                    *)
(*                                                                         *)
(* Code (see .claude/skills/verify-outbox/SKILL.md for the coverage        *)
(* record and sync commit):                                                *)
(*   src/core/outbox.ts   Outbox.enqueue (57-82), Outbox.deliverDue        *)
(*                        (85-102), Outbox.heldBack (104-113),             *)
(*                        Outbox.sendOne (115-165), BLOCKING_ATTEMPTS (40) *)
(*   src/agent/services.ts sendSolicited (69-98): the only caller that     *)
(*                        passes an orderKey, and only for ref.kind        *)
(*                        "ticket" (line 96)                               *)
(*   src/daemon.ts        start (162-204): deliverDue every 3 s (189),     *)
(*                        a channel that fails to start is deleted from    *)
(*                        the map the Outbox reads (172-175); say (404-    *)
(*                        408) and tryPair (505-506) call deliverDue ad    *)
(*                        hoc; so do concierge.ts:200 and panel.ts:117.    *)
(*                                                                         *)
(* Atomicity, as in the code:                                              *)
(*  - Node runs one piece of JavaScript at a time; code between two        *)
(*    awaits is one step.  The awaits in deliverDue/sendOne are            *)
(*    `await channel.send(...)` (outbox.ts:124) and `await this.sendOne`   *)
(*    (outbox.ts:96).  So a pass has these steps:                          *)
(*      PassStart  guard + SELECT + loop until the first await             *)
(*      SendReturns  channel.send settles; sendOne writes the DB, returns  *)
(*      Continue   deliverDue resumes; loop until the next await or end    *)
(*    Rows skipped by heldBack (`continue`, no await) are skipped inside   *)
(*    the same step.                                                       *)
(*  - enqueue is one Db.tx() (outbox.ts:61): one step, all parts at once.  *)
(*  - sendOne's success writes are one Db.tx() (outbox.ts:132-144).  Each  *)
(*    other sendOne branch is one UPDATE (the drop's db.event row is not   *)
(*    modelled).  So no step leaves the DB half-written, and a crash       *)
(*    (kill, power loss, or Daemon.stop closing the DB under an in-flight  *)
(*    send) can only fall between steps.  The one place where a crash      *)
(*    loses work is while `await channel.send` is pending: the message     *)
(*    may already be out, and the row still says pending.                 *)
(*  - The daemon's callers do `enqueue(); void deliverDue()` with no await *)
(*    between; the model lets other steps fall between them, which only    *)
(*    adds orders the code cannot take (safe for invariants).              *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*  - Time: "next_attempt_at is not after now" is the flag `due`.  A      *)
(*    failure or a missing channel clears it; BackoffElapses(r) sets it    *)
(*    again at any later moment ("eligible later"), in any order across    *)
(*    rows.                                                                *)
(*  - The channel's answer per attempt is chosen freely: success,          *)
(*    transient error, PermanentSendError; a missing channel is decided    *)
(*    per process lifetime (chanUp), as daemon.ts:174 does.  Bounds on     *)
(*    transient errors, drops and crashes are global, not per row.         *)
(*  - external_id is the delivery's number in `log`.                       *)
(*  - One channel and one conversation (the order keys of the code include *)
(*    both, services.ts:96).                                               *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Items,               \* the enqueue() calls in the order they happen, see Scenarios
    BLOCKING_ATTEMPTS,   \* outbox.ts:40 (3)
    MaxFails,            \* bound: transient send errors in one behavior
    MaxDrops,            \* bound: PermanentSendErrors in one behavior
    MaxCrashes,          \* bound: process deaths
    MaxPasses,           \* deliverDue calls that could be inside the loop at once
    Daemons,             \* 1; or 2 = two vigil processes on one database
    ChannelMayBeMissing, \* a channel can fail to start (daemon.ts:172-175)
    AmbiguousFailures    \* channel.send can throw after the message went out

ASSUME BLOCKING_ATTEMPTS \in Nat \ {0} /\ Daemons \in {1, 2}
ASSUME Daemons = 2 => MaxPasses = 2

NoKey == "none"                       \* order_key IS NULL
NItems == Len(Items)
RECURSIVE StartRow(_)
StartRow(g) == IF g = 1 THEN 1 ELSE StartRow(g - 1) + Items[g - 1].parts
NRows == StartRow(NItems) + Items[NItems].parts - 1
Rows == 1..NRows                      \* outbox.id, AUTOINCREMENT: ids follow enqueue order
RowsOf(g) == StartRow(g)..(StartRow(g) + Items[g].parts - 1)   \* the parts split() made
Grp == [r \in Rows |-> CHOOSE g \in 1..NItems : r \in RowsOf(g)]
Slots == 1..MaxPasses
DaemonOf(p) == IF Daemons = 1 THEN 1 ELSE p
ChanStates == IF ChannelMayBeMissing THEN BOOLEAN ELSE {TRUE}

\* services.ts:96: orderKey only for ref.kind "ticket"; notifier.ts:160, sessions.ts:92-98,
\* daemon.ts:269/406/505 pass none.
CallerKey(g) == IF Items[g].kind = "ticket" THEN Items[g].ticket ELSE NoKey
\* outbox.ts:60: item.orderKey, else `split:${now}:${Math.random()}` when split() made several parts, else null
OutboxKey(g) == IF CallerKey(g) # NoKey THEN CallerKey(g)
                ELSE IF Items[g].parts > 1 THEN "split:" \o Items[g].name ELSE NoKey
\* outbox.ts:134: if (row.ref_kind && row.ref_id). Every caller passes a ref.
HasRef(r) == Items[Grp[r]].kind # "none"

NoFlags == [ord |-> FALSE, split |-> FALSE, splitBA |-> FALSE, gap |-> FALSE, tkt |-> FALSE]
IdlePass == [ph |-> "idle", todo |-> <<>>, cur |-> 0, att |-> 0, fl |-> NoFlags]

VARIABLES
    enq,       \* enqueue() calls done so far
    status,    \* outbox.status ("none" = row not inserted yet)
    attempts,  \* outbox.attempts
    due,       \* outbox.next_attempt_at is not after Clock.now()
    okey,      \* outbox.order_key
    ext,       \* outbox.external_id (0 = NULL)
    refs,      \* message_refs: the external ids that have a row
    up,        \* the process is alive
    chanUp,    \* the channel is in the Map the Outbox reads (this lifetime)
    crashes, fails, drops,   \* bound counters
    pass,      \* in memory, per deliverDue call: where it is in its loop
    log        \* history: every delivery the owner received, in order

vars == <<enq, status, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, drops, pass, log>>
db == <<enq, status, attempts, due, okey, ext, refs>>

TypeOK ==
    /\ enq \in 0..NItems
    /\ status \in [Rows -> {"none", "pending", "failing", "sent", "dropped"}]
    /\ attempts \in [Rows -> Nat] /\ due \in [Rows -> BOOLEAN] /\ ext \in [Rows -> Nat]
    /\ refs \subseteq 1..Len(log)
    /\ \A p \in Slots : pass[p].ph \in {"idle", "sending", "returned", "ref"}
    /\ up \in BOOLEAN /\ chanUp \in BOOLEAN

Init ==
    /\ enq = 0
    /\ status = [r \in Rows |-> "none"]
    /\ attempts = [r \in Rows |-> 0]
    /\ due = [r \in Rows |-> FALSE]
    /\ okey = [r \in Rows |-> NoKey]
    /\ ext = [r \in Rows |-> 0]
    /\ refs = {}
    /\ up = TRUE
    /\ chanUp \in ChanStates
    /\ crashes = 0 /\ fails = 0 /\ drops = 0
    /\ pass = [p \in Slots |-> IdlePass]
    /\ log = <<>>

(***************************************************************************)
(* What the owner has seen, and the history flags the properties read.    *)
(* Each flag is decided when channel.send is called for row j: is there an *)
(* earlier row i that the owner has not received yet and that, by the      *)
(* rule in question, j should still wait for?                             *)
(***************************************************************************)
Delivered(i) == \E k \in DOMAIN log : log[k].row = i
Waiting(i) == status[i] # "none" /\ ~Delivered(i)
Exempt(i) == status[i] = "dropped" \/ attempts[i] >= BLOCKING_ATTEMPTS
SameSplit(i, j) == Grp[i] = Grp[j] /\ Items[Grp[i]].parts > 1
SameTicket(i, j) == Items[Grp[i]].ticket # "none" /\ Items[Grp[i]].ticket = Items[Grp[j]].ticket
FlagsFor(j) == [
    ord     |-> \E i \in Rows : i < j /\ okey[i] # NoKey /\ okey[i] = okey[j] /\ Waiting(i) /\ ~Exempt(i),
    split   |-> \E i \in Rows : i < j /\ SameSplit(i, j) /\ Waiting(i) /\ ~Exempt(i),
    splitBA |-> \E i \in Rows : i < j /\ SameSplit(i, j) /\ Waiting(i) /\ status[i] # "dropped",
    gap     |-> \E i \in Rows : i < j /\ SameSplit(i, j) /\ Waiting(i) /\ status[i] = "dropped",
    tkt     |-> \E i \in Rows : i < j /\ SameTicket(i, j) /\ Waiting(i) /\ ~Exempt(i)]
Entry(p, how) == [row |-> pass[p].cur, how |-> how] @@ pass[p].fl

(***************************************************************************)
(* Outbox.enqueue (outbox.ts:57-82): one Db.tx inserting every part.       *)
(***************************************************************************)
EnqueueWith(Key(_)) ==
    /\ up /\ enq < NItems
    /\ LET g == enq + 1 IN
       /\ enq' = g
       /\ status' = [r \in Rows |-> IF r \in RowsOf(g) THEN "pending" ELSE status[r]]
       /\ due' = [r \in Rows |-> IF r \in RowsOf(g) THEN TRUE ELSE due[r]]   \* next_attempt_at = now
       /\ okey' = [r \in Rows |-> IF r \in RowsOf(g) THEN Key(g) ELSE okey[r]]
    /\ UNCHANGED <<attempts, ext, refs, up, chanUp, crashes, fails, drops, pass, log>>

(***************************************************************************)
(* Outbox.heldBack (outbox.ts:104-113): an earlier row with the same key   *)
(* that is pending/failing and has fewer than BLOCKING_ATTEMPTS attempts.*)
(* Read fresh from the DB, not from the pass's snapshot.                   *)
(***************************************************************************)
CodeBlocks(i) == status[i] \in {"pending", "failing"} /\ attempts[i] < BLOCKING_ATTEMPTS
HeldBackWith(r, Blocks(_)) ==
    okey[r] # NoKey /\ \E i \in Rows : i < r /\ okey[i] = okey[r] /\ Blocks(i)

(***************************************************************************)
(* The deliverDue loop from `todo` up to its next await (outbox.ts:94-96). *)
(* Skips held rows, then either: sendOne finds no channel (UPDATE          *)
(* next_attempt_at = now + 60 s, return false, outbox.ts:118-121) and      *)
(* deliverDue awaits it; or channel.send is called and awaited             *)
(* (outbox.ts:124); or the loop ends and `finally` clears `running`        *)
(* (outbox.ts:98-100).  The row sent is the snapshot row: its status is    *)
(* not read again.                                                         *)
(***************************************************************************)
SegmentWith(p, todo, Blocks(_)) ==
    LET free == {k \in DOMAIN todo : ~HeldBackWith(todo[k].row, Blocks)} IN
    IF free = {} THEN
        /\ pass' = [pass EXCEPT ![p] = IdlePass]
        /\ UNCHANGED due
    ELSE
        LET k == CHOOSE m \in free : \A n \in free : m <= n
            e == todo[k]
            rest == SubSeq(todo, k + 1, Len(todo)) IN
        IF ~chanUp THEN
            /\ due' = [due EXCEPT ![e.row] = FALSE]
            /\ pass' = [pass EXCEPT ![p] = [IdlePass EXCEPT !.ph = "returned", !.todo = rest]]
        ELSE
            /\ pass' = [pass EXCEPT ![p] = [ph |-> "sending", todo |-> rest, cur |-> e.row,
                                            att |-> e.att, fl |-> FlagsFor(e.row)]]
            /\ UNCHANGED due

\* deliverDue(): `if (this.running) return 0` (outbox.ts:86) is per Outbox object, i.e. per process.
Running(p) == \E q \in Slots : DaemonOf(q) = DaemonOf(p) /\ pass[q].ph # "idle"
CodeSelected(r) == status[r] \in {"pending", "failing"}           \* outbox.ts:91
Snapshot(Selected(_)) ==
    LET ids == SelectSeq([r \in 1..NRows |-> r], LAMBDA r : Selected(r) /\ due[r])   \* ORDER BY id
    IN [k \in DOMAIN ids |-> [row |-> ids[k], att |-> attempts[ids[k]]]]

PassStartWith(p, Guarded, Selected(_), Blocks(_)) ==
    /\ up /\ pass[p].ph = "idle"
    \* With one process the slots are interchangeable: use the lowest free one.
    /\ Daemons = 1 => \A q \in Slots : q < p => pass[q].ph # "idle"
    /\ Guarded => ~Running(p)
    /\ SegmentWith(p, Snapshot(Selected), Blocks)
    /\ UNCHANGED <<enq, status, attempts, okey, ext, refs, up, chanUp, crashes, fails, drops, log>>

ContinueWith(p, Blocks(_)) ==        \* deliverDue resumes after `await this.sendOne(row)`
    /\ up /\ pass[p].ph = "returned"
    /\ SegmentWith(p, pass[p].todo, Blocks)
    /\ UNCHANGED <<enq, status, attempts, okey, ext, refs, up, chanUp, crashes, fails, drops, log>>

Returned(p) == [pass EXCEPT ![p] = [IdlePass EXCEPT !.ph = "returned", !.todo = pass[p].todo]]

(***************************************************************************)
(* sendOne after `await channel.send` settles (outbox.ts:131-164).         *)
(***************************************************************************)
\* Success: one Db.tx sets status 'sent', external_id, attempts = attempts + 1 (the DB value),
\* and writes message_refs (outbox.ts:132-144).  Atomic = FALSE is the mutant without the tx.
SucceedWith(p, Atomic) ==
    LET r == pass[p].cur
        d == Len(log) + 1 IN
    /\ up /\ pass[p].ph = "sending"
    /\ log' = Append(log, Entry(p, "recorded"))
    /\ status' = [status EXCEPT ![r] = "sent"]
    /\ attempts' = [attempts EXCEPT ![r] = @ + 1]
    /\ ext' = [ext EXCEPT ![r] = d]
    /\ IF Atomic
         THEN /\ refs' = IF HasRef(r) THEN refs \cup {d} ELSE refs
              /\ pass' = Returned(p)
         ELSE /\ refs' = refs
              /\ pass' = [pass EXCEPT ![p].ph = "ref"]
    /\ UNCHANGED <<enq, due, okey, up, chanUp, crashes, fails, drops>>

\* Transient error: attempts = row.attempts + 1 from the SNAPSHOT row, status 'failing' once it
\* reaches BLOCKING_ATTEMPTS, next_attempt_at = now + backoff (outbox.ts:153-162).
FailTransient(p) ==
    LET r == pass[p].cur
        a == pass[p].att + 1 IN
    /\ up /\ pass[p].ph = "sending" /\ fails < MaxFails
    /\ attempts' = [attempts EXCEPT ![r] = a]
    /\ status' = [status EXCEPT ![r] = IF a >= BLOCKING_ATTEMPTS THEN "failing" ELSE "pending"]
    /\ due' = [due EXCEPT ![r] = FALSE]
    /\ fails' = fails + 1
    /\ \/ log' = log
       \/ AmbiguousFailures /\ log' = Append(log, Entry(p, "error"))   \* it went out anyway
    /\ pass' = Returned(p)
    /\ UNCHANGED <<enq, okey, ext, refs, up, chanUp, crashes, drops>>

\* PermanentSendError: status 'dropped' (outbox.ts:148-151).
FailPermanent(p) ==
    LET r == pass[p].cur IN
    /\ up /\ pass[p].ph = "sending" /\ drops < MaxDrops
    /\ status' = [status EXCEPT ![r] = "dropped"]
    /\ drops' = drops + 1
    /\ pass' = Returned(p)
    /\ UNCHANGED <<enq, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, log>>

SendReturns(p) == SucceedWith(p, TRUE) \/ FailTransient(p) \/ FailPermanent(p)

\* Only in the mutant MutRefOutsideTx: the message_refs insert as its own statement.
RecordRef(p) ==
    LET r == pass[p].cur IN
    /\ up /\ pass[p].ph = "ref"
    /\ refs' = IF HasRef(r) THEN refs \cup {ext[r]} ELSE refs
    /\ pass' = Returned(p)
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, up, chanUp, crashes, fails, drops, log>>

(***************************************************************************)
(* Time, crash, restart.                                                   *)
(***************************************************************************)
BackoffElapses(r) ==
    /\ status[r] \in {"pending", "failing"} /\ ~due[r]
    /\ due' = [due EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<enq, status, attempts, okey, ext, refs, up, chanUp, crashes, fails, drops, pass, log>>

\* The process dies.  A send that was in flight may or may not have reached the owner; the DB
\* row still says pending (the crash window).  All in-memory state (running, the loop) is gone.
SortedSlots(D) == SelectSeq([q \in 1..MaxPasses |-> q], LAMBDA q : q \in D)
Crash ==
    /\ up /\ crashes < MaxCrashes
    /\ \E D \in SUBSET {p \in Slots : pass[p].ph = "sending"} :
         LET S == SortedSlots(D) IN
         log' = log \o [k \in DOMAIN S |-> Entry(S[k], "crash")]
    /\ up' = FALSE
    /\ crashes' = crashes + 1
    /\ pass' = [p \in Slots |-> IdlePass]
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, refs, chanUp, fails, drops>>

\* systemd Restart=always; Daemon.start (daemon.ts:162-204) re-creates the Outbox with
\* running = false and drops channels that fail to start.  The outbox table is untouched.
Restart ==
    /\ ~up
    /\ up' = TRUE
    /\ chanUp' \in ChanStates
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, refs, crashes, fails, drops, pass, log>>

Enqueue == EnqueueWith(OutboxKey)
PassStart(p) == PassStartWith(p, TRUE, CodeSelected, CodeBlocks)
Continue(p) == ContinueWith(p, CodeBlocks)

Next ==
    \/ Enqueue
    \/ \E p \in Slots : PassStart(p)
    \/ \E p \in Slots : SendReturns(p)
    \/ \E p \in Slots : Continue(p)
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart

Spec == Init /\ [][Next]_vars

\* The 3 s timer keeps calling deliverDue; channel.send always settles (an assumption: the
\* channels' own timeouts); time passes; systemd restarts the daemon.
Fairness ==
    /\ WF_vars(\E p \in Slots : PassStart(p))
    /\ WF_vars(\E p \in Slots : SendReturns(p))
    /\ WF_vars(\E p \in Slots : Continue(p))
    /\ \A r \in Rows : WF_vars(BackoffElapses(r))
    /\ WF_vars(Restart)
LiveSpec == Spec /\ Fairness

(***************************************************************************)
(* Properties.                                                             *)
(***************************************************************************)
\* For one order key, no message goes out while an earlier one with that key is still owed,
\* unless the earlier one was dropped or has BLOCKING_ATTEMPTS failed attempts.
OrderPreserved == \A k \in DOMAIN log : ~log[k].ord
\* The parts of one split message go out in order, with the same exception.
SplitPartsInOrder == \A k \in DOMAIN log : ~log[k].split
\* Apart from copies that went out just before a crash, the owner gets each message at most once.
AtMostOnceWithoutCrash ==
    \A r \in Rows : Cardinality({k \in DOMAIN log : log[k].row = r /\ log[k].how # "crash"}) <= 1
\* Every delivery that vigil recorded as sent, of a message with a ref, has its message_refs row
\* (so a reply to it is routed), except a write the current step has still to make (mutant only).
RefPending(k) == \E p \in Slots : pass[p].ph = "ref" /\ ext[pass[p].cur] = k
RefRecorded ==
    \A k \in DOMAIN log :
        (log[k].how = "recorded" /\ HasRef(log[k].row)) => (k \in refs \/ RefPending(k))
\* Every enqueued message is eventually sent or dropped.
NoLoss == \A r \in Rows : (status[r] \in {"pending", "failing"}) ~> (status[r] \in {"sent", "dropped"})

(* Characterizations: expected to FAIL on the current code; they state behavior plainly. *)
\* Split parts wait for a blocked earlier part only until it has BLOCKING_ATTEMPTS failures.
SplitPartsWaitForBlockedPart == \A k \in DOMAIN log : ~log[k].splitBA
\* No later part goes out after an earlier part was dropped.
SplitPartsNoGap == \A k \in DOMAIN log : ~log[k].gap
\* Strict at-most-once, crash window included.
NoDuplicates == \A r \in Rows : Cardinality({k \in DOMAIN log : log[k].row = r}) <= 1
\* Every copy the owner received of a message with a ref can be replied to.
EveryCopyRoutable == \A k \in DOMAIN log : HasRef(log[k].row) => k \in refs
(* Finding: DESIGN.md:69 "messages of one ticket to one conversation keep their order". *)
TicketMessagesInOrder == \A k \in DOMAIN log : ~log[k].tkt

(***************************************************************************)
(* Scenarios (the cfg substitutes one for Items).  kind is ref.kind;     *)
(* ticket is the ticket the message belongs to ("none" if none); parts is  *)
(* split()'s count.                                                        *)
(***************************************************************************)
\* Two results of ticket T (sendSolicited, key T) and one long concierge reply in two parts.
MainItems == <<
    [name |-> "blocked", kind |-> "ticket", ticket |-> "T", parts |-> 1],
    [name |-> "ready",   kind |-> "ticket", ticket |-> "T", parts |-> 1],
    [name |-> "reply",   kind |-> "reply",  ticket |-> "none", parts |-> 2] >>
\* ask_owner's question for ticket T (tools.ts:332, ref.kind "attention"), then T's report.
TicketItems == <<
    [name |-> "question", kind |-> "attention", ticket |-> "T", parts |-> 1],
    [name |-> "blocked",  kind |-> "ticket",    ticket |-> "T", parts |-> 1] >>
\* --deep: the question, both results and the long reply (five rows).
DeepItems == <<
    [name |-> "question", kind |-> "attention", ticket |-> "T", parts |-> 1],
    [name |-> "blocked",  kind |-> "ticket",    ticket |-> "T", parts |-> 1],
    [name |-> "ready",    kind |-> "ticket",    ticket |-> "T", parts |-> 1],
    [name |-> "reply",    kind |-> "reply",     ticket |-> "none", parts |-> 2] >>
=============================================================================
