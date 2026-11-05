------------------------------- MODULE Outbox -------------------------------
(***************************************************************************)
(* vigil's outbox, as the code runs it.                                    *)
(*                                                                         *)
(* Code (see .claude/skills/verify-outbox/SKILL.md for the coverage        *)
(* record and sync commit):                                                *)
(*   src/core/outbox.ts   Outbox.enqueue (59-84), Outbox.deliverDue        *)
(*                        (87-107: mayDeliver at 88 and before each row,   *)
(*                        99), Outbox.heldBack (109-118), Outbox.sendOne   *)
(*                        (120-174), BLOCKING_ATTEMPTS (40), withTimeout / *)
(*                        SEND_TIMEOUT_MS (191-208)                        *)
(*   src/agent/services.ts sendSolicited (69-103): orderKey for ref.kind   *)
(*                        "ticket", or when opts.ticketId is given (98-101)*)
(*   src/agent/tools.ts   report (309) and ask_owner (341, passes ticketId)*)
(*   src/agent/sessions.ts approval ask (94-108): the ticket's orderKey    *)
(*                        when the session has spec.ticketId (105); set by *)
(*                        workers (workers.ts:111) and by a ticket's helper*)
(*                        sessions (delegate.ts:31-44)                     *)
(*   src/daemon.ts        lockHolderAlive (63-82: /proc, else ps, else the *)
(*                        heartbeat), takeLock (196-207), holdsLock        *)
(*                        (210-212), heartbeatLock (215-222), start        *)
(*                        (224-272): lock first, mayDeliver = holdsLock    *)
(*                        (227), failed channels deleted (240), deliverDue *)
(*                        every 3 s (256), heartbeat every 30 s (257); say *)
(*                        (502-506) and tryPair (611-612) call deliverDue  *)
(*                        ad hoc; so do concierge.ts:233 and panel.ts:118. *)
(*  (Retry backoff from Clock.now() after the send, outbox.ts:168, is time *)
(*  the model abstracts: it only says the retry is due later.)             *)
(*                                                                         *)
(* Atomicity, as in the code:                                              *)
(*  - Node runs one piece of JavaScript at a time; code between two        *)
(*    awaits is one step.  The awaits in deliverDue/sendOne are            *)
(*    `await withTimeout(90 s, channel.send(...))` (outbox.ts:131) and     *)
(*    `await this.sendOne` (outbox.ts:101).  So a pass has these steps:     *)
(*      PassStart  guard + SELECT + loop until the first await             *)
(*      SendReturns  channel.send settles; sendOne writes the DB, returns  *)
(*      TimeoutFires  the 90 s timer rejects first; sendOne takes the      *)
(*                 transient-error path; channel.send keeps running and    *)
(*                 may still deliver later (an abandoned send)             *)
(*      Continue   deliverDue resumes; loop until the next await or end    *)
(*    Rows skipped by heldBack (`continue`, no await) are skipped inside   *)
(*    the same step.                                                       *)
(*  - enqueue is one Db.tx() (outbox.ts:63): one step, all parts at once.  *)
(*  - sendOne's success writes are one Db.tx() (outbox.ts:139-151).  Each  *)
(*    other sendOne branch is one UPDATE (the drop's db.event row is not   *)
(*    modelled).  So no step leaves the DB half-written, and a crash       *)
(*    (kill, power loss, or Daemon.stop closing the DB under an in-flight  *)
(*    send) can only fall between steps.  A crash loses work only while a  *)
(*    send is in flight: the message may already be out, and the row      *)
(*    still says pending.                                                  *)
(*  - takeLock is a getKv and a setKv inside one Db.tx (BEGIN IMMEDIATE,   *)
(*    daemon.ts:200-206): one step, also across processes.  The mutant         *)
(*    MutLockNoTx splits it.                                               *)
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
(*    transient error, PermanentSendError, slower than 90 s, or no answer  *)
(*    ever (Hang); a missing channel is decided per process lifetime       *)
(*    (chanUp), as daemon.ts:240 does.  Bounds on errors, drops, timeouts  *)
(*    and crashes are global, not per row.                                 *)
(*  - external_id is the delivery's number in `log`.                       *)
(*  - One channel and one conversation (the order keys of the code include *)
(*    both, services.ts:100, sessions.ts:105).                             *)
(*  - The lock: with Daemons = 1 it is an assumption: one daemon per home,*)
(*    and a restart takes over the dead pid's lock.  With Daemons = 2 it   *)
(*    is a guard, as the code does it: a second daemon refuses to start    *)
(*    while the holder runs (lockHolderAlive: a live node/vigil pid by     *)
(*    /proc or by `ps -p pid -o comm=`; only if both are unavailable,      *)
(*    ProcFs = FALSE, a heartbeat under 2 minutes old); deliverDue sends   *)
(*    only while holdsLock(), checked at pass start and before every row;  *)
(*    every 30 s the holder re-checks and a daemon that lost the lock      *)
(*    stops.  A live holder whose heartbeat looks stale (machine suspended *)
(*    over 2 min: Date.now() jumps, the 30 s timer on the monotonic clock  *)
(*    does not fire) is the environment step HeartbeatGoesStale.           *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Items,               \* the enqueue() calls in the order they happen, see Scenarios
    BLOCKING_ATTEMPTS,   \* outbox.ts:40 (3)
    MaxFails,            \* bound: transient send errors in one behavior
    MaxDrops,            \* bound: PermanentSendErrors in one behavior
    MaxTimeouts,         \* bound: sends the 90 s timeout gives up on
    MaxCrashes,          \* bound: process deaths (Daemons = 1 only)
    MaxPasses,           \* deliverDue calls that could be inside the loop at once
    Daemons,             \* 1; or 2 = vigil start and vigil chat on one home
    ProcFs,              \* /proc or ps can tell the holder runs: lockHolderAlive ignores the heartbeat
    MaxStale,            \* bound: times a live holder's heartbeat goes stale
    ChannelMayBeMissing, \* a channel can fail to start (daemon.ts:234-242)
    ChannelMayHang,      \* channel.send can never settle
    AmbiguousFailures    \* channel.send can throw after the message went out

ASSUME BLOCKING_ATTEMPTS \in Nat \ {0} /\ Daemons \in {1, 2}
ASSUME Daemons = 2 => (MaxPasses = 2 /\ MaxCrashes = 0)

NoKey == "none"                       \* order_key IS NULL
NItems == Len(Items)
RECURSIVE StartRow(_)
StartRow(g) == IF g = 1 THEN 1 ELSE StartRow(g - 1) + Items[g - 1].parts
NRows == StartRow(NItems) + Items[NItems].parts - 1
Rows == 1..NRows                      \* outbox.id, AUTOINCREMENT: ids follow enqueue order
RowsOf(g) == StartRow(g)..(StartRow(g) + Items[g].parts - 1)   \* the parts split() made
Grp == [r \in Rows |-> CHOOSE g \in 1..NItems : r \in RowsOf(g)]
Slots == 1..MaxPasses
Procs == 1..Daemons
DaemonOf(p) == IF Daemons = 1 THEN 1 ELSE p
ChanStates == IF ChannelMayBeMissing THEN BOOLEAN ELSE {TRUE}

\* services.ts:98-101: the ticket is ref.id for ref.kind "ticket", else opts.ticketId (ask_owner
\* passes it, tools.ts:341).  sessions.ts:105: the approval ask of a worker ("approval") and of a
\* ticket's helper session ("helper-approval", delegate.ts:40-41) carries the ticket's key.
\* notifier.ts:190 and daemon.ts:344/504/611 pass no orderKey.
TicketOf(g) == IF Items[g].kind \in {"ticket", "attention", "approval", "helper-approval"} THEN Items[g].ticket ELSE NoKey
CallerKey(g) == TicketOf(g)
\* outbox.ts:62: item.orderKey, else `split:${now}:${Math.random()}` when split() made several parts, else null
OutboxKey(g) == IF CallerKey(g) # NoKey THEN CallerKey(g)
                ELSE IF Items[g].parts > 1 THEN "split:" \o Items[g].name ELSE NoKey
\* outbox.ts:141: if (row.ref_kind && row.ref_id). Every caller passes a ref.
HasRef(r) == Items[Grp[r]].kind # "none"

NoFlags == [ord |-> FALSE, split |-> FALSE, splitBA |-> FALSE, gap |-> FALSE, tkt |-> FALSE, nolock |-> FALSE]
IdlePass == [ph |-> "idle", todo |-> <<>>, cur |-> 0, att |-> 0, fl |-> NoFlags]

VARIABLES
    enq,       \* enqueue() calls done so far
    status,    \* outbox.status ("none" = row not inserted yet)
    attempts,  \* outbox.attempts
    due,       \* outbox.next_attempt_at is not after Clock.now()
    okey,      \* outbox.order_key
    ext,       \* outbox.external_id (0 = NULL)
    refs,      \* message_refs: the external ids that have a row
    up,        \* the process is alive (Daemons = 1)
    chanUp,    \* the channel is in the Map the Outbox reads (this lifetime)
    crashes, fails, drops, timeouts, stale,   \* bound counters
    pass,      \* in memory, per deliverDue call: where it is in its loop
    orphans,   \* sends the timeout gave up on, still running in the channel: [row, fl]
    proc,      \* per daemon process: "off", "checked" (mutant only), "running", "refused", "stopped"
    lock,      \* kv 'daemon.lock': the daemon whose pid it names (0 = none)
    fresh,     \* its heartbeat is less than 2 minutes old
    log        \* history: every delivery the owner received, in order

vars == <<enq, status, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, drops,
          timeouts, stale, pass, orphans, proc, lock, fresh, log>>
lockVars == <<proc, lock, fresh, stale>>

TypeOK ==
    /\ enq \in 0..NItems
    /\ status \in [Rows -> {"none", "pending", "failing", "sent", "dropped"}]
    /\ attempts \in [Rows -> Nat] /\ due \in [Rows -> BOOLEAN] /\ ext \in [Rows -> Nat]
    /\ refs \subseteq 1..Len(log)
    /\ \A p \in Slots : pass[p].ph \in {"idle", "sending", "hung", "returned", "ref"}
    /\ proc \in [Procs -> {"off", "checked", "running", "refused", "stopped"}]
    /\ lock \in 0..Daemons /\ fresh \in BOOLEAN
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
    /\ crashes = 0 /\ fails = 0 /\ drops = 0 /\ timeouts = 0 /\ stale = 0
    /\ pass = [p \in Slots |-> IdlePass]
    /\ orphans = <<>>
    \* One daemon: it holds the lock (assumption).  Two: neither has started yet.
    /\ proc = [d \in Procs |-> IF Daemons = 1 THEN "running" ELSE "off"]
    /\ lock = IF Daemons = 1 THEN 1 ELSE 0
    /\ fresh = (Daemons = 1)
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
    tkt     |-> \E i \in Rows : i < j /\ SameTicket(i, j) /\ Waiting(i) /\ ~Exempt(i),
    nolock  |-> FALSE]   \* set in SegmentWithR: the sending daemon does not hold the lock
Entry(p, how) == [row |-> pass[p].cur, how |-> how] @@ pass[p].fl
OrphanEntry(o) == [row |-> o.row, how |-> "timeout"] @@ o.fl

\* The daemon process that runs pass slot p is alive.
Alive(p) == up /\ proc[DaemonOf(p)] = "running"
\* Some daemon process is serving (enqueue callers and timers live in one).
Serving == up /\ \E d \in Procs : proc[d] = "running"

(***************************************************************************)
(* Outbox.enqueue (outbox.ts:57-82): one Db.tx inserting every part.       *)
(***************************************************************************)
EnqueueWith(Key(_)) ==
    /\ Serving /\ enq < NItems
    /\ LET g == enq + 1 IN
       /\ enq' = g
       /\ status' = [r \in Rows |-> IF r \in RowsOf(g) THEN "pending" ELSE status[r]]
       /\ due' = [r \in Rows |-> IF r \in RowsOf(g) THEN TRUE ELSE due[r]]   \* next_attempt_at = now
       /\ okey' = [r \in Rows |-> IF r \in RowsOf(g) THEN Key(g) ELSE okey[r]]
    /\ UNCHANGED <<attempts, ext, refs, up, chanUp, crashes, fails, drops, timeouts, pass, orphans, log>>
    /\ UNCHANGED lockVars

(***************************************************************************)
(* Outbox.heldBack (outbox.ts:109-118): an earlier row with the same key   *)
(* that is pending/failing and has fewer than BLOCKING_ATTEMPTS attempts.*)
(* Read fresh from the DB, not from the pass's snapshot.                   *)
(***************************************************************************)
CodeBlocks(i) == status[i] \in {"pending", "failing"} /\ attempts[i] < BLOCKING_ATTEMPTS
HeldBackWith(r, Blocks(_)) ==
    okey[r] # NoKey /\ \E i \in Rows : i < r /\ okey[i] = okey[r] /\ Blocks(i)

(***************************************************************************)
(* The deliverDue loop from `todo` up to its next await (outbox.ts:96-101).*)
(* Skips held rows, then either: sendOne finds no channel (UPDATE          *)
(* next_attempt_at = now + 60 s, return false, outbox.ts:123-127) and      *)
(* deliverDue awaits it; or channel.send is called and awaited             *)
(* (outbox.ts:131); or the loop ends and `finally` clears `running`        *)
(* (outbox.ts:103-105).  The row sent is the snapshot row: its status is   *)
(* not read again.                                                         *)
(***************************************************************************)
\* Recheck: `if (!this.mayDeliver()) break;` before each row (outbox.ts:99).  Nothing changes the lock
\* inside one step, so the check before each row of this stretch is the same check.
SegmentWithR(p, todo, Blocks(_), Recheck) ==
    LET free == {k \in DOMAIN todo : ~HeldBackWith(todo[k].row, Blocks)} IN
    IF free = {} \/ (Recheck /\ todo # <<>> /\ lock # DaemonOf(p)) THEN
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
            /\ pass' = [pass EXCEPT ![p] = [ph |-> "sending", todo |-> rest, cur |-> e.row, att |-> e.att,
                                            fl |-> [FlagsFor(e.row) EXCEPT !.nolock = (lock # DaemonOf(p))]]]
            /\ UNCHANGED due
SegmentWith(p, todo, Blocks(_)) == SegmentWithR(p, todo, Blocks, TRUE)

\* deliverDue(): `if (this.running || !this.mayDeliver()) return 0` (outbox.ts:88): `running` is per
\* Outbox object, i.e. per process; mayDeliver is holdsLock() (daemon.ts:227), read at pass start and before each row.
Running(p) == \E q \in Slots : DaemonOf(q) = DaemonOf(p) /\ pass[q].ph # "idle"
CodeSelected(r) == status[r] \in {"pending", "failing"}           \* outbox.ts:93
Snapshot(Selected(_)) ==
    LET ids == SelectSeq([r \in 1..NRows |-> r], LAMBDA r : Selected(r) /\ due[r])   \* ORDER BY id
    IN [k \in DOMAIN ids |-> [row |-> ids[k], att |-> attempts[ids[k]]]]

PassStartWithR(p, Guarded, Selected(_), Blocks(_), Recheck) ==
    /\ Alive(p) /\ pass[p].ph = "idle"
    /\ lock = DaemonOf(p)                      \* mayDeliver()
    \* With one process the slots are interchangeable: use the lowest free one.
    /\ Daemons = 1 => \A q \in Slots : q < p => pass[q].ph # "idle"
    /\ Guarded => ~Running(p)
    /\ SegmentWithR(p, Snapshot(Selected), Blocks, Recheck)
    /\ UNCHANGED <<enq, status, attempts, okey, ext, refs, up, chanUp, crashes, fails, drops, timeouts, orphans, log>>
    /\ UNCHANGED lockVars
PassStartWith(p, Guarded, Selected(_), Blocks(_)) == PassStartWithR(p, Guarded, Selected, Blocks, TRUE)

ContinueWithR(p, Blocks(_), Recheck) ==        \* deliverDue resumes after `await this.sendOne(row)`
    /\ Alive(p) /\ pass[p].ph = "returned"
    /\ SegmentWithR(p, pass[p].todo, Blocks, Recheck)
    /\ UNCHANGED <<enq, status, attempts, okey, ext, refs, up, chanUp, crashes, fails, drops, timeouts, orphans, log>>
    /\ UNCHANGED lockVars
ContinueWith(p, Blocks(_)) == ContinueWithR(p, Blocks, TRUE)

Returned(p) == [pass EXCEPT ![p] = [IdlePass EXCEPT !.ph = "returned", !.todo = pass[p].todo]]

(***************************************************************************)
(* sendOne after its await settles (outbox.ts:131-173).                    *)
(***************************************************************************)
\* Success: one Db.tx sets status 'sent', external_id, attempts = attempts + 1 (the DB value),
\* and writes message_refs (outbox.ts:139-151).  Atomic = FALSE is the mutant without the tx.
SucceedWith(p, Atomic) ==
    LET r == pass[p].cur
        d == Len(log) + 1 IN
    /\ Alive(p) /\ pass[p].ph = "sending"
    /\ log' = Append(log, Entry(p, "recorded"))
    /\ status' = [status EXCEPT ![r] = "sent"]
    /\ attempts' = [attempts EXCEPT ![r] = @ + 1]
    /\ ext' = [ext EXCEPT ![r] = d]
    /\ IF Atomic
         THEN /\ refs' = IF HasRef(r) THEN refs \cup {d} ELSE refs
              /\ pass' = Returned(p)
         ELSE /\ refs' = refs
              /\ pass' = [pass EXCEPT ![p].ph = "ref"]
    /\ UNCHANGED <<enq, due, okey, up, chanUp, crashes, fails, drops, timeouts, orphans>>
    /\ UNCHANGED lockVars

\* The transient-error UPDATE (outbox.ts:160-171): attempts = row.attempts + 1 from the SNAPSHOT
\* row, status 'failing' once it reaches BLOCKING_ATTEMPTS, next_attempt_at = now + backoff.
RetryLater(p) ==
    LET r == pass[p].cur
        a == pass[p].att + 1 IN
    /\ attempts' = [attempts EXCEPT ![r] = a]
    /\ status' = [status EXCEPT ![r] = IF a >= BLOCKING_ATTEMPTS THEN "failing" ELSE "pending"]
    /\ due' = [due EXCEPT ![r] = FALSE]
    /\ pass' = Returned(p)

FailTransient(p) ==
    /\ Alive(p) /\ pass[p].ph = "sending" /\ fails < MaxFails
    /\ RetryLater(p)
    /\ fails' = fails + 1
    /\ \/ log' = log
       \/ AmbiguousFailures /\ log' = Append(log, Entry(p, "error"))   \* it went out anyway
    /\ UNCHANGED <<enq, okey, ext, refs, up, chanUp, crashes, drops, timeouts, orphans>>
    /\ UNCHANGED lockVars

\* PermanentSendError: status 'dropped' (outbox.ts:155-159).
FailPermanent(p) ==
    LET r == pass[p].cur IN
    /\ Alive(p) /\ pass[p].ph = "sending" /\ drops < MaxDrops
    /\ status' = [status EXCEPT ![r] = "dropped"]
    /\ drops' = drops + 1
    /\ pass' = Returned(p)
    /\ UNCHANGED <<enq, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, timeouts, orphans, log>>
    /\ UNCHANGED lockVars

SendReturns(p) == SucceedWith(p, TRUE) \/ FailTransient(p) \/ FailPermanent(p)

\* The channel will never answer this attempt (outbox.ts:129-130's case).  Leaves budget for the
\* timeout so it can always fire.
Hang(p) ==
    /\ ChannelMayHang /\ Alive(p) /\ pass[p].ph = "sending" /\ timeouts < MaxTimeouts
    /\ pass' = [pass EXCEPT ![p].ph = "hung"]
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, drops,
                   timeouts, orphans, log>>
    /\ UNCHANGED lockVars

\* withTimeout rejects after SEND_TIMEOUT_MS (outbox.ts:191-208): the transient-error path.  The
\* channel.send promise is not cancelled: it stays in `orphans` and may still deliver.
TimeoutFires(p) ==
    /\ Alive(p) /\ pass[p].ph \in {"sending", "hung"} /\ timeouts < MaxTimeouts
    /\ RetryLater(p)
    /\ timeouts' = timeouts + 1
    /\ orphans' = Append(orphans, [row |-> pass[p].cur, fl |-> pass[p].fl])
    /\ UNCHANGED <<enq, okey, ext, refs, up, chanUp, crashes, fails, drops, log>>
    /\ UNCHANGED lockVars

\* Only in the mutant MutRefOutsideTx: the message_refs insert as its own statement.
RecordRef(p) ==
    LET r == pass[p].cur IN
    /\ Alive(p) /\ pass[p].ph = "ref"
    /\ refs' = IF HasRef(r) THEN refs \cup {ext[r]} ELSE refs
    /\ pass' = Returned(p)
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, up, chanUp, crashes, fails, drops, timeouts, orphans, log>>
    /\ UNCHANGED lockVars

(***************************************************************************)
(* An abandoned send settles: it delivered (nothing records it: the        *)
(* withTimeout promise already rejected), or it failed.                    *)
(***************************************************************************)
Without(s, i) == [j \in 1..(Len(s) - 1) |-> IF j < i THEN s[j] ELSE s[j + 1]]
OrphanLands(i) ==
    /\ up
    /\ log' = Append(log, OrphanEntry(orphans[i]))
    /\ orphans' = Without(orphans, i)
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, drops, timeouts, pass>>
    /\ UNCHANGED lockVars
OrphanFails(i) ==
    /\ up
    /\ orphans' = Without(orphans, i)
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, drops, timeouts, pass, log>>
    /\ UNCHANGED lockVars

(***************************************************************************)
(* Time, crash, restart.                                                   *)
(***************************************************************************)
BackoffElapses(r) ==
    /\ status[r] \in {"pending", "failing"} /\ ~due[r]
    /\ due' = [due EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<enq, status, attempts, okey, ext, refs, up, chanUp, crashes, fails, drops, timeouts, pass, orphans, log>>
    /\ UNCHANGED lockVars

\* The process dies.  A send in flight, or abandoned and still running, may or may not have
\* reached the owner; the DB row still says pending (the crash window).  In-memory state (running,
\* the loop, the pending channel.send promises) is gone.
SortedSlots(D) == SelectSeq([q \in 1..MaxPasses |-> q], LAMBDA q : q \in D)
SortedIdx(D) == SelectSeq([q \in 1..Len(orphans) |-> q], LAMBDA q : q \in D)
Crash ==
    /\ up /\ crashes < MaxCrashes
    /\ \E D \in SUBSET {p \in Slots : pass[p].ph \in {"sending", "hung"}},
          O \in SUBSET DOMAIN orphans :
         LET S == SortedSlots(D)
             T == SortedIdx(O) IN
         log' = log \o [k \in DOMAIN S |-> Entry(S[k], "crash")]
                    \o [k \in DOMAIN T |-> OrphanEntry(orphans[T[k]])]
    /\ up' = FALSE
    /\ crashes' = crashes + 1
    /\ pass' = [p \in Slots |-> IdlePass]
    /\ orphans' = <<>>
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, refs, chanUp, fails, drops, timeouts>>
    /\ UNCHANGED lockVars

\* systemd Restart=always; Daemon.start (daemon.ts:224-272) takes the dead pid's lock, re-creates
\* the Outbox with running = false and drops channels that fail to start.  The outbox table is
\* untouched.
Restart ==
    /\ ~up
    /\ up' = TRUE
    /\ chanUp' \in ChanStates
    /\ UNCHANGED <<enq, status, attempts, due, okey, ext, refs, crashes, fails, drops, timeouts, pass, orphans, log>>
    /\ UNCHANGED lockVars

(***************************************************************************)
(* The lock, Daemons = 2 (daemon.ts:63-82, 196-222, 227, 257, 932).        *)
(***************************************************************************)
\* lockHolderAlive: the holder's pid runs node/vigil (/proc, else ps), or, with neither, its heartbeat is fresh.
HolderAlive == lock # 0 /\ proc[lock] = "running" /\ (ProcFs \/ fresh)
\* `if (lock && lock.pid !== process.pid && lockHolderAlive(lock)) throw` (daemon.ts:202)
Refuses(d) == lock # 0 /\ lock # d /\ HolderAlive
LockFree == UNCHANGED <<enq, status, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, drops, timeouts, pass, orphans, log>>
\* takeLock: getKv, check, setKv in one Db.tx (BEGIN IMMEDIATE): one step even across processes.
\* Checked = FALSE is the mutant without takeLock(); Split = TRUE the mutant without the tx.
TakeLockWith(d, Checked, Split) ==
    /\ Daemons = 2 /\ proc[d] = "off" /\ ~Split
    /\ IF Checked /\ Refuses(d)
         THEN proc' = [proc EXCEPT ![d] = "refused"] /\ UNCHANGED <<lock, fresh>>
         ELSE proc' = [proc EXCEPT ![d] = "running"] /\ lock' = d /\ fresh' = TRUE
    /\ UNCHANGED stale /\ LockFree
\* Split = TRUE: the getKv ...
CheckLockWith(d, Checked, Split) ==
    /\ Daemons = 2 /\ proc[d] = "off" /\ Split
    /\ proc' = [proc EXCEPT ![d] = IF Checked /\ Refuses(d) THEN "refused" ELSE "checked"]
    /\ UNCHANGED <<lock, fresh, stale>> /\ LockFree
\* ... then the setKv, whatever happened in between.
WriteLock(d) ==
    /\ proc[d] = "checked"
    /\ proc' = [proc EXCEPT ![d] = "running"] /\ lock' = d /\ fresh' = TRUE
    /\ UNCHANGED stale /\ LockFree
\* heartbeatLock every 30 s (daemon.ts:215-222): still mine -> refresh the row; lost it -> stop().
\* Recheck = FALSE is the mutant that only refreshes (the code before 4f5ff60).  stop() closes the
\* DB under any send in flight: like a crash for that send (the copy may be out, nothing records it).
HeartbeatWith(d, Recheck) ==
    /\ Daemons = 2 /\ proc[d] = "running"
    /\ IF lock = d \/ ~Recheck
         THEN /\ (lock # d \/ ~fresh)
              /\ lock' = d /\ fresh' = TRUE
              /\ UNCHANGED <<proc, stale>> /\ LockFree
         ELSE /\ proc' = [proc EXCEPT ![d] = "stopped"]
              /\ \E D \in SUBSET {p \in Slots : DaemonOf(p) = d /\ pass[p].ph \in {"sending", "hung"}} :
                   LET S == SortedSlots(D) IN log' = log \o [k \in DOMAIN S |-> Entry(S[k], "crash")]
              /\ pass' = [p \in Slots |-> IF DaemonOf(p) = d THEN IdlePass ELSE pass[p]]
              /\ UNCHANGED <<lock, fresh, stale>>
              /\ UNCHANGED <<enq, status, attempts, due, okey, ext, refs, up, chanUp, crashes, fails, drops, timeouts, orphans>>
\* The holder is alive but its lock row is over 2 minutes old by Date.now().
HeartbeatGoesStale ==
    /\ Daemons = 2 /\ stale < MaxStale /\ lock # 0 /\ fresh
    /\ fresh' = FALSE /\ stale' = stale + 1
    /\ UNCHANGED <<proc, lock>> /\ LockFree

LockStepsWith(Checked, Split, Recheck) ==
    \/ \E d \in Procs : TakeLockWith(d, Checked, Split) \/ CheckLockWith(d, Checked, Split)
                        \/ WriteLock(d) \/ HeartbeatWith(d, Recheck)
    \/ HeartbeatGoesStale
LockSteps == LockStepsWith(TRUE, FALSE, TRUE)

Enqueue == EnqueueWith(OutboxKey)
PassStart(p) == PassStartWith(p, TRUE, CodeSelected, CodeBlocks)
Continue(p) == ContinueWith(p, CodeBlocks)
SendSettles(p) == SendReturns(p) \/ TimeoutFires(p)
Orphans == \E i \in DOMAIN orphans : OrphanLands(i) \/ OrphanFails(i)

Next ==
    \/ Enqueue
    \/ \E p \in Slots : PassStart(p)
    \/ \E p \in Slots : SendSettles(p) \/ Hang(p)
    \/ \E p \in Slots : Continue(p)
    \/ Orphans
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
    \/ LockSteps

Spec == Init /\ [][Next]_vars

\* The 3 s timer keeps calling deliverDue; every awaited send settles or its 90 s timer fires (the
\* channel itself may hang forever); time passes; systemd restarts the daemon.
Fairness ==
    /\ WF_vars(\E p \in Slots : PassStart(p))
    /\ WF_vars(\E p \in Slots : SendSettles(p))
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
\* DESIGN.md:69: messages of one ticket to one conversation keep their order (same exception).
TicketMessagesInOrder == \A k \in DOMAIN log : ~log[k].tkt
\* Apart from copies whose send vigil lost track of (in flight at a crash, or abandoned by the
\* 90 s timeout), the owner gets each message at most once.
AtMostOnceWithoutCrashOrTimeout ==
    \A r \in Rows : Cardinality({k \in DOMAIN log : log[k].row = r /\ log[k].how \notin {"crash", "timeout"}}) <= 1
\* With two daemons: a daemon starts a send only while it holds the lock (outbox.ts:88, 99).  The
\* send already in flight when the lock moves is not covered (see NoPidCheckInFlightResend).
SendsOnlyWithLock == \A k \in DOMAIN log : ~log[k].nolock
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
\* At most once, with only the crash window excused (the timeout window is not).
AtMostOnceWithoutCrash ==
    \A r \in Rows : Cardinality({k \in DOMAIN log : log[k].row = r /\ log[k].how # "crash"}) <= 1
\* Strict at-most-once, crash window included.
NoDuplicates == \A r \in Rows : Cardinality({k \in DOMAIN log : log[k].row = r}) <= 1
\* Every copy the owner received of a message with a ref can be replied to.
EveryCopyRoutable == \A k \in DOMAIN log : HasRef(log[k].row) => k \in refs

(***************************************************************************)
(* Scenarios (the cfg substitutes one for Items).  kind is ref.kind;     *)
(* ticket is the ticket the message belongs to ("none" if none); parts is  *)
(* split()'s count.                                                        *)
(***************************************************************************)
\* Ticket T: ask_owner's question (tools.ts:341), then its "blocked" report (tools.ts:309);
\* then one long concierge reply in two parts.
MainItems == <<
    [name |-> "question", kind |-> "attention", ticket |-> "T", parts |-> 1],
    [name |-> "blocked",  kind |-> "ticket",    ticket |-> "T", parts |-> 1],
    [name |-> "reply",    kind |-> "reply",     ticket |-> "none", parts |-> 2] >>
\* Ticket T asks a question, then a risky tool call asks for approval in T's chat
\* (sessions.ts:94-108, workers.ts:111-113).
ApprovalItems == <<
    [name |-> "question", kind |-> "attention", ticket |-> "T", parts |-> 1],
    [name |-> "approve",  kind |-> "approval",  ticket |-> "T", parts |-> 1] >>
\* The same, but the approval ask comes from the ticket's helper session (delegate.ts:31-44).
HelperItems == <<
    [name |-> "question", kind |-> "attention",       ticket |-> "T", parts |-> 1],
    [name |-> "approve",  kind |-> "helper-approval", ticket |-> "T", parts |-> 1] >>
\* Two messages, for the two-daemon checks.
PairItems == <<
    [name |-> "question", kind |-> "attention", ticket |-> "T", parts |-> 1],
    [name |-> "blocked",  kind |-> "ticket",    ticket |-> "T", parts |-> 1] >>
\* --deep: the question, both results and the long reply (five rows).
DeepItems == <<
    [name |-> "question", kind |-> "attention", ticket |-> "T", parts |-> 1],
    [name |-> "blocked",  kind |-> "ticket",    ticket |-> "T", parts |-> 1],
    [name |-> "ready",    kind |-> "ticket",    ticket |-> "T", parts |-> 1],
    [name |-> "reply",    kind |-> "reply",     ticket |-> "none", parts |-> 2] >>
=============================================================================
