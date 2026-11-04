# vigil verification

vigil promises the owner things that ordinary tests rarely reach, because the bad cases need an
unlucky order of events: a digest tick while the concierge is thinking, a tap on a stale button
after expiry, a mute in the middle of a turn. This folder model-checks those promises with
TLA+ and TLC, which explores every order of steps in a small model of the code.

```sh
bash verification/run.sh                   # everything: governor, approvals, then the outbox,
                                           # scheduler and workers checks (other agents own those)
bash verification/run.sh --only governor   # one spec; also --only approvals
bash verification/run.sh --deep            # adds the deeper configs
bash verification/run.sh --strict          # also exit nonzero while any finding is open
bash verification/mutate.sh                # show every property can fail (all mutants)
bash verification/mutate.sh approvals-0    # mutants whose name starts with this
```

Needs Java 11+. TLC comes from `$TLA2TOOLS`, or `verification/lib.sh` downloads the pinned TLC
1.7.4 release once into `verification/.tools/` and checks its sha256. On 4 cores the governor
and approvals checks take about 2 minutes; the other agents' checks add about 2.5 minutes.

| Spec | Code | Verify skill |
| --- | --- | --- |
| `governor/` | src/core/governor.ts via notifier.ts, the concierge's peek/confirm, daemon /digest, /mute and tick | `.claude/skills/verify-attention-governor/` |
| `approvals/` | src/core/approvals.ts, the gate in src/agent/gate.ts, `Daemon.route`/`handleButton`, `isOwner` | `.claude/skills/verify-approvals/` |
| `outbox/`, `scheduler/`, `workers/` | written by other agents; `run.sh` calls their `check.sh` | their own skills |

The verify skills (copied to `.pi/skills/` for pi) hold the coverage record, the sync commit,
the action-to-code table, and how to update a model when the code changes.

## Why TLA+ and TLC

The questions are about orderings and time: can a tick, a reply and a mute interleave so that a
rule breaks? A model checker answers that for every interleaving within a bound, and TLA+ is
the default for it. TLC is one Java jar, so every developer can run it. The property test
`test/governor.property.test.ts` checks the real TypeScript on random inputs; the model checks
every order of the calls, including code outside governor.ts (the concierge, the daemon, the
approval gate) that the property test does not drive.

## What "true to the code" means here

- Every action in a model names the function it mirrors. A call that runs without an `await`
  in the code (a governor function inside `db.tx()`, a synchronous SQLite UPDATE, the gate's
  `request` + `ask` + `wait` registration) is one action.
- Ghost variables record what reached the owner and what the owner said; the code has no such
  state, and properties are stated over them.
- Each property was seen failing on a broken variant (`mutants/`, below) before its pass was trusted.

## Bounds and assumptions

Governor (`MCGovernor.tla`):
- Time is in 8-hour slots, 3 to a day (00–08 night, 08–16, 16–24), up to slot 4. The model is
  the code with whole-slot durations and every event on a slot boundary; several events can
  share a slot. No DST.
- Three policies from `GovernorPolicy`: DEFAULT_POLICY-like (quiet at night, an evening digest,
  1 interrupt a day, 1-slot gap, 1 critical); no quiet hours and no digest times; and quiet
  hours that wrap midnight with a digest time inside them and one at their end, criticalPerDay 0.
- Two notices with every action (`Governor.cfg`), three notices without owner feedback
  (`Governor_three.cfg`); one topic, two dedup keys, all four urgencies; default expiry (the
  `--deep` config adds a caller-set `expiresAt`). An offer must be able to expire before the
  clock stops.
- A stored concierge reply tells the owner every notice it was shown.
- `checkSend()` (src/core/invariants.ts) is not modeled; it can only refuse sends.
- TLC fingerprints states with a VIEW that treats an `until <= now` as no entry and a
  `lastTickAt` older than a day as exactly a day back. Both are equivalences the code cannot
  tell apart. Topics and keys use symmetry in the safety runs; liveness runs use none.

Approvals (`Approvals.cfg`):
- Two tool calls whose hashes are equal or different, up to three approval rows (so a call can
  retry), TTL of 2 slots, clock up to slot 3 (`--deep`: 4). Presses on any approval ever sent,
  by the owner, a stranger and an HTTP client, at any time.
- The gate may present any approval id to `consume()` (gate.ts presents its own), a superset of
  the code's behaviors.
- Channels report sender ids truthfully; only the person at the terminal reaches the CLI channel.

## Results at the sync commit (4c99637)

| Check | Result | Distinct states |
| --- | --- | --- |
| governor/Governor (Budget, CriticalCap, Quiet, NoMuted, NoDuplicate, Conservation, FinalStable) | pass | 283,035 |
| governor/Governor_three (same rules, 3 notices) | pass | 446,637 |
| governor/Governor_live (EventuallyResolved) | pass | 52,263 |
| governor/Governor_concierge (TypeOK, Budget, CriticalCap, Quiet, NoDuplicate, FinalStable) | pass | 1,106,495 |
| governor/fixes/ClaimOnPeek (the suggested fix, all rules but NoMuted) | pass | 170,783 |
| governor/Governor_deep, fixes/ClaimOnPeek_deep | pass | 1,309,195 / 2,517,724 |
| approvals/Approvals (all five safety rules) | pass | see run.sh output |
| approvals/Approvals_live (GateResolves) | pass | see run.sh output |
| approvals/Approvals_deep | pass | see run.sh output |

Open findings (each a `findings/*.cfg` that must keep breaking its rule until fixed):

| Finding | Rule | What happens, in the code's words | Suggested fix |
| --- | --- | --- | --- |
| governor/ConciergeToldTwice | Conservation | A notice is held overnight. At 08:00 the owner writes; the concierge's turn runs `notifier.waiting()` and puts the notice in the prompt. While the model runs, the 30-s tick crosses the end of quiet hours and `tick()` sends it in the morning digest. The turn ends, `this.reply()` lists it again, and `confirmDelivered()` skips it because it is no longer waiting. The owner is told twice. `/digest` during the turn does the same. | Claim at the peek: a status the tick, `/digest`, mute and expiry leave alone, marked digested when a reply is stored and released when none is. Modeled as `ClaimOnPeek`; passes. |
| governor/ConciergePartialReply | Conservation | A turn ends with `r.error` but some text. The reply is stored (it may list the notices) but `confirmDelivered()` is not called, so they stay waiting and go out again in a digest. | Same fix: treat a stored reply as told, with or without an error. |
| governor/ConciergeMutedDuplicate | NoDuplicate | The owner mutes a topic during the turn, which drops the notice. The reply tells it anyway. After an unmute, the same news is offered again, and `offer()`'s dedup ignores dropped notices, so it is delivered. | The claim fix (a claimed notice is not dropped, so it ends as digested and dedup sees it). |
| governor/ConciergeMuted | NoMuted | A mute while the turn runs: the stored reply still tells the muted notice. | Owner decision: count a reply the owner asked for as solicited for NoMuted too, or drop muted topics from the reply before `this.reply()`. |
| governor/ConciergeMutedAfterFix | NoMuted | The same residual under the claim fix. | As above. |
| governor/DigestCommandStale | NoStaleDelivery (not a DESIGN.md rule) | `/digest` calls `takeForReply()`, which does not expire first. A notice past its `expiresAt` is shown if the 30-s tick has not run yet. | Expire (or skip) `expiresAt <= now` in `takeForReply()`. |
| governor/WindowGap | Budget | With `minGapMinutes` above 24 h (config allows it), `tick()` prunes interrupts older than a day, so `spaced` sees none and the gap is not kept. | Validate `minGapMinutes <= 1440`, or prune with `max(DAY, minGap)`. |
| governor/WindowDedup | NoDuplicate | With `dedupWindowMinutes` above 7 days, `tick()` forgets resolved notices after `HISTORY_MS`, so a repeat is not seen as a duplicate. | Validate `dedupWindowMinutes <= 7 * 1440`, or keep history for `max(HISTORY_MS, dedupWindow)`. |
| approvals/HttpApprovalsOptIn | OwnerOnly | With `channels.http.allowApprovals = true`, anything holding the HTTP token or a signed ntfy button URL, the agent's own tools included, approves as the owner. | A documented opt-in risk; keep it off unless tools cannot read vigil's config. |

## Mutants: every property can fail

`mutate.sh` copies a spec, applies one mutant (each mirrors a named code change), checks only that
mutant's property, and expects the violation. At the sync commit all 20 are caught:

| Mutant | Code change it mirrors | Caught by |
| --- | --- | --- |
| governor-01-budget-cap | `offer()` step 6 without `withinBudget` | Budget |
| governor-02-budget-gap | `offer()` step 6 without `spaced` | Budget |
| governor-03-critical-cap | `offer()` step 3 without the `criticalPerDay` test | CriticalCap |
| governor-04-quiet-offer | `offer()` without step 5 (quiet hold) | Quiet |
| governor-05-quiet-digest | `tick()`'s `digestDue` without `!quiet` | Quiet |
| governor-06-muted-offer | `offer()` without step 1 (muted) | NoMuted |
| governor-07-muted-waiting | `mute()` without dropping waiting notices | NoMuted |
| governor-08-duplicate | `offer()` without step 2 (dedup) | NoDuplicate |
| governor-09-flush-all | `flush()` without `isWaiting` | Conservation |
| governor-10-mute-final | `mute()` without `isWaiting` | FinalStable |
| governor-11-no-expiry | `tick()` without its expiry pass | EventuallyResolved |
| approvals-01-consume-status | `consume()` without `status = 'approved'` | NoUnapprovedExecution |
| approvals-02-consume-hash | `consume()` without `hash = ?` | NoUnapprovedExecution |
| approvals-03-consume-once | `consume()` without `SET status = 'consumed'` | SingleUse |
| approvals-04-decide-pending | `decide()` without `status = 'pending'` | DeniedNeverRuns |
| approvals-05-consume-expiry | `consume()` without `expires_at > ?` | ExpiredNeverRuns |
| approvals-06-inbox-owner | `route()` without the `isOwner` drop | OwnerOnly |
| approvals-07-http-approvals | `route()` without the HTTP approve/deny refusal (81f48ef reverted) | OwnerOnly |
| approvals-08-gate-ignores-consume | gate.ts runs on `outcome === "approved"` without `consume()` | NoUnapprovedExecution |
| approvals-09-no-timer | `wait()` without its timer and the daemon without `expire()` | GateResolves |

Defence in depth seen while writing mutants: `decide()`'s `expires_at > ?` alone is not needed
for any property, because `consume()` re-checks expiry. Without it, a late Approve would make the
owner see "👍 Approved" for a call that will not run.

## The statechart

`governor/chart.mmd` was drawn by the vendored pstack `statechart` skill from `governor/chart.cfg`
(one notice, the default-like policy, 193 TLC states, every rule holds) with the view
`governor/chart-view.ts`. "[unless Evening]" on "a notice comes in" is the model's time bound
(an offer must be able to expire before the clock stops), not the code. Read results with the
`/statechart` skill.

## Not covered

- DST in `crossed()`, time zones, minute-level timing inside a slot.
- More than three notices, two tool calls, or three approval rows; policies other than those listed.
- `checkSend()`, the outbox after `enqueue` (see `outbox/`), channel delivery, the HTTP server.
- `classify()` and the gate rules (which calls are risky), hash collisions, pi changing a call's
  input after the gate returns.
- Whether a concierge reply actually mentions the notices it was shown (assumed it does).
- Restarts beyond `Approvals.dispose()` and retries as new calls.
