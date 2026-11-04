---
name: verify-attention-governor
description: Model-check vigil's attention governor (TLA+/TLC) — interrupt budget and spacing, critical cap, quiet hours, mutes, dedup, every notice in exactly one state and told at most once, every waiting notice eventually resolved. Use whenever a change touches src/core/governor.ts (offer, tick, crossed, takeForReply, markDelivered, waiting, mute, unmute, penalize, isQuiet), src/core/notifier.ts (notify, tick, takeForReply, confirmDelivered, mute, unmute, dislike), the concierge's peek/confirm of waiting notices in src/agent/concierge.ts, or the daemon's /digest, /mute, Mute/Less buttons and 30-second tick in src/daemon.ts; and before claiming anything about when vigil may interrupt the owner.
---

# Verify the attention governor

`verification/governor/Governor.tla` is a TLA+ model of the governor as the daemon drives it.
Each governor call is one pure function that `Notifier` runs inside one `db.tx()`, so each is one
step in the model. TLC checks every interleaving of these steps within the bounds below: offers,
ticks, `/digest`, mute, unmute, dislike, the clock moving on, and the concierge's
peek → await model → reply → confirm. The model is checked against the rules in
`docs/DESIGN.md`, stated over what actually reached the owner (ghost variables `log`, `sends`,
`ownerMute`).

## Properties (property — harm if broken)

| Name | Property | Harm |
| --- | --- | --- |
| `Budget` | In every rolling day, high/normal interrupts sent on their own ≤ `maxInterruptsPerDay`, and two are ≥ `minGapMinutes` apart. | The phone buzzes more than the owner allowed. |
| `CriticalCap` | Critical deliveries in every rolling day ≤ `criticalPerDay`. | A runaway model pages the owner all night. |
| `Quiet` | During quiet hours nothing but critical reaches the owner unasked, digests included. Replies (concierge, `/digest`) are solicited and exempt. | A 3 a.m. buzz. |
| `NoMuted` | Nothing reaches the owner on a topic while the owner has it muted. | The owner's explicit word is ignored. |
| `NoDuplicate` | Two notices that reached the owner never share a dedup key within the dedup window. | The same news twice. |
| `Conservation` | Every offered notice has one status; a waiting one is never forgotten; a notice reaches the owner at most once, and it reached the owner iff its status is `delivered`/`digested`. | A notice is lost, or told twice. |
| `FinalStable` (action) | A final status never changes again. | A delivered notice is resurrected or rewritten. |
| `EventuallyResolved` (liveness, fair ticks) | Every waiting notice is eventually delivered, digested, dropped or expired. | Something waits forever. |
| `NoStaleDelivery` (findings only, not a DESIGN.md rule) | Nothing reaches the owner at or after its `expiresAt`. | Stale news. |

## Run it

```sh
bash verification/run.sh --only governor     # about 1-2 min on 4 cores
bash verification/run.sh --only governor --deep   # adds the deeper configs (a few more minutes)
bash verification/mutate.sh governor         # every property fails on a broken variant (about 40 s)
```

Needs Java 11+. `verification/lib.sh` uses `$TLA2TOOLS` if set, else downloads TLC 1.7.4
(sha256-checked) once into `verification/.tools/`. Output lines:

- `PASS` — a required config or a modeled fix: every rule in it holds.
- `FAIL` — a required config broke a rule, or TLC stopped with an error. Read the counterexample.
- `FINDING` — a `findings/*.cfg` reproduced the violation it records (an open finding, below).
- `FIXED?` — a finding no longer reproduces. See "When a finding stops reproducing".

The last line per spec is `governor: PASS (N open findings reproduce as recorded)` or
`governor: FAIL`. TLC's full output for each check is in `verification/out/<spec>-<config>.out`.

## Files

- `Governor.tla` — the model. Every action's comment names the code it mirrors.
- `MCGovernor.tla` — concrete policies (`MCPolicies`), symmetry, and the policies for findings and the chart.
- Required (must pass): `Governor.cfg` (all governor calls and owner feedback, 2 notices),
  `Governor_three.cfg` (3 notices, no feedback), `Governor_live.cfg` (liveness),
  `Governor_concierge.cfg` (with the concierge path; it leaves out the rules that the findings
  below record as broken), `fixes/ClaimOnPeek.cfg` (the suggested fix, modeled).
- Deeper (`--deep`): `Governor_deep.cfg` (callers set their own `expiresAt`), `fixes/ClaimOnPeek_deep.cfg`.
- `findings/*.cfg` — each starts with `\* FINDING:` and `\* expect: <rule>`; it must break that rule.
- `chart.cfg`, `chart-view.ts`, `chart.mmd` — a one-notice config, its view, and the statechart drawn from it.
- Mutants: `verification/mutants/governor-*.mutant`, each naming the code change it mirrors.

## Reading results

Read every TLC result with the pstack `/statechart` skill (vendored in `skills/statechart/`). For
a violation it gives the shortest path to the bad state in plain words; on a pass it draws how
the system moves between states. Use `chart.cfg` and `chart-view.ts` as the starting config
and view: the full configs are far above its 500-state chart budget.

By hand: in `verification/out/…out`, after `Error: Invariant X is violated.`, each `State k:
<Action …>` is one step. Map each action to code with the table below, and tell the trace as
steps in the code's words, for example: "`Notifier.notify` holds a normal notice at 23:00
(`offer` step 5) → the owner writes, the concierge's turn runs `notifier.waiting()` → the 08:00
tick crosses the end of quiet hours and `tick()` flushes it into the morning digest → the turn
ends, `this.reply()` stores a reply that lists it again." A slot is 8 hours: slot 0 = 00–08
(night), 1 = 08–16, 2 = 16–24. `pol` in the trace is the policy of that behavior.

## Model error or bug?

Replay the trace against the code, one action at a time.

- If a step cannot happen in the code (a guard the code has and the model lacks, a value the
  code cannot hold, two steps the code runs without an `await` between them split in the model),
  the model is wrong: fix the model, say what was wrong, and rerun `mutate.sh`.
- If every step can happen, it is a bug. Report it with the steps in the code's words and the
  harm in one sentence. Do not weaken the property, the bounds, or the model to make it pass,
  and do not edit product code unless the user asks. Add a `findings/<Name>.cfg` with
  `\* expect: <rule>` so the next run tracks it.
- Artifacts of the bound, not bugs: an offer needs `now + expiry <= MaxTime`, so the chart shows
  "a notice comes in [unless Evening]"; the clock stops at `MaxTime`.

## Action ↔ code

| Action | Code (sync commit) |
| --- | --- |
| `Offer` | `offer()` src/core/governor.ts:121, via `Notifier.notify` src/core/notifier.ts:60 (an unroutable notice is offered as `low`; the model's free choice of urgency covers it) |
| `Tick` | `tick()` governor.ts:227 (`crossed()` :209, `flush()` :266), via `Notifier.tick` notifier.ts:82, every 30 s from `Daemon.tickGovernorAndClock` src/daemon.ts:255 |
| `DigestCommand` | `/digest` src/daemon.ts:676 → `Notifier.takeForReply` notifier.ts:101 → `takeForReply()` governor.ts:282 |
| `ConciergePeek` | src/agent/concierge.ts:167 `const waiting = this.s.notifier.waiting()` (`waiting()` governor.ts:304), then the turn awaits `promptWithFallback` |
| `ConciergeReply(o)` | concierge.ts:181–184: `this.reply(input, out)`, then `confirmDelivered` (notifier.ts:112 → `markDelivered()` governor.ts:291) only when `!r.error`. `"stored"` = reply without error, `"partial"` = `r.error` with text, `"none"` = no text or SILENT |
| `Mute` / `Unmute` | `mute()` governor.ts:309 / `unmute()` :319 via `Notifier.mute` notifier.ts:122 / `unmute` :131 (`/mute`, 😴 reaction, the 🔕 button, the `mute_topic` tool) |
| `Penalize` | `penalize()` governor.ts:326 via `Notifier.dislike` notifier.ts:136 (👎 reaction or button) |
| `Advance` | `Clock.now()` moves on |

Not modeled: DST (`crossed()`'s spring-forward and `repeatedHour()` handling; the model's clock has
no DST), `checkSend()` in src/core/invariants.ts (a runtime net that only refuses sends, so the
rules are checked without it), outbox delivery after `enqueue` (see the outbox verification),
real minutes inside a slot, more than 3 notices, policies other than `MCPolicies`.

## Coverage record

Sync commit: `4c99637b24dc9967b2dd55f5ad77bb5296605d61` (covered files clean at that commit).
Git blob ids of the covered files at the sync commit, so `git hash-object FILE` tells you at
once whether a file changed:

| File | Functions covered | Blob |
| --- | --- | --- |
| src/core/governor.ts | `isQuiet`, `within24h`, `lower`, `offer`, `crossed` (non-DST behavior), `tick`, `flush`, `takeForReply`, `markDelivered`, `waiting`, `mute`, `unmute`, `penalize` | `e8cf2b22aab5da9009741e46cda65f8a8f949d01` |
| src/core/notifier.ts | `notify`, `tick`, `takeForReply`, `confirmDelivered`, `mute`, `unmute`, `dislike` | `97dbe4a1b19eaa615fc291ae69be2b454728fb8d` |
| src/agent/concierge.ts | the owner-message turn: `waiting()` peek, `reply`, `confirmDelivered` | `fb38adaf9d0e4117d71c091bbf444b8c2ac36fed` |
| src/daemon.ts | `tickGovernorAndClock`, `/digest`, `/mute`, Mute/Less buttons | `f050e25a3668d447257273ac4395368e656228d8` |
| src/core/time.ts | `inWindow`, `DAY` | `cfb2b046396ec620023cc7df8991001295991fc0` |

To find drift: `git diff 4c99637 -- src/core/governor.ts src/core/notifier.ts src/agent/concierge.ts src/daemon.ts src/core/time.ts`,
and look for new code that writes `GovernorState`, calls `waiting()`/`takeForReply()`/`markDelivered()`, or sends a notice without `notify()`.

## When the code changes on purpose

1. Read the diff of the covered files since the sync commit.
2. For each change decide: no effect on the model; the model no longer describes the code (a
   step split in two, a branch added or removed, a new caller of a governor function); or the
   promise changed on purpose (cite the doc comment, test or commit message).
3. Change `Governor.tla` from the code, not from the result: keep one indivisible step in the
   code as one action, and name the code in the action's comment. Change a property only for
   a promise that changed on purpose, and write down the old and new wording.
4. Run `bash verification/run.sh --only governor` and `bash verification/mutate.sh governor`.
   Every mutant must still be caught; add a mutant for any new check in the code
   (`verification/mutants/*.mutant`: `spec`, `run`, `config`, `check`, `kind`, `code`, then
   `@@@ old` / `@@@ new` / `@@@ end` blocks with text copied exactly from the model).
5. Move the sync commit and the blob ids above forward only after you confirm the model
   describes the code at the new commit. Copy this file to `.pi/skills/verify-attention-governor/SKILL.md`.

## When a finding stops reproducing

`FIXED?` means a `findings/*.cfg` now passes. Read the code change: if it fixes the finding,
model the fix in `Governor.tla` the way the code does it, delete the finding file (or the fix
switch, see `ClaimOnPeek`), and add its rule back to the required config it was left out of.
If no code change explains it, the model drifted: find out why before trusting any pass.

## Open findings at the sync commit

1. `ConciergeToldTwice` (Conservation): the concierge's turn peeks waiting notices, the 30-s tick
   (or `/digest`) then digests them, and the stored reply tells them again. Same root:
   `ConciergePartialReply` (a reply with `r.error` and text tells them but confirms none) and
   `ConciergeMutedDuplicate` (NoDuplicate). Suggested fix, modeled as `ClaimOnPeek` and passing in
   `fixes/`: claim the notices at the peek (a status `telling` that `tick`, `takeForReply`, `mute`
   and expiry leave alone, kept by history pruning), mark them digested when a reply is stored
   (with or without error), release them to their old status when no reply is stored.
2. `ConciergeMuted` (NoMuted), and `ConciergeMutedAfterFix`: a mute while the turn runs cannot
   unsay the reply. Owner decision: treat a reply the owner asked for as solicited for NoMuted
   too, or drop muted topics from the reply text before `this.reply()`.
3. `DigestCommandStale` (NoStaleDelivery, not a DESIGN.md rule): `takeForReply()` does not expire
   first, so `/digest` can show a notice up to 30 s past `expiresAt`. Fix: skip `n.expiresAt <= now`
   in `flush()`'s callers that run outside `tick()`.
4. `WindowGap` (Budget) and `WindowDedup` (NoDuplicate): `src/config.ts` accepts
   `minGapMinutes` above 24 h and `dedupWindowMinutes` above 7 days, but `tick()` keeps only a
   day of interrupts and 7 days of resolved notices. Fix: reject such values in `validate()`, or
   prune with `Math.max(DAY, minGap)` and `Math.max(HISTORY_MS, dedupWindow)`.
