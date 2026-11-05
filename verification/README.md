# vigil verification

vigil promises the owner things that ordinary tests rarely reach, because the bad cases need an
unlucky order of events: a digest tick while the concierge is thinking, a tap on a stale button
after expiry, a mute in the middle of a turn, a typed command from the wrong place. This folder
model-checks those promises with TLA+ and TLC, which explores every order of steps in a small
model of the code.

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
1.8.0 pre-release once into `verification/.tools/` and checks its sha256 (the build the models were
checked with, 2026.11.03.180953; another build only warns). `run.sh` exports the jar it found as
`TLA2TOOLS` and `TLA2TOOLS_JAR` for the other agents' `check.sh` scripts. The governor and approvals
models also pass on TLC 1.7.4. On 4 cores the governor
and approvals checks take about 2–3 minutes, and the other agents' checks add a few more.
`run.sh` exits 0 when every required config and modeled fix passes and every finding reproduces
as recorded.

| Spec | Code | Verify skill |
| --- | --- | --- |
| `governor/` | src/core/governor.ts via notifier.ts, the concierge's claim/reply/confirm, daemon /digest, /mute and tick, config limits | `.claude/skills/verify-attention-governor/` |
| `approvals/` | src/core/approvals.ts, the gate in src/agent/gate.ts, `Daemon.route` (pairing, isOwner, HTTP refusal, typed /approve), `handleButton` | `.claude/skills/verify-approvals/` |
| `outbox/`, `scheduler/`, `workers/` | written by other agents; `run.sh` calls their `check.sh` | their own skills |

The verify skills (copied to `.pi/skills/` for pi) hold the coverage record, the sync commit
(`66af270`), the action-to-code table, and how to update a model when the code changes.

## Why TLA+ and TLC

The questions are about orderings and time: can a tick, a reply and a mute interleave so that a
rule breaks? A model checker answers that for every interleaving within a bound, and TLA+ is
the default for it. TLC is one Java jar, so every developer can run it. The property test
`test/governor.property.test.ts` checks the real TypeScript on random inputs. The model checks
every order of the calls, including code outside governor.ts that the property test does not
drive: the concierge, the daemon, the approval gate.

## What "true to the code" means here

- Every action in a model names the function it mirrors. A call that runs with no `await` in the
  code is one action. Examples: a governor function inside `db.tx()`, one synchronous SQLite
  UPDATE, and the gate's `request` + `ask` + `wait` registration.
- Ghost variables record what reached the owner and what the owner said. The code has no such
  state; the properties are stated over them.
- Each property was seen failing on a broken variant (`mutants/`, below) before its pass was trusted.
- A suggested fix that is not in the code yet is a named switch (`TypedRefusedOverHttp`), checked
  in `fixes/`. Configs without the switch describe the code as it is.

## Bounds and assumptions

Governor (`MCGovernor.tla`):
- Time is in 8-hour slots, 3 to a day (00–08 night, 08–16, 16–24), up to slot 4. The model is the
  code with whole-slot durations and every event on a slot boundary; several events can share a
  slot. No DST.
- Three policies from `GovernorPolicy`. The first is DEFAULT_POLICY-like: quiet at night, an
  evening digest, 1 interrupt a day, 1-slot gap, 1 critical. The second has no quiet hours and no
  digest times. The third has quiet hours that wrap midnight, a digest time inside them and one at
  their end, and criticalPerDay 0. One more, `LongExpiryPolicies`, has notices that may outlive
  `HISTORY_MS`.
- Two notices with every action, three without owner feedback, one with the concierge and mutes;
  one topic, two dedup keys, all four urgencies; default expiry (`--deep` adds a caller-set
  `expiresAt`). An offer must be able to expire before the clock stops.
- A stored concierge reply tells the owner every notice it was shown; there is no crash between
  `this.reply()` and `confirmDelivered()` (no `await` between them). A restart releases claims.
- `checkSend()` (src/core/invariants.ts) is not modeled; it can only refuse sends.
- TLC fingerprints states with a VIEW that treats an `until <= now` as no entry, and a
  `lastTickAt` more than a day old as exactly a day back. The code cannot tell either pair apart.
  Topics and keys use symmetry in the safety runs; the liveness runs use none.

Approvals (`Approvals.cfg`):
- Two tool calls with equal or different hashes, two or three approval rows (retries), TTL of 2
  slots, clock up to slot 3 (`--deep`: 4). Presses on any approval ever sent, by the owner, a
  stranger and an HTTP client, as buttons or typed commands, at any time.
- The gate may present any approval id to `consume()`; gate.ts presents its own, so this is a
  superset of the code's behaviors.
- Channels report sender ids truthfully; the pairing code reaches only the owner; only the person
  at the terminal reaches the CLI channel.

## Results at the sync commit (66af270)

| Check | Result | Distinct states |
| --- | --- | --- |
| governor/Governor (all governor calls, owner feedback; every safety rule and NoStaleDelivery) | pass | 258,439 |
| governor/Governor_three (3 notices) | pass | 374,323 |
| governor/Governor_live (EventuallyResolved) | pass | 44,599 |
| governor/Governor_concierge (claim, every reply outcome, restart) | pass | 405,963 |
| governor/Governor_concierge_mute (claim plus mutes during the turn) | pass | 55,724 |
| governor/Governor_live_concierge (EventuallyResolved with claims) | pass | 14,086 |
| governor/Governor_long_expiry (notices outliving HISTORY_MS) | pass | 176,922 |
| governor/Governor_deep, Governor_concierge_feedback (`--deep`) | pass | 1,102,733 / 4,878,082 |
| approvals/Approvals (the code: TypeOK, SingleUse, ExpiredNeverRuns) | pass | 127,450 |
| approvals/fixes/TypedRefusedOverHttp (every rule, with the suggested fix) | pass | 325,263 |
| approvals/Approvals_shutdown (every rule with `dispose()`) | pass | 59,118 |
| approvals/Approvals_live (GateResolves) | pass | 423,984 |

### Open findings

| Finding | Rule | What happens, in the code's words | Suggested fix |
| --- | --- | --- | --- |
| approvals/TypedApproveOverHttp | OwnerOnly, NoUnapprovedExecution, DeniedNeverRuns | `route()` refuses approve/deny over HTTP only for `msg.kind === "button"`. A typed `/approve ap_…` posted to `/api/message` is a message: `handleCommand` → `handleButton` → `decide()`. Anything holding the HTTP token, the agent's own tools included, approves its own risky call; a later owner Deny is then ignored. Replayed on the real daemon with the test harness: the button press is refused, the typed one leaves the approval `consumed`, and the worker's `sudo true` runs. | Apply the same refusal to `/approve` and `/deny` in `handleCommand` when the message came over HTTP. Modeled as `TypedRefusedOverHttp`; every rule passes. |
| approvals/HttpApprovalsOptIn | OwnerOnly | With `channels.http.allowApprovals = true`, anything holding the HTTP token or a signed ntfy button URL approves as the owner. | A documented opt-in risk; keep it off unless tools cannot read vigil's config. |

### Fixed findings (found by these models, fixed in the code)

| Finding | Rule | Fixed in |
| --- | --- | --- |
| ConciergeToldTwice: a notice the concierge peeked for its prompt was digested by the 08:00 tick (or `/digest`) during the turn, then told again by the reply | Conservation | 99a81e7: `claim()` at the start of the turn |
| ConciergePartialReply: a reply with `r.error` and text was stored but not confirmed, so its notices went out again | Conservation | 99a81e7 |
| ConciergeMutedDuplicate: a notice dropped by a mute during the turn was still told; dedup ignored it, so the news went out again | NoDuplicate | 99a81e7 |
| ConciergeMuted: a mute during the turn; the reply still told the notice | NoMuted | the owner's decision: replies are solicited, so NoMuted (like Quiet) covers unsolicited sends |
| DigestCommandStale: `/digest` showed a notice past `expiresAt` before the next tick | NoStaleDelivery | 99a81e7: `takeForReply()` expires first |
| WindowGap, WindowDedup: `minGapMinutes` above 24 h or `dedupWindowMinutes` above 7 days outlived what `tick()` keeps | Budget, NoDuplicate | 99a81e7: `validate()` rejects them |
| ClaimPruned: a claimed notice older than `HISTORY_MS` was pruned by a tick mid-turn (the notify tool's `expires_in_hours` has no cap) | Conservation | 4d5f2c7: the prune keeps claimed notices |
| MutedAfterRelease: owner mutes during the turn, the turn ends with no text, `release()` put the notice back, and the next digest sent it on the muted topic | NoMuted | 4d5f2c7: `release()` drops it as `drop:muted` |

Characterized, not a finding: a notice claimed while fresh can expire while the model writes, and
the reply then still tells it. NoStaleDelivery measures a reply at the time of the claim.

## Mutants: every property can fail

`mutate.sh` copies a spec, applies one mutant (each mirrors a named code change), checks only that
mutant's property, and expects the violation. At the sync commit all of them are caught:

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
| governor-12-tick-flushes-claimed | `isWaiting()` also counts claimed notices | Conservation |
| governor-13-partial-released | a reply with `r.error` and text is released, not confirmed | Conservation |
| governor-14-peek-without-claim | the concierge peeks with `waiting()` again | Conservation |
| governor-15-claim-expired | `claim()` without its expiry test | NoStaleDelivery |
| governor-16-no-release-on-restart | the `Notifier` constructor without `release()` | EventuallyResolved |
| governor-17-digest-command-stale | `takeForReply()` without expire-first | NoStaleDelivery |
| governor-18-prune-claimed | `tick()`'s prune without `status === "claimed"` | Conservation |
| governor-19-release-ignores-mute | `release()` without the muted test | NoMuted |
| approvals-01-consume-status | `consume()` without `status = 'approved'` | NoUnapprovedExecution |
| approvals-02-consume-hash | `consume()` without `hash = ?` | NoUnapprovedExecution |
| approvals-03-consume-once | `consume()` without `SET status = 'consumed'` | SingleUse |
| approvals-04-decide-pending | `decide()` without `status = 'pending'` | DeniedNeverRuns |
| approvals-05-consume-expiry | `consume()` without `expires_at > ?` | ExpiredNeverRuns |
| approvals-06-inbox-owner | `route()` without the `isOwner` drop | OwnerOnly |
| approvals-07-http-approvals | `route()` without the HTTP button refusal (81f48ef reverted) | OwnerOnly |
| approvals-08-gate-ignores-consume | gate.ts runs on `outcome === "approved"` without `consume()` | NoUnapprovedExecution |
| approvals-09-no-timer | `wait()` without its timer and the daemon without `expire()` | GateResolves |

The approvals mutants for NoUnapprovedExecution, DeniedNeverRuns and OwnerOnly run on
`fixes/TypedRefusedOverHttp.cfg`, because the code config already breaks those rules.

Defence in depth seen while writing mutants: `decide()`'s `expires_at > ?` is not needed for any
property, because `consume()` re-checks expiry. Without it, a late Approve would make the owner see
"👍 Approved" for a call that will not run.

## The statechart

`governor/chart.mmd` was drawn by the vendored pstack `statechart` skill from `governor/chart.cfg`
(one notice, the DEFAULT_POLICY-like policy, 176 TLC states, every rule holds), using the view
`governor/chart-view.ts`. The condition "[unless Evening]" on "a notice comes in" comes from the
model's time bound (an offer must be able to expire before the clock stops), not from the code.
Read results with the `/statechart` skill.

## Not covered

- DST in `crossed()`, time zones, minute-level timing inside a slot.
- More than three notices, two tool calls, or three approval rows; policies other than those listed.
- `checkSend()`, the outbox after `enqueue` (see `outbox/`), channel delivery, the HTTP server
  itself, how pairing codes are kept secret.
- `classify()` and the gate rules (which calls are risky), hash collisions, pi changing a call's
  input after the gate returns.
- Whether a concierge reply actually mentions the notices it was shown (assumed it does).
