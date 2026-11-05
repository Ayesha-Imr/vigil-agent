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
bash verification/run.sh --trace           # also trace-validate the real governor.ts (about 1 min)
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
(`f3ff16b`), the action-to-code table, and how to update a model when the code changes.

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
- While a suggested fix is not in the code yet, it is a named switch checked in a `fixes/` config;
  once the code has it, the switch goes and the model describes the code (no switch is open now).

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

## Results at the sync commit (f3ff16b)

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
| approvals/Approvals (every rule) | pass | 325,263 |
| approvals/Approvals_shutdown (every rule with `dispose()`) | pass | 59,118 |
| approvals/Approvals_live (GateResolves) | pass | 62,616 |

### Open findings

| Finding | Rule | What happens, in the code's words | Suggested fix |
| --- | --- | --- | --- |
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
| TypedApproveOverHttp: a typed `/approve ap_…` posted to `/api/message` went `handleCommand` → `handleButton` → `decide()`, past the HTTP refusal that covered only buttons; anything with the token, the agent's tools included, approved its own call (replayed on the real daemon: `consumed`, `sudo true` ran). The first approvals model had only buttons and would have missed it (a model gap); the typed action, added when `/approve` appeared, found it | OwnerOnly, NoUnapprovedExecution, DeniedNeverRuns | d83a053: `handleCommand` refuses typed approvals over http/ntfy unless `allowApprovals` |
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
| approvals-10-typed-http | `handleCommand` `/approve` `/deny` without the HTTP/ntfy refusal (d83a053 reverted) | OwnerOnly |
| approvals-08-gate-ignores-consume | gate.ts runs on `outcome === "approved"` without `consume()` | NoUnapprovedExecution |
| approvals-09-no-timer | `wait()` without its timer and the daemon without `expire()` | GateResolves |

Two liveness wordings are accepted (`Temporal properties were violated.` and, in newer TLC builds,
`Temporal property X was violated.`).

Defence in depth seen while writing mutants: `decide()`'s `expires_at > ?` is not needed for any
property, because `consume()` re-checks expiry. Without it, a late Approve would make the owner see
"👍 Approved" for a call that will not run.

## Trace validation: runs of the real governor are behaviors of the model

The model check shows that `Governor.tla` keeps the rules, and the property test shows that
`governor.ts` keeps them, but each checks its own copy of the rules. Trace validation (Cirstea,
Kuppe, Merz et al., "Validating Traces of Distributed Programs Against TLA+ Specifications") links
the two: TLC checks that recorded runs of the real code are behaviors of the model. Every call the
code made is a step the model's `Next` allows, and it leaves the same state.

```sh
bash verification/governor/trace/check.sh                    # 100 traces + 6 mutants, about 1 min on 4 cores
bash verification/governor/trace/check.sh --count 1000 --seed 5000 --no-mutants   # longer hunt, ~7 s per 100 traces
bash verification/governor/trace/check.sh --replay FILE.ndjson ...                # validate given traces
bash verification/run.sh --trace                             # the same check as a step of run.sh
```

Needs Java and Node 22. The script keeps everything it writes in `out/governor-trace/`: the traces,
`coverage.json`, TLC's output and one verdict file per trace.

- `governor/trace/record.ts` drives `offer`, `tick`, `takeForReply`, `claim`, `markDelivered`,
  `release`, `mute`, `unmute` and `penalize` from `src/core/governor.ts` with random sequences. It
  adds the glue that Notifier and the concierge put around them: one turn at a time,
  `release(undefined)` on restart, `dislike` as `penalize(topic, now + 7 days)`. Each run is one
  NDJSON file. Line 1 holds the constants and the initial state. Each later line holds the call
  and its arguments, the notices the code handed out for sending, and the state after the call,
  mapped to the model's variables.
- `governor/trace/GovernorTrace.tla` extends `MCGovernor` with `tr` (the trace; one TLC run checks
  a batch of up to 100) and `l` (the last line matched). Each step takes the action the next line
  names. Its arguments must lie in the domains `Next` quantifies over, and the model's state after
  the step must equal the logged one. The notices the step adds to the ghost `log` must be the ones
  the code sent. Each trace gets its own verdict, because TLC's diameter, which the paper's
  `TraceAccepted` uses, covers the whole batch. A state that matches a trace's last line writes
  `accepted-<tr>.json`. A state with no matching successor writes `rejected-<tr>-<line>.json`,
  which names the call and lists each `<<variable, model, code>>` that differs. The model's
  invariants and `FinalStable` are also checked along every trace.
- `governor/trace/check.sh` records the traces, runs TLC and prints PASS or FAIL. For a rejected
  trace it prints the first unmatched step. It then runs the mutants, and each must get at least
  one trace rejected.

The discretisation is the model's. One slot is 8 hours and every call falls on a slot boundary.
The recorder picks one of the three `MCPolicies`, written as real `GovernorPolicy` objects, and
the trace checks that the header matches one of them. Zones have no DST (UTC, Karachi, Kolkata,
Tokyo, Bogotá), and slot 0 is local midnight. The bounds are larger than the model check's: up to
about 50 notices, 2 topics, 4 dedup keys, a clock of up to 30 slots (10 days, so `HISTORY_MS`
pruning happens), caller expiries of 1 to 24 slots, and mutes of 1, 2, 3 or 6 slots. One run in
five keeps a concierge turn open for days.

What the mapping loses:
- Ids become 1..N in offer order. The notice's text, `urgency` (only `effective` is kept),
  `decision`, `resolvedAt` and `ticketId` are not compared.
- The code no longer holds a notice that `tick()` pruned. Its line has status `*`, and the trace
  checks only that the model pruned it too.
- An `until` past the clock bound becomes `MaxTime + 1`, as the model's `Until()` does. Every
  comparison the code makes stays the same.
- There is no timing inside a slot, no DST, and no policy outside `MCPolicies`. Notifier's
  persistence, `checkSend()` and the outbox are not recorded. The concierge's `busy` and `peeked`
  are the recorder's own state, standing in for the turn.
- A call that changes nothing (`/digest` with nothing waiting, `unmute` of an unmuted topic) is a
  stuttering step. The model has no action for it, and the trace allows the stutter only while
  that action is disabled.

At this writing the real code passes: 100 of 100 traces with the default seeds (10,497 lines,
15 s), and 2,000 more with seeds 10000–11999 (232,390 lines, about 7 min). No divergence was found.
The mutants, all rejected with the default seeds:

| Mutant | Kind | Change | Rejected | First unmatched step |
| --- | --- | --- | --- | --- |
| no-gap | code | `offer()`: `spaced = true` | 6/40 | an `offer`: the code delivers, the model queues |
| window-boundary | code | `within24h()`: `>=` for `>` | 10/40 | an `offer` exactly 3 slots after an interrupt: the code queues, the model delivers |
| release-keeps-muted | code | `release()` ignores mutes (reverts 4d5f2c7) | 3/40 | a `restart`: the code re-queues, the model drops |
| digest-shows-stale | code | `takeForReply()` without expire-first (reverts 99a81e7) | 6/40 | a `/digest`: the code digests a stale notice, the model expires it |
| prune-claimed | code | `tick()` prunes claimed notices (reverts 4d5f2c7) | 4/40 | a `tick` in a turn days long: `kept` differs |
| unlogged-mute | recorder | `mute()` runs but its line is not written | 40/40 | the next line: `mutes[t]` (or a dropped notice) is unexplained |

Maintaining it:
- Keep `MaxTime` in `GovernorTrace.cfg` equal to `MAX_TIME` in `record.ts`, and keep the recorder's
  policies equal to `MCPolicies`. A header that matches no initial state is reported as such.
- If the code gains a governor call, a branch or a `GovernorState` field, update the model first
  (see the verify skill). Then add the call to `record.ts` (one call per line), the field to
  `abs()`, the action to `Do(e)` and `InNext(e)`, and a mutant to `check.sh`.
- If a mutant's old text is no longer in `governor.ts`, `check.sh` fails with "no longer in
  src/core/governor.ts". Copy the new text in.
- A rejected trace is either a bug or a model or mapping error. Replay it with `--replay`, read the
  differing variables, and decide as the verify skill says ("Model error or bug?"). The mapping
  (`abs()`) and the glue in `record.ts` are suspects too.
- The trace spec reads traces with `ndJsonDeserialize` and writes verdicts with `JsonSerialize`,
  both from the `Json` module bundled in TLC 1.8.0. `IOUtils` (`IOEnv`) is not in `tla2tools.jar`,
  so `check.sh` passes the trace paths in a generated module, `GovernorTraceBatch.tla`.

## The statechart

`governor/chart.mmd` was drawn by the vendored pstack `statechart` skill from `governor/chart.cfg`
(one notice, the DEFAULT_POLICY-like policy, 176 TLC states, every rule holds), using the view
`governor/chart-view.ts`. The condition "[unless Evening]" on "a notice comes in" comes from the
model's time bound (an offer must be able to expire before the clock stops), not from the code.
Read results with the `/statechart` skill.

## Not covered

- DST in `crossed()`, minute-level timing inside a slot (trace validation adds fixed-offset zones,
  but still has neither).
- More than three notices, two tool calls, or three approval rows; policies other than those listed.
- `checkSend()`, the outbox after `enqueue` (see `outbox/`), channel delivery, the HTTP server
  itself, how pairing codes are kept secret.
- `classify()` and the gate rules (which calls are risky), hash collisions, pi changing a call's
  input after the gate returns.
- Whether a concierge reply actually mentions the notices it was shown (assumed it does).
