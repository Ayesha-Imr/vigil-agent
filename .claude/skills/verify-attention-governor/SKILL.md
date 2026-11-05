---
name: verify-attention-governor
description: Model-check vigil's attention governor (TLA+/TLC) — interrupt budget and spacing, critical cap, quiet hours, mutes, dedup, every notice in exactly one state and told at most once, every waiting or claimed notice eventually resolved. Use whenever a change touches src/core/governor.ts (offer, tick, crossed, takeForReply, claim, markDelivered, release, waiting, mute, unmute, penalize, isQuiet), src/core/notifier.ts (notify, tick, takeForReply, claimForReply, releaseClaim, confirmDelivered, mute, unmute, dislike, the constructor's release), the concierge's claim/reply/confirm of waiting notices in src/agent/concierge.ts, the attention limits in src/config.ts validate(), or the daemon's /digest, /mute, Mute/Less buttons and 30-second tick in src/daemon.ts; and before claiming anything about when vigil may interrupt the owner.
---

# Verify the attention governor

`verification/governor/Governor.tla` is a TLA+ model of the governor as the daemon drives it.
Each governor call is one pure function that `Notifier` runs inside one `db.tx()` (or one
synchronous commit), so each is one step in the model. TLC checks every interleaving of: offers,
ticks, `/digest`, mute, unmute, dislike, the clock moving on, the concierge's claim → await the
model → reply-and-confirm or release, and a restart in the middle of a turn. The rules are those
of `docs/DESIGN.md`, stated over what actually reached the owner (ghost variables `log`, `sends`,
`shown`, `ownerMute`).

## Properties (property — harm if broken)

| Name | Property | Harm |
| --- | --- | --- |
| `Budget` | In every rolling day, high/normal interrupts sent on their own ≤ `maxInterruptsPerDay`, and two are ≥ `minGapMinutes` apart. | The phone buzzes more than the owner allowed. |
| `CriticalCap` | Critical deliveries in every rolling day ≤ `criticalPerDay`. | A runaway model pages the owner all night. |
| `Quiet` | During quiet hours nothing but critical is sent unasked, digests included. | A 3 a.m. buzz. |
| `NoMuted` | Nothing vigil sends unasked (on its own or in a digest) is on a topic the owner has muted. | The owner's explicit word is ignored. |
| `NoDuplicate` | Two notices that reached the owner never share a dedup key within the dedup window. | The same news twice. |
| `Conservation` | Every offered notice has one status; a waiting or claimed one is never forgotten; a notice reaches the owner at most once, and it reached the owner iff its status is `delivered`/`digested`. | A notice is lost, or told twice. |
| `NoStaleDelivery` (not a DESIGN.md rule) | Nothing reaches the owner at or after its `expiresAt`; for a concierge reply, measured when the turn claimed it. | Stale news. |
| `FinalStable` (action) | A final status never changes again. | A delivered notice is resurrected or rewritten. |
| `EventuallyResolved` (liveness, fair ticks, turns end) | Every waiting or claimed notice is eventually delivered, digested, dropped or expired. | Something waits forever. |

Solicited sends are exempt from `Quiet` and `NoMuted`: a concierge reply and `/digest` answer a
message the owner just wrote. For `NoMuted` this is the owner's decision of 2026-11-04 (until then
the rule covered replies too, and the concierge findings below broke it). `Budget` and
`CriticalCap` count only notices sent on their own.

## Run it

```sh
bash verification/run.sh --only governor          # about 1 min on 4 cores
bash verification/run.sh --only governor --deep   # adds the deeper configs (about 4 more minutes)
bash verification/mutate.sh governor              # every property fails on a broken variant (about 1 min)
```

Needs Java 11+. `verification/lib.sh` uses `$TLA2TOOLS` if set, else downloads TLC 1.8.0
(sha256-checked) once into `verification/.tools/`. Lines: `PASS` (a required config: every rule
holds), `FAIL` (a rule broke, or TLC errored: read the counterexample), `FINDING` (a
`findings/*.cfg` reproduced the violation it records), `FIXED?` (a finding no longer reproduces:
see below). The summary line is `governor: PASS (N open findings reproduce as recorded)` or
`governor: FAIL`. TLC's full output per check is in `verification/out/<spec>-<config>.out`.

## Files

- `Governor.tla` — the model; every action's comment names the code it mirrors.
- `MCGovernor.tla` — the policies (`MCPolicies`, `ChartPolicies`, `LongExpiryPolicies`) and symmetry.
- Required, run by `run.sh`:
  `Governor.cfg` (governor calls and owner feedback, 2 notices),
  `Governor_three.cfg` (3 notices, no feedback),
  `Governor_live.cfg` (liveness),
  `Governor_concierge.cfg` (the concierge path, every reply outcome, restarts),
  `Governor_concierge_mute.cfg` (concierge path plus mutes during a turn, 1 notice),
  `Governor_live_concierge.cfg` (liveness with claims and restarts),
  `Governor_long_expiry.cfg` (notices that outlive `HISTORY_MS`).
- `--deep`: `Governor_deep.cfg` (callers set their own `expiresAt`), `Governor_concierge_feedback.cfg`
  (concierge path plus mutes, 2 notices, about 5M states).
- `findings/*.cfg` — none open at the sync commit. A finding config starts with `\* FINDING:` and
  `\* expect: <rule>`, and must break that rule.
- `chart.cfg`, `chart-view.ts`, `chart.mmd` — a one-notice config, its view, and the statechart drawn from it.
- Mutants: `verification/mutants/governor-*.mutant`, each naming the code change it mirrors.

## Reading results

Read every TLC result with the pstack `/statechart` skill (vendored in `skills/statechart/`). For
a violation it gives the shortest path to the bad state in plain words; on a pass it draws how
the system moves between states. Start from `chart.cfg` and `chart-view.ts`: the full configs are
far above its 500-state chart budget.

By hand: in `verification/out/…out`, after `Error: Invariant X is violated.`, each `State k:
<Action …>` is one step. Map each action to code with the table below and tell the trace in the
code's words, for example: "`Notifier.notify` holds a normal notice at 23:00 (`offer` step 5) →
the owner writes, the concierge's turn calls `claimForReply()` → the owner mutes the topic →
the turn ends with no model text, `releaseClaim()` → the 08:00 tick sends the morning digest".
A slot is 8 hours: slot 0 = 00–08 (night), 1 = 08–16, 2 = 16–24. `pol` is the policy of that behavior.

## Model error or bug?

Replay the trace against the code, one action at a time.

- If a step cannot happen in the code (a guard the code has and the model lacks, a value the code
  cannot hold, two steps the code runs without an `await` between them split in the model), the
  model is wrong: fix it, say what was wrong, and rerun `mutate.sh`.
- If every step can happen, it is a bug. Report it with the steps in the code's words and the harm
  in one sentence; if you can, replay it against the real code with the test harness
  (`test/helpers/harness.ts`) in a scratch test. Do not weaken the property, the bounds or the
  model, and do not edit product code unless the user asks. Add `findings/<Name>.cfg` with
  `\* expect: <rule>` so the next run tracks it.
- Artifacts of the bound, not bugs: an offer needs `now + expiry <= MaxTime` (the chart's
  "a notice comes in [unless Evening]"), and the clock stops at `MaxTime`.

## Action ↔ code (sync commit)

| Action | Code |
| --- | --- |
| `Offer` | `offer()` src/core/governor.ts:128 via `Notifier.notify` src/core/notifier.ts:64 (an unroutable notice is offered as `low`; the free choice of urgency covers it) |
| `Tick` | `tick()` governor.ts:234 (`crossed()` :216, `flush()`, the prune keeps waiting and claimed notices) via `Notifier.tick` notifier.ts:86, every 30 s from `Daemon.tickGovernorAndClock` src/daemon.ts:296 |
| `DigestCommand` | `/digest` daemon.ts:744 → `Notifier.takeForReply` notifier.ts:105 → `takeForReply()` governor.ts:290 (expires stale notices first) |
| `ConciergeClaim` | src/agent/concierge.ts:168 `claimForReply()` (notifier.ts:116) → `claim()` governor.ts:302: waiting, unexpired notices become `claimed` |
| `ConciergeReply(o)` | concierge.ts:183–194: a reply with model text (`"stored"`, or `"partial"` when `r.error` is also set) → `this.reply()` then `confirmDelivered()` (notifier.ts:136 → `markDelivered()` governor.ts:314); no model text, SILENT, or a thrown turn (`finally`) → `releaseClaim()` (notifier.ts:125 → `release()` governor.ts:330, which drops a notice whose topic is muted now) |
| `Restart` | the `Notifier` constructor, notifier.ts:60: `releaseClaim(undefined)`, i.e. `release(state, undefined, now)` for every claim in one `db.tx()` (it also records the notices it drops; the model does not track the notices table) |
| `Mute` / `Unmute` | `mute()` governor.ts:350 / `unmute()` :360 via `Notifier.mute` notifier.ts:146 / `unmute` :155 (`/mute` daemon.ts:729, 😴 reaction, 🔕 button, the `mute_topic` tool) |
| `Penalize` | `penalize()` governor.ts:367 via `Notifier.dislike` notifier.ts:160 (👎 reaction or button) |
| `Advance` | `Clock.now()` moves on |

Assumptions: a stored reply tells the owner every notice its prompt listed; `this.reply()` and
`confirmDelivered()` run with no crash between them (no `await` between); policies satisfy
`validate()` (minGapMinutes ≤ 1440, dedupWindowMinutes ≤ 10080).
Not modeled: DST (`crossed()`'s spring-forward and `repeatedHour()` handling), `checkSend()` in
src/core/invariants.ts (a runtime net that only refuses sends, so the rules are checked without
it), the outbox after `enqueue` (see `verification/outbox/`), minutes inside a slot, more than 3
notices, policies other than those in `MCGovernor.tla`.

## Coverage record

Sync commit: `f3ff16b37ead2f70cad41f3e2f1529f07c71d150` (covered files clean at that commit).
Git blob ids at the sync commit, so `git hash-object FILE` tells you at once whether a file changed:

| File | Code covered | Blob |
| --- | --- | --- |
| src/core/governor.ts | `isQuiet`, `within24h`, `lower`, `offer`, `crossed` (non-DST), `tick`, `flush`, `takeForReply`, `claim`, `markDelivered`, `release`, `waiting`, `mute`, `unmute`, `penalize` | `44eb7a53ce88062abc42d3f065f8e3588d96394e` |
| src/core/notifier.ts | constructor `releaseClaim(undefined)`, `notify`, `tick`, `takeForReply`, `claimForReply`, `releaseClaim`, `confirmDelivered`, `mute`, `unmute`, `dislike` | `fd639270266bd09a3490dee45d6751b2bb7534d2` |
| src/agent/concierge.ts | the owner-message turn: claim, reply, confirm or release (also in `finally`) | `d160c50c41068ae74c2ce9c479d0ee5d66322829` |
| src/daemon.ts | `tickGovernorAndClock`, `/digest`, `/mute`, Mute/Less buttons | `7a12c62c787931e3af00c101df4b5220cecadd91` |
| src/config.ts | `validate()` limits on `minGapMinutes` and `dedupWindowMinutes` | `aebcafe815d39402c7a244a52a5f92ee7d782bb0` |
| src/core/time.ts | `inWindow`, `DAY` | `cfb2b046396ec620023cc7df8991001295991fc0` |

To find drift: `git diff f3ff16b -- src/core/governor.ts src/core/notifier.ts src/agent/concierge.ts src/daemon.ts src/config.ts src/core/time.ts`,
and look for new code that writes `GovernorState`, calls `claimForReply()`, `takeForReply()`,
`markDelivered()` or `release()`, or sends a notice without `notify()`.

## When the code changes on purpose

1. Read the diff of the covered files since the sync commit. For each change decide: no effect on
   the model; the model no longer describes the code (a step split in two, a branch added or
   removed, a new caller of a governor function); or the promise changed on purpose (cite the doc
   comment, test, commit message or the owner's decision).
2. Change `Governor.tla` from the code, not from the result: one indivisible step in the code is
   one action, and the action's comment names the code. Change a property only for a promise that
   changed on purpose, and write down the old and new wording (as for `NoMuted` above).
3. Run `bash verification/run.sh --only governor` and `bash verification/mutate.sh governor`. Every
   mutant must still be caught; add one for each new check in the code (`verification/mutants/*.mutant`:
   `spec`, `run`, `config`, `check`, `kind`, `code`, then `@@@ old` / `@@@ new` / `@@@ end` blocks
   with text copied exactly from the model).
4. Move the sync commit and the blob ids forward only after you confirm the model describes the
   code at the new commit. Copy this file to `.pi/skills/verify-attention-governor/SKILL.md`.

## When a finding stops reproducing

`FIXED?` means a `findings/*.cfg` now passes. Read the code change: if it fixes the finding, check
that `Governor.tla` describes the fixed code, delete the finding, add a mutant that reverts the
fix, and record it under "Fixed findings". If no code change explains it, the model drifted: find
out why before trusting any pass.

## Fixed findings (history)

| Finding | Rule | Fixed in |
| --- | --- | --- |
| ConciergeToldTwice: the concierge's turn peeked waiting notices; a tick (or `/digest`) digested them during the turn; the reply told them again | Conservation | 99a81e7 (claim at the start of the turn; mutants governor-12, -14) |
| ConciergePartialReply: a reply with `r.error` and text was stored but not confirmed; its notices went out again | Conservation | 99a81e7 (confirm whenever model text was stored; governor-13) |
| ConciergeMutedDuplicate: a notice dropped by a mute during the turn was told by the reply; dedup ignored the dropped notice and the news went out again | NoDuplicate | 99a81e7 (claimed notices are not dropped by mute) |
| ConciergeMuted: a mute during the turn; the reply still told the notice | NoMuted | owner decision: replies are solicited |
| DigestCommandStale: `/digest` showed a notice past `expiresAt` before the next tick | NoStaleDelivery | 99a81e7 (`takeForReply()` expires first; governor-17) |
| WindowGap / WindowDedup: `minGapMinutes` > 24 h or `dedupWindowMinutes` > 7 days outlived what `tick()` keeps | Budget / NoDuplicate | 99a81e7 (`validate()` rejects them; the policies are no longer modeled) |
| ClaimPruned: a claimed notice older than `HISTORY_MS` was pruned by a tick mid-turn | Conservation | 4d5f2c7 (prune keeps claimed; `Governor_long_expiry.cfg`, governor-18) |
| MutedAfterRelease: a mute during the turn, then no reply: `release()` put the notice back and the next digest sent it on the muted topic | NoMuted | 4d5f2c7 (`release()` drops it; `Governor_concierge_mute.cfg`, governor-19) |
