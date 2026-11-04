---
name: verify-outbox
description: Model-check vigil's outbox (src/core/outbox.ts enqueue, deliverDue, heldBack, sendOne) with TLA+/TLC. Use before handing off any change to how outbound messages are stored, ordered, retried, dropped or recorded (outbox.ts, the orderKey in services.ts sendSolicited, the deliverDue callers in daemon.ts, Db.tx, the message_refs write), and when someone asks whether vigil can send a message twice, out of order, or never.
---

# Verify the outbox

Every message vigil sends goes through `Outbox`: `enqueue` stores it (split into parts if it is
long), `deliverDue` sends what is due every 3 s and on demand, with retries. Tests cover single
paths. This check is a TLA+ model of that code; TLC tries every order of enqueues, overlapping
`deliverDue` calls, chat-app answers (success, try-later, refused for good, channel not running),
retry timers, crashes and restarts, within small bounds.

## The properties

| Property | Rule (one sentence) | Harm if broken (one sentence) |
| --- | --- | --- |
| `OrderPreserved` | For one order key, a message never goes out while an earlier one with that key is still owed, unless the earlier one was dropped or has `BLOCKING_ATTEMPTS` (3) failed attempts. | The owner reads a ticket's "✅ ready" before its "⏸ blocked", or a reply before the message it follows. |
| `SplitPartsInOrder` | The parts of one long message go out in order, with the same exception. | The owner gets the second half of a message before the first. |
| `AtMostOnceWithoutCrash` | Apart from a copy that was in flight when the process died, the owner gets each message at most once. | The owner's phone buzzes twice for one message. |
| `RefRecorded` | Every delivery vigil recorded as sent, of a message with a ref, has its `message_refs` row. | The owner replies to a ticket's message and the reply is not routed to the ticket. |
| `NoLoss` (liveness) | Every enqueued message is eventually sent or dropped, assuming the channel is running, every `channel.send` settles, and try-later errors eventually stop. | A message waits forever and the owner never hears it. |

In the model, "owed" means the earlier row is inserted and the owner has not received any copy
of it. The order properties are history flags, set at the moment `channel.send` is called.

## Run it

```sh
bash verification/outbox/check.sh            # about 45 s
bash verification/outbox/check.sh --deep     # also 4 million states of safety + a larger liveness run, about 3 more min
bash verification/outbox/check.sh --trace findings/TicketQuestionOutOfOrder.cfg   # print one counterexample
```

Needs Java 11 or later and `tla2tools.jar`; set `TLA2TOOLS=/path/to/tla2tools.jar` if it is not
at `/home/user/tools/tla2tools.jar`. Last confirmed with TLC 2026.11.03.180953 (rev 309e489),
jar sha256 `e20447644bfabd29d6bd0fc2c0eb1473fb301c1a0e4dfe1961938ce5a191edbf`, OpenJDK 21.

Every line is `PASS` or `FAIL`, and the script exits 1 on any `FAIL`. Each TLC run is cut off after
`OUTBOX_TLC_TIMEOUT` seconds (default 300) and then counts as `FAIL`: a change that makes the
state space explode shows up instead of hanging. Without a guard on `deliverDue`, for example,
safety fails at once and the liveness run hits the limit. Expected today, all `PASS`:

- current code: `Outbox.cfg` (safety, 596,203 distinct states) and `OutboxLive.cfg` (liveness,
  24,695 states) find no error. `--deep`: `OutboxDeep.cfg` 4,015,453 states, `OutboxLiveDeep.cfg`
  273,615 states, no error.
- five mutants, each violating its own property (see "Mutants").
- two findings and six characterizations still show their violation (see below). For these,
  `PASS` means "still reproduced", not "fine".

## Does my change touch this?

Coverage record. Sync commit: `6ac9124751ef146bc29e56b07dc6c836a57a3e81` (the commit at
which the model was last confirmed to describe the code below; every channel, including
Slack and Signal, is the same abstract `Channel.send` to the model).

| File | What the model takes from it | Lines at sync commit |
| --- | --- | --- |
| `src/core/outbox.ts` | `BLOCKING_ATTEMPTS` | 40 |
| | `Outbox.enqueue`: one `Db.tx`, all parts; the generated `split:` key | 57-82 (key: 60) |
| | `Outbox.deliverDue`: `running` guard, due `SELECT ... ORDER BY id` snapshot, loop, `finally` | 85-102 |
| | `Outbox.heldBack`: earlier same-key row, pending/failing, attempts below the limit, read fresh | 104-113 |
| | `Outbox.sendOne`: missing channel, `await channel.send`, success tx with `message_refs`, `PermanentSendError` drop, transient retry from the snapshot's `attempts` | 115-165 |
| `src/channels/types.ts` | `PermanentSendError`; `Channel.send` | 54, 60 |
| `src/agent/services.ts` | `sendSolicited`: orderKey only for `ref.kind === "ticket"` | 69-98 (key: 96) |
| `src/agent/tools.ts` | `report` (ref ticket) and `ask_owner` (ref attention) enqueue through `sendSolicited` | 300, 332 |
| `src/core/notifier.ts` | `send`: enqueue with no orderKey (notices now carry buttons) | 160-172 |
| `src/agent/sessions.ts` | approval `ask`: enqueue with no orderKey | 92-104 |
| `src/daemon.ts` | `start`: failed channels deleted from the map the Outbox reads, `every(3_000, deliverDue)` | 162-207 (173-178, 192) |
| | ad hoc `deliverDue`: `say`, `tryPair`; enqueue in `runJob` remind | 420-424, 521-522, 279 |
| `src/agent/concierge.ts`, `src/panel/panel.ts` | ad hoc `deliverDue` | 223, 118 |
| `src/store/db.ts` | `Db.tx` (nested joins outer), `outbox` and `message_refs` tables | 208-229, 80-97 (+ migration 162), 145-152 |
| `src/cli.ts` | `vigil chat` starts a second, embedded daemon on the same database | 346-348 |

Run `git diff 6ac9124751ef146bc29e56b07dc6c836a57a3e81 -- <files above>`. If the diff touches any
of those functions, or adds a new `outbox.enqueue` caller with an `orderKey`, or a new `await`
inside `deliverDue`/`sendOne`, re-read the matching part of `verification/outbox/Outbox.tla`
before trusting a `PASS`. Not covered at all: `split()`'s cutting (183-197; the model only uses
the number of parts), `lookupRef`, `problems`, and the channels' own `send` code.

## Reading a result

- Read every TLC result with the pstack `/statechart` skill: it gives the shortest path to each
  broken rule in plain words, and draws the state chart when the check passes. Use the TLC jar
  above. At the sync commit, `/statechart` could not read this spec: its SANY XML reader stopped
  with `Cannot read properties of undefined (reading 'tag')` on comments inside TLC's standard
  `Sequences` module (they contain `<<`). That is the tool, not the model; until it is fixed, use
  `check.sh --trace <cfg>`, which prints the same shortest path from TLC.
- Steps, as the trace names them, and the code they stand for:

| Trace step | Code |
| --- | --- |
| `EnqueueWith` | `Outbox.enqueue` (outbox.ts:57-82): inserts every part, `status 'pending'`, due now |
| `PassStartWith` | `deliverDue` starts (86-93): guard, due snapshot, then the loop up to the first await: skips held rows, then either calls `channel.send` (`ph = "sending"`) or finds no channel and bumps `next_attempt_at` (`ph = "returned"`) |
| `SucceedWith(p,TRUE)` | `channel.send` resolved: the tx at 132-144 (status `sent`, `external_id`, `attempts + 1`, `message_refs`) |
| `FailTransient` | `channel.send` threw a plain error: 153-162 (`attempts` = snapshot + 1, `failing` at 3, backoff) |
| `FailPermanent` | `channel.send` threw `PermanentSendError`: 148-151 (`dropped`) |
| `ContinueWith` | `deliverDue` resumes after `await this.sendOne(row)` (96) and runs to the next await, or ends (`finally`, `ph = "idle"`) |
| `BackoffElapses(r)` | the clock passes row r's `next_attempt_at` |
| `Crash` / `Restart` | the process dies (also `Daemon.stop` closing the DB under an in-flight send) / systemd starts `Daemon.start` |

- Variables: `status`, `attempts`, `okey` (`order_key`), `ext` (`external_id`), `due`
  (`next_attempt_at` not after now) are the outbox row columns, indexed by row id; `refs` is the
  set of external ids in `message_refs`; `chanUp` says the channel is in the `channels` map this
  lifetime; `pass[p]` is one `deliverDue` call in memory (`cur` = the row whose send is in flight,
  `todo` = the rest of its snapshot); `log` is what the owner received, in order (`how`:
  `recorded`, or `crash` = went out just before the process died, or `error` = went out though
  `send` threw). External id k is `log[k]`. Row ids follow the scenario in the cfg
  (`MainItems`: rows 1-2 are ticket T's "blocked" and "ready" with key `T`, rows 3-4 are the two
  parts of one long reply).
- Tell the counterexample as numbered steps in the code's words: "1. the worker's `report`
  enqueues ... 2. `deliverDue` calls `channel.send` for row 1 ...".

## Model error or bug?

A counterexample is a bug only if the real code takes the same steps. Replay it: write a scratch
script or test (not committed) that drives the real `Outbox` with a fake channel, as
`test/outbox.test.ts` does (`FakeChannel.failures`, `ManualClock.advance` for `BackoffElapses`,
two `Db` handles on one file for two processes, a `send` that never resolves plus a new `Outbox`
on the same file for `Crash`/`Restart`). One call per trace step. If the code does not do what
the trace says, the model is wrong: find the step whose code reference does not match, fix the
model, and rerun all mutants. Typical model errors: an action that does two things the code does
across an `await` (too coarse, hides orders), or splits one synchronous stretch into two steps
(too fine, invents orders), or reads a value from the DB where the code reads the snapshot row
(or the reverse).

## When the code changes on purpose

1. Find the step(s) in `Outbox.tla` whose comment cites the changed lines; change the model to
   match. Each step must stay one synchronous stretch of the code between two awaits, or one
   `Db.tx`. The mutable parts are parameters (`EnqueueWith(Key)`, `PassStartWith(p, Guarded,
   Selected, Blocks)`, `ContinueWith`, `SucceedWith(p, Atomic)`), so mutants can swap one piece.
2. A new enqueue caller or order key: add it to the scenario operators at the end of
   `Outbox.tla`, following `services.ts:96` for the key.
3. Run `check.sh`. A property that now fails is a bug in the change, unless the change is meant to
   alter that rule; then change the property and its sentence here, and say so in the hand-off.
   Never weaken a property to make a run pass.
4. Every mutant must still fail its property. If a mutant now passes, the property no longer
   guards that code: fix the model or the mutant first.
5. Update the line numbers in the coverage table and the state counts above, then move the sync
   commit to the new commit, only after you confirmed the model describes the code there.

## Mutants (each must fail)

Each file in `verification/outbox/mutants/` names the code change in its header.

| Mutant | Code change | Breaks |
| --- | --- | --- |
| `MutHeldBackDueOnly` | heldBack's query adds `AND next_attempt_at <= ?` (outbox.ts:107) | `OrderPreserved` |
| `MutNoSplitKey` | `const orderKey = item.orderKey ?? null` (outbox.ts:60) | `SplitPartsInOrder` |
| `MutNoRunningGuard` | delete `if (this.running) return 0;` (outbox.ts:86) | `AtMostOnceWithoutCrash` |
| `MutRefOutsideTx` | the sent UPDATE and the `message_refs` INSERT outside `db.tx` (outbox.ts:132-144) | `RefRecorded` |
| `MutPendingOnly` | due query `status IN ('pending')` (outbox.ts:91) | `NoLoss` |

## Open findings (bugs at the sync commit)

- `findings/TicketQuestionOutOfOrder.cfg`, rule `TicketMessagesInOrder` (DESIGN.md:69 "messages
  of one ticket to one conversation keep their order"): `ask_owner`'s question has
  `ref.kind "attention"`, and `sendSolicited` gives an orderKey only to `ref.kind "ticket"`
  (services.ts:96), so the ticket's next report overtakes a question whose send failed once.
- `findings/TwoDaemonsDoubleSend.cfg`, rule `AtMostOnceWithoutCrash`: `running` lives in one
  `Outbox` object, so `vigil chat` (an embedded daemon, cli.ts:346) on the same database as the
  running service sends each due row twice.

When a fix lands: confirm the finding's cfg now passes (it will show `FAIL` in check.sh, which is
the signal), move its rule into `Outbox.cfg` (for the ticket rule, use a scenario with the question,
such as `DeepItems`), remove the finding entry from check.sh and from this list.

## Characterizations (by design, stated plainly; they must keep failing)

- `SplitOvertakesBlockedPart`: once part 1 of a long message has 3 failed attempts, part 2 goes
  out first; part 1 follows when it succeeds.
- `SplitGapAfterDrop`: if part 1 is dropped (`PermanentSendError`), part 2 still goes out.
- `CrashResends`: a crash while `channel.send` is pending resends the message after restart
  (at-least-once).
- `CrashCopyUnroutable`: that pre-crash copy never gets a `message_refs` row, so a reply to it is
  not routed.
- `ErrorAfterDeliveryResends`: if `channel.send` throws after the message went out (a timeout after
  Telegram accepted it; Discord failing on its second chunk), the owner gets it twice, no crash
  needed.
- `ChannelDownStrands`: a channel that failed to start stays out of the map until restart; its
  messages wait (outbox.ts:119) and hold back their order key.

## Bounds and assumptions

- `Outbox.cfg`: 3 enqueues (2 ticket results with one key, 1 reply in 2 parts) = 4 rows; up to 4
  try-later errors and 2 drops in total; 2 crashes; 2 `deliverDue` calls that could overlap; the
  channel may be missing in any lifetime. `OutboxDeep.cfg`: 5 rows (adds the ticket's question),
  4 errors, 1 drop, 2 crashes. `OutboxLive.cfg`: the 4 rows, 3 errors, 1 drop, 1 crash, channel
  always present; `OutboxLiveDeep.cfg`: 4 errors, 2 crashes.
- One channel, one conversation; the order keys in the code include both.
- Time is a flag per row; any retry may come due before any other (more orders than real backoff).
- `enqueue(); void deliverDue()` in the callers is two steps in the model (more orders than the
  code).
- `NoLoss` assumes fairness: the 3 s timer keeps firing, every `channel.send` settles (a send that
  hangs keeps `running` true and stops the whole outbox, all channels, until it settles; grammY's
  default API timeout is 500 s), time passes, systemd restarts, and try-later errors stop
  eventually.
- A crash can fall only between steps; that is exact because every step does at most one durable
  write that matters (the success path is one `Db.tx`; the drop's `db.event` row is not modelled).
- Not covered: governor decisions and quiet hours before `enqueue`; `split()` itself; channel
  internals (Discord's own chunking, Telegram truncation); the HTTP channel's reply matching;
  `reprocessStuckTriggers`; `next_attempt_at` values; more than 2 overlapping passes or 2 daemons.
