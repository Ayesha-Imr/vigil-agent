---
name: verify-outbox
description: Model-check vigil's outbox (src/core/outbox.ts enqueue, deliverDue, heldBack, sendOne, the 90 s send timeout) and the one-daemon-per-home lock with TLA+/TLC. Use before handing off any change to how outbound messages are stored, ordered, retried, timed out, dropped or recorded (outbox.ts, the orderKey in services.ts sendSolicited and the approval ask in sessions.ts, the deliverDue callers and takeLock/heartbeatLock/mayDeliver in daemon.ts, Db.tx, the message_refs write), and when someone asks whether vigil can send a message twice, out of order, or never.
---

# Verify the outbox

Every message vigil sends goes through `Outbox`: `enqueue` stores it (split into parts if it is
long), `deliverDue` sends what is due every 3 s and on demand, with retries and a 90 s timeout per
send. One daemon per home is enforced by a lock row. Tests cover single paths. This check is a
TLA+ model of that code; TLC tries every order of enqueues, overlapping `deliverDue` calls,
chat-app answers (success, try-later, refused for good, slower than 90 s, never), channel not
running, retry timers, crashes, restarts and a second daemon, within small bounds.

## The properties

| Property | Rule (one sentence) | Harm if broken (one sentence) |
| --- | --- | --- |
| `OrderPreserved` | For one order key, a message never goes out while an earlier one with that key is still owed, unless the earlier one was dropped or has `BLOCKING_ATTEMPTS` (3) failed attempts. | The owner reads a ticket's "⏸ blocked" before its question, or a reply before the message it follows. |
| `SplitPartsInOrder` | The parts of one long message go out in order, with the same exception. | The owner gets the second half of a message before the first. |
| `TicketMessagesInOrder` | The messages of one ticket to one chat (results, `ask_owner` questions, the approval asks of its worker and helpers) go out in the order queued, with the same exception (DESIGN.md:69). | The owner sees "blocked" or an approval request before the question it depends on. |
| `AtMostOnceWithoutCrashOrTimeout` | Apart from a copy whose send vigil lost track of (in flight when the process died or stopped, or abandoned by the 90 s timeout), the owner gets each message at most once. | The owner's phone buzzes twice for one message. |
| `SendsOnlyWithLock` | With two daemons on one home, a daemon starts a send only while it holds the lock (checked at pass start and before each row). | A daemon that lost the lock keeps sending its pass, and the owner gets messages twice. |
| `RefRecorded` | Every delivery vigil recorded as sent, of a message with a ref, has its `message_refs` row. | The owner replies to a ticket's message and the reply is not routed to the ticket. |
| `NoLoss` (liveness) | Every enqueued message is eventually sent or dropped, assuming the channel is running and try-later errors, timeouts and hangs eventually stop; a hung `channel.send` is rescued by the 90 s timeout. | A message waits forever and the owner never hears it. |

In the model, "owed" means the earlier row is inserted and the owner has not received any copy
of it. The order properties are history flags, set at the moment `channel.send` is called.

## Run it

```sh
bash verification/outbox/check.sh            # about 1 min
bash verification/outbox/check.sh --deep     # three larger runs on top, several more minutes
bash verification/outbox/check.sh --trace mutants/MutMayDeliverOnce.cfg   # print one counterexample
```

Needs Java 11 or later and `tla2tools.jar`; set `TLA2TOOLS=/path/to/tla2tools.jar` if it is not
at `/home/user/tools/tla2tools.jar`. Last confirmed with TLC 2026.11.03.180953 (rev 309e489),
jar sha256 `e20447644bfabd29d6bd0fc2c0eb1473fb301c1a0e4dfe1961938ce5a191edbf`, OpenJDK 21.

Every line is `PASS` or `FAIL`, and the script exits 1 on any `FAIL`. Each TLC run is cut off after
`OUTBOX_TLC_TIMEOUT` seconds (default 300) and then counts as `FAIL`: a change that makes the
state space explode shows up instead of hanging. Expected today, all `PASS`:

- current code, no error: `Outbox.cfg` (safety, 671,632 distinct states), `OutboxLive.cfg`
  (liveness, 71,014), `fixed/TwoDaemonsLocked.cfg` (505), `fixed/ApprovalAskInOrder.cfg` (539),
  `fixed/HelperApprovalInOrder.cfg` (539), `fixed/StaleTakeoverStopsSending.cfg` (1,839).
  `--deep` adds `OutboxDeep.cfg` (1,656,967), `OutboxDeepRows.cfg` (2,598,494),
  `OutboxLiveDeep.cfg` (193,181) (last run at 42caa19; not rerun at the sync commit).
- twelve mutants, each violating its own property (see "Mutants").
- no open findings; eight characterizations still show their violation. For these, `PASS`
  means "still reproduced", not "fine".

## Trace validation (the real code against the model)

The model check proves the rules for `Outbox.tla`. Trace validation checks that the real
`outbox.ts` behaves like `Outbox.tla`:

```sh
bash verification/outbox/trace/check.sh             # 100 traces + 8 mutants, about 30 s
bash verification/outbox/trace/check.sh --count 1000 --seed 10000 --group-size 50 --no-mutants
bash verification/outbox/trace/check.sh --replay verification/out/outbox-trace/code/traces/g01-trace-0001.ndjson
bash verification/run.sh --trace                    # with the governor's trace check
```

`trace/record.ts` drives a real `Outbox` on a real in-memory `Db` with a `ManualClock` and a
scripted channel. It answers each `send()` by hand: ok, try-later, `PermanentSendError`, or the
90 s timer fires, after which the abandoned send lands or fails. It calls `enqueue` and
`deliverDue`, including while a pass is in flight, moves the clock, and crashes and restarts (a
new `Outbox` on the same `Db`). It does not change `src/`: it wraps the `Db` instance's
`run`/`tx`/`all`, the channel and `setTimeout`. Each line is one model step with the state read
from the DB and the passes. `trace/OutboxTrace.tla` accepts a trace only if every line is a step
of `Next` that leaves the same state and the same deliveries. Expected: every trace `PASS`, and
every mutant (heldBack due-only, no running guard, refs outside the tx, no split key,
pending-only, no send timeout, failing one attempt late, a recorder that drops an enqueue line)
rejected with its first unmatched step printed.

The line names and their actions: `enqueue` = `EnqueueWith`, `pass-start` = `PassStartWith`,
`continue` = `ContinueWith`, `succeed`/`fail`/`drop`/`timeout` = `SucceedWith`/`FailTransient`/
`FailPermanent`/`TimeoutFires`, `backoff` = `BackoffElapses`, `orphan-lands`/`orphan-fails`,
`crash`, `restart`. `deliver-noop` (the `running` guard returned at once) is a stutter. Two code
facts that make one code step two model steps:
- Before the F3 fix, sendOne computed the backoff from the `now` it read before its await, so a
  slow send wrote a retry that was already due. The trace logs `fail`/`timeout` without checking
  that row's `due`, then `backoff` at once when the row is due; since the fix (backoff counted from
  `this.clock.now()` after the send) that composed step is rarely taken, but it stays allowed.
- A pass over a missing channel runs its whole loop in one macrotask. The model takes one step per
  row; the trace logs each.

A rejected trace means the code did something the model does not allow, or the mapping is wrong.
Read the printed `<<variable, model, code>>` diff, then decide as in "Model error or bug?". The
mapping (`abs()`, where `onSend`/`onWrite`/`onFinished` cut lines) is a suspect too. Not traced:
the lock and two daemons, the real callers' order keys (the recorder copies them), channel
internals, the message content, a helper's approval ask (F1c), and a send that throws after
delivering. See verification/README.md, "Trace validation of the outbox".

## Does my change touch this?

Coverage record. Sync commit: `8a72cccba7819f6087fb9c8523688648cc3ee769` (the commit at
which the model was last confirmed to describe the code below; every channel, including
Slack and Signal, is the same abstract `Channel.send` to the model).

| File | What the model takes from it | Lines at sync commit |
| --- | --- | --- |
| `src/core/outbox.ts` | `BLOCKING_ATTEMPTS` | 40 |
| | `Outbox.enqueue`: one `Db.tx`, all parts; the generated `split:` key | 59-84 (key: 62) |
| | `Outbox.deliverDue`: `running` guard and `mayDeliver()` at pass start and before each row, due `SELECT ... ORDER BY id` snapshot, loop, `finally` | 87-107 (88, 92-95, 99) |
| | `Outbox.heldBack`: earlier same-key row, pending/failing, attempts below the limit, read fresh | 109-118 |
| | `Outbox.sendOne`: missing channel, `await withTimeout(channel.send)`, success tx with `message_refs`, `PermanentSendError` drop, transient retry from the snapshot's `attempts` (backoff from `clock.now()` after the send, 168: time the model abstracts) | 120-174 |
| | `withTimeout` / `SEND_TIMEOUT_MS`: rejects after 90 s, does not cancel the send | 191-208 |
| `src/channels/types.ts` | `PermanentSendError`; `Channel.send` | 54, 60 |
| `src/agent/services.ts` | `sendSolicited`: orderKey `${ticket}:${channel}:${conversation}` for `ref.kind "ticket"` or `opts.ticketId` | 69-103 (key: 98-101) |
| `src/agent/tools.ts` | `report` (ref ticket), `ask_owner` (ref attention, passes `ticketId`) | 309, 341 |
| `src/agent/sessions.ts` | approval `ask`: the ticket's orderKey when `spec.ticketId` is set | 94-108 (key: 105) |
| `src/agent/workers.ts` | worker sessions set `ticketId`; the delegate tool gets the ticket's route | 111, 109 |
| `src/agent/delegate.ts` | a ticket's helper session passes `ticketId` and `approvalRoute` | 31-43 (40-41) |
| `src/core/notifier.ts` | `send`: enqueue with no orderKey | 184-197 |
| `src/daemon.ts` | `lockHolderAlive` (live node/vigil pid via /proc, else `ps -p pid -o comm=`, else a heartbeat under 2 min) | 63-82 |
| | `takeLock` (one `Db.tx`), `holdsLock`, `heartbeatLock` (refresh, or stop if lost) | 196-207, 210-212, 215-222 |
| | `start`: takeLock, `mayDeliver = holdsLock`, failed channels deleted, `every(3_000, deliverDue)`, `every(30_000, heartbeatLock)` | 224-272 (226, 227, 240, 256, 257) |
| | ad hoc `deliverDue`: `say`, `tryPair`; enqueue in `runJob` remind; `stop` releases the lock | 502-506, 611-612, 344 (no route: notifier, no key), 923-933 |
| `src/agent/concierge.ts`, `src/panel/panel.ts` | ad hoc `deliverDue` | 233, 118 |
| `src/store/db.ts` | `Db.tx` (BEGIN IMMEDIATE; nested joins outer), `outbox` and `message_refs` tables, kv | 208-229, 80-97 (+ migration 162), 145-152, 245-257 |
| `src/cli.ts` | `vigil chat` starts an embedded daemon on the same home | 377-388 |

Run `git diff 8a72cccba7819f6087fb9c8523688648cc3ee769 -- <files above>`. If the diff touches
any of those functions, adds an `outbox.enqueue` caller with or without an `orderKey` for a
ticket, or adds an `await` inside `deliverDue`/`sendOne`/`takeLock`, re-read the matching part of
`verification/outbox/Outbox.tla` before trusting a `PASS`. Not covered at all: `split()`'s
cutting (211-225; the model only uses the number of parts), `lookupRef`, `problems`, and the
channels' own `send` code.

## Reading a result

- Read every TLC result with the pstack `/statechart` skill: it gives the shortest path to each
  broken rule in plain words, and draws the state chart when the check passes. Use the TLC jar
  above. With this TLC build `/statechart` could not read this spec: its SANY XML reader stopped
  with `Cannot read properties of undefined (reading 'tag')` on comments inside TLC's standard
  `Sequences` module (they contain `<<`). That is the tool, not the model; until it is fixed, use
  `check.sh --trace <cfg>`, which prints the same shortest path from TLC.
- Steps, as the trace names them, and the code they stand for:

| Trace step | Code |
| --- | --- |
| `EnqueueWith` | `Outbox.enqueue` (outbox.ts:59-84): inserts every part, `status 'pending'`, due now |
| `PassStartWith` | `deliverDue` starts (88-95): `running` and `mayDeliver()` checks, due snapshot, then the loop up to the first await: skips held rows, then either calls `channel.send` (`ph = "sending"`) or finds no channel and bumps `next_attempt_at` (`ph = "returned"`) |
| `SucceedWith(p,TRUE)` | `channel.send` resolved within 90 s: the tx at 136-148 (status `sent`, `external_id`, `attempts + 1`, `message_refs`) |
| `FailTransient` | `channel.send` threw a plain error: 157-166 (`attempts` = snapshot + 1, `failing` at 3, backoff) |
| `FailPermanent` | `channel.send` threw `PermanentSendError`: 152-156 (`dropped`) |
| `Hang` | the channel will never answer this attempt (`ph = "hung"`) |
| `TimeoutFires` | `withTimeout` rejected after 90 s: the transient path; the send goes to `orphans` |
| `OrphanLands(i)` / `OrphanFails(i)` | an abandoned send delivers after all (nothing records it) / fails |
| `ContinueWith` | `deliverDue` resumes after `await this.sendOne(row)` (101) and runs to the next await, or ends (`finally`, `ph = "idle"`), also when `mayDeliver()` is false before a row (99) |
| `BackoffElapses(r)` | the clock passes row r's `next_attempt_at` |
| `Crash` / `Restart` | the process dies (also `Daemon.stop` closing the DB under an in-flight send) / systemd starts `Daemon.start` |
| `TakeLockWith(d,...)` | daemon d's `takeLock` (190-201): runs, or throws "already running" (`proc = "refused"`) |
| `HeartbeatWith(d,...)` | `heartbeatLock` (209-216): refresh the row, or, if another daemon holds it, `stop()` (`proc = "stopped"`) |
| `HeartbeatGoesStale` | the holder is alive but its row looks over 2 min old (machine suspended) |
| `CheckLockWith` / `WriteLock` | mutant `MutLockNoTx` only: takeLock's read and write as two steps |

- Variables: `status`, `attempts`, `okey` (`order_key`), `ext` (`external_id`), `due`
  (`next_attempt_at` not after now) are the outbox row columns, indexed by row id; `refs` is the
  set of external ids in `message_refs`; `chanUp` says the channel is in the `channels` map this
  lifetime; `pass[p]` is one `deliverDue` call in memory (`cur` = the row whose send is in flight,
  `todo` = the rest of its snapshot; with two daemons slot p belongs to daemon p); `orphans` are
  sends the timeout gave up on; `proc`, `lock`, `fresh` are the daemons and the `daemon.lock` kv
  row; `log` is what the owner received, in order (`how`: `recorded`, `crash` = went out just
  before the process died or stopped, `timeout` = an abandoned send that landed, `error` = went
  out though `send` threw). External id k is `log[k]`. Row ids follow the scenario in the cfg
  (`MainItems`: row 1 is ticket T's question, row 2 its "blocked" report, both key `T`; rows 3-4
  are the two parts of one long reply).
- Tell the counterexample as numbered steps in the code's words: "1. the worker's `ask_owner`
  enqueues ... 2. `deliverDue` calls `channel.send` for row 1 ...".

## Model error or bug?

A counterexample is a bug only if the real code takes the same steps. Replay it: write a scratch
script or test (not committed) that drives the real code, as `test/outbox.test.ts` does
(`FakeChannel.failures`, `ManualClock.advance` for `BackoffElapses`, two `Db` handles on one file
for two processes, a `send` that never resolves plus a new `Outbox` on the same file for
`Crash`/`Restart`, `outbox.mayDeliver` set by hand for the lock, `Daemon.prototype.takeLock.call({
s: { db } })` for the lock check). One call per trace step. If the code does not do what the trace
says, the model is wrong: find the step whose code reference does not match, fix the model, and
rerun all mutants. Typical model errors: an action that does two things the code does across an
`await` (too coarse, hides orders), or splits one synchronous stretch or one `Db.tx` into two
steps (too fine, invents orders), or reads a value from the DB where the code reads the snapshot
row (or the reverse).

## When the code changes on purpose

1. Find the step(s) in `Outbox.tla` whose comment cites the changed lines; change the model to
   match. Each step must stay one synchronous stretch of the code between two awaits, or one
   `Db.tx`. The mutable parts are parameters (`EnqueueWith(Key)`, `PassStartWith(p, Guarded,
   Selected, Blocks)`, `ContinueWith`, `PassStartWithR`/`ContinueWithR` (Recheck = the per-row `mayDeliver`), `SucceedWith(p, Atomic)`, `LockStepsWith(Checked, Split,
   Recheck)`), so mutants can swap one piece.
2. A new enqueue caller or order key: follow `TicketOf`/`OutboxKey` in `Outbox.tla`
   (services.ts:98-101, sessions.ts:105) and add it to a scenario at the end of the file.
3. A new constant must be added to every `.cfg` (top level, `mutants/`, `fixed/`, `findings/`,
   `characterizations/`): TLC rejects a config that leaves one out.
4. Run `check.sh`. A property that now fails is a bug in the change, unless the change is meant to
   alter that rule; then change the property and its sentence here, and say so in the hand-off.
   Never weaken a property to make a run pass.
5. Every mutant must still fail its property. If a mutant now passes, the property no longer
   guards that code: fix the model or the mutant first.
   Then run `verification/outbox/trace/check.sh`: the real code must still pass trace
   validation, and its mutants must still be rejected. A new await or durable write in
   `deliverDue`/`sendOne` also needs `trace/record.ts` and `Do(e)` in `trace/OutboxTrace.tla`.
6. Update the line numbers in the coverage table and the state counts here, then move the sync
   commit to the new commit, only after you confirmed the model describes the code there.

## Mutants (each must fail)

Each file in `verification/outbox/mutants/` names the code change in its header.

| Mutant | Code change | Breaks |
| --- | --- | --- |
| `MutHeldBackDueOnly` | heldBack's query adds `AND next_attempt_at <= ?` (outbox.ts:111-116) | `OrderPreserved` |
| `MutNoSplitKey` | `const orderKey = item.orderKey ?? null` (outbox.ts:62) | `SplitPartsInOrder` |
| `MutQuestionNoTicketId` | `ask_owner` stops passing `ticketId` (tools.ts:341; was finding F1) | `TicketMessagesInOrder` |
| `MutApprovalNoKey` | delete the approval ask's `orderKey` (sessions.ts:105; was F1b) | `TicketMessagesInOrder` |
| `MutDelegateNoTicketId` | the helper's `buildSession` without `ticketId` / `approvalRoute` (delegate.ts:40-41; was F1c) | `TicketMessagesInOrder` |
| `MutNoRunningGuard` | drop `this.running ||` (outbox.ts:88) | `AtMostOnceWithoutCrashOrTimeout` |
| `MutNoLock` | delete `this.takeLock()` (daemon.ts:226; was F2) | `AtMostOnceWithoutCrashOrTimeout` (two daemons) |
| `MutLockNoTx` | takeLock without its `db.tx` (daemon.ts:200-206; was F2c) | `AtMostOnceWithoutCrashOrTimeout` (two daemons) |
| `MutMayDeliverOnce` | delete `if (!this.mayDeliver()) break;` (outbox.ts:99; was F2d) | `SendsOnlyWithLock` (two daemons, no /proc or ps) |
| `MutRefOutsideTx` | the sent UPDATE and the `message_refs` INSERT outside `db.tx` (outbox.ts:139-151) | `RefRecorded` |
| `MutPendingOnly` | due query `status IN ('pending')` (outbox.ts:93) | `NoLoss` |
| `MutNoSendTimeout` | `await channel.send(...)` without `withTimeout` (outbox.ts:131) | `NoLoss` |

Not guarded by a mutant: `heartbeatLock`'s re-check (where the holder can be checked by /proc or
`ps` it never acts; with neither, `MutMayDeliverOnce` covers the part that matters) and the `ps`
branch itself (the model's `ProcFs` stands for "/proc or ps works").

## Fixed findings (kept as passing checks)

| Finding | Fixed in | Check that now passes |
| --- | --- | --- |
| F1: `ask_owner`'s question had no order key, so the ticket's next report could overtake it | `ea743b1` | `TicketMessagesInOrder` in `Outbox.cfg` |
| F2: `vigil chat` next to the service: two `Outbox` objects, every due row sent twice | `ea743b1` (lock) | `fixed/TwoDaemonsLocked.cfg` |
| F2b: a live holder with a stale heartbeat (suspend) was taken over and kept sending | `4f5ff60` (lockHolderAlive via /proc, heartbeat re-check, mayDeliver) | `fixed/TwoDaemonsLocked.cfg` (ProcFs = TRUE, MaxStale = 1) |
| F2c: takeLock's read and write were two statements; two daemons started together both ran | `4f5ff60` (one `Db.tx`) | `fixed/TwoDaemonsLocked.cfg` |
| F1b: a worker's approval ask had no order key and overtook the ticket's question | `4f5ff60` | `fixed/ApprovalAskInOrder.cfg` |
| F1c: a ticket's helper session had no `ticketId`; its approval ask overtook the ticket's question | `2fed3cb` | `fixed/HelperApprovalInOrder.cfg` |
| F2d: without /proc the heartbeat alone decided; after a suspend a second daemon took over while the first went on sending its pass | `06d3da0` (`ps` check; `mayDeliver` before each row) | `fixed/TwoDaemonsLocked.cfg` (ps), `fixed/StaleTakeoverStopsSending.cfg` (neither /proc nor ps) |
| F3 (found by trace validation): a retry's `next_attempt_at` counted from before a slow send | `fdcacea` | `trace/check.sh` (the model abstracts time; no model change) |

## Open findings (bugs at the sync commit)

None. When check.sh finds a new one, add its config under `findings/` with an `expect_violation`
line, and list it here with its counterexample in the code's words.

## Characterizations (by design, stated plainly; they must keep failing)

- `SplitOvertakesBlockedPart`: once part 1 of a long message has 3 failed attempts, part 2 goes
  out first; part 1 follows when it succeeds.
- `SplitGapAfterDrop`: if part 1 is dropped (`PermanentSendError`), part 2 still goes out.
- `CrashResends`: a crash while `channel.send` is pending resends the message after restart
  (at-least-once).
- `CrashCopyUnroutable`: that pre-crash copy never gets a `message_refs` row, so a reply to it is
  not routed.
- `TimeoutResends`: a send slower than 90 s is abandoned and retried but not cancelled; if it
  lands, the owner gets the message twice with no crash, and that copy has no `message_refs` row
  (the trade outbox.ts:124-125 states).
- `ErrorAfterDeliveryResends`: if `channel.send` throws after the message went out (Discord failing
  on its second chunk), the owner gets it twice, no crash needed.
- `NoPidCheckInFlightResend` (what remains of F2d): only where neither /proc nor `ps` can tell the
  holder runs, the one send in flight across a suspend goes out twice: the second daemon takes the
  stale lock and sends the row, and the first daemon's send then returns and records it too.
- `ChannelDownStrands`: a channel that failed to start stays out of the map until restart; its
  messages wait (outbox.ts:121) and hold back their order key.

## Bounds and assumptions

- `Outbox.cfg`: 3 enqueues (ticket T's question and "blocked" report, one reply in 2 parts) = 4
  rows; in total up to 3 try-later errors, 1 drop, 1 timeout (slow or hung send), 1 crash; 2
  `deliverDue` calls that could overlap; the channel may be missing in any lifetime.
  `OutboxLive.cfg`: same rows, no crash, channel always present. `--deep`: `OutboxDeep.cfg` 4
  errors (1,656,967 states), `OutboxDeepRows.cfg` 5 rows, adding the "ready" report (2,598,494
  states), `OutboxLiveDeep.cfg` with 1 crash and no drop (193,181 states); together about 4 min.
- Two daemons (`fixed/TwoDaemonsLocked`, `fixed/StaleTakeoverStopsSending`, `NoPidCheckInFlightResend`, `MutNoLock`, `MutLockNoTx`, `MutMayDeliverOnce`): 2 rows, 1 error, no timeouts or
  crashes, 1 stale heartbeat. With Daemons = 1 the lock is an assumption (one daemon per home);
  with Daemons = 2 it is a guard modelled as the code does it.
- One channel, one conversation; the order keys in the code include both.
- Time is a flag per row; any retry may come due before any other (more orders than real backoff).
- `enqueue(); void deliverDue()` in the callers is two steps in the model (more orders than the
  code).
- `NoLoss` assumes fairness: the 3 s timer keeps firing, each awaited send settles or its 90 s timer
  fires, time passes, systemd restarts, and errors, timeouts and hangs stop eventually (they share
  global budgets).
- A crash can fall only between steps; that is exact because every step does at most one durable
  write that matters (the success path and takeLock are each one `Db.tx`; the drop's `db.event`
  row is not modelled).
- Not covered: governor decisions and quiet hours before `enqueue`; `split()` itself; channel
  internals (Discord's own chunking, Telegram truncation); the HTTP channel's reply matching;
  `reprocessStuckTriggers`; `next_attempt_at` values; more than 2 overlapping passes or 2 daemons;
  a crash with two daemons; pid reuse by another node process (lockHolderAlive would then refuse
  to start vigil).
