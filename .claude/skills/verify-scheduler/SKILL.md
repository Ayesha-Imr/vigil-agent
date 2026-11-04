---
name: verify-scheduler
description: Model-check vigil's job scheduler (TLA+/TLC) — one trigger per slot, no self-overlap, no lost slot, "at" jobs fire once, claimed runs complete (also across a crash). Use whenever a change touches src/core/scheduler.ts (nextRunAt, countSlots, claimDue, complete, unfinishedRuns, recover), the triggers table in src/store/db.ts, or Daemon.start / tickGovernorAndClock / runJob / finish / reprocessStuckTriggers in src/daemon.ts, or the concierge's `done` callback path for system inputs; and before claiming anything about job timing, coalescing or crash recovery.
---

# Verify the scheduler

`verification/scheduler/Scheduler.tla` is a TLA+ model of how vigil turns job schedules into
runs: `claimDue` (one `Db.tx()`), the in-flight run (`runJob`, which awaits a concierge turn,
heartbeat or dream), `finish()` → `complete(jobId, status, claimedAt)`, a crash (memory gone,
DB kept), and `Daemon.start` (`recover()` + `unfinishedRuns(DAY)` up to its first await, the
replayed `runJob` calls after the awaits, and only then the 30 s claim timer). TLC checks every
interleaving of those steps within the bounds below.

## Properties (property — harm if broken)

| Name | Property | Harm |
| --- | --- | --- |
| `OneTriggerPerSlot` | A job's slot never yields two trigger rows. | The owner's job runs twice for one scheduled time. |
| `NoOverlap` | A job never has two runs in flight at once (assuming every run ends within `RUN_LEASE_MS` of its claim). | Two heartbeats or two copies of an owner job act at the same time. |
| `OverlapOnlyAfterLease` | When runs can outlive the lease, a second run starts only after the first held the job for longer than `RUN_LEASE_MS`. | After one long run, overlapping runs no longer wait for the lease. |
| `NoLostSlot` | Every due slot is either the trigger's own slot or counted in its `coalesced`, and none is counted twice. | The concierge is told a wrong number of missed runs. |
| `AtJobsFireOnce` | An `at` job yields at most one trigger. | A one-off reminder or action fires twice. |
| `ClaimedRunCompletes`, `AtJobRuns` (liveness) | Every claimed run reaches `finish()`, also across a crash; an `at` job within the bound runs to completion. | A scheduled action silently never happens. |

## Run it

```sh
verification/scheduler/check.sh           # ~45-60 s on 4 cores
verification/scheduler/check.sh --deep    # adds SchedulerDeep.cfg (~2 min)
```

Needs Java 17+ and `tla2tools.jar` (env `TLA2TOOLS_JAR`, else `/home/user/tools/tla2tools.jar`
or `~/tools/tla2tools.jar`); last run with TLC 2026.11.03.180953 (rev 309e489). It prints one
`PASS`/`FAIL` line per check and ends with `ALL AS EXPECTED` (exit 0) or `UNEXPECTED RESULTS`
(exit 1). `PASS` means "the result was the expected one".

One check by hand (from `verification/scheduler`):

```sh
java -XX:+UseParallelGC -DTLA-Library=$PWD -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers auto -cleanup \
  -noGenerateSpecTE Scheduler.tla -config regressions/StaleComplete.cfg
```

## Files

- `Scheduler.tla` — the model of the current code; each action has a `\* code: file:line` line.
- Required (must pass): `Scheduler.cfg` (safety, 2 crashes), `SchedulerLive.cfg` (liveness,
  1 crash), `SchedulerLease.cfg` (runs may outlive the lease); `SchedulerDeep.cfg` with `--deep`.
- `regressions/*.cfg` — the old findings S1–S3, fixed in 166ea0c; must pass.
- `bydesign/*.cfg` — characterisations that must FAIL as named (see below).
- `mutants/*.tla|cfg` — one broken variant per property (several revert a fix), each with the
  code mutation written at the top; must fail as named. `MutRewindOnly` and `MutNoUniqueOnly`
  are guard demos that must PASS: each removes one of the two guards of `OneTriggerPerSlot`.

## Coverage record

Sync commit: `ef2c26f70f347992c3a4acbf23915db9bda33ef5` (covered files clean at that commit).

| File | Function / code | Lines | Model |
| --- | --- | --- | --- |
| src/core/scheduler.ts | `RUN_LEASE_MS`, `nextRunAt` (every, at) | 50, 52–70 | `LEASE`, `NextRunAt` |
| src/core/scheduler.ts | `countSlots` (break on `next > to`, line 79) | 72–84 | `CountLoop`, `CountSlots` |
| src/core/scheduler.ts | `Scheduler.claimDue` (due query, INSERT … ON CONFLICT, `fresh`, UPDATE, `claimedAt: now`) | 139–182 | `Due`, `Fresh`, `ClaimDueWith` |
| src/core/scheduler.ts | `Scheduler.complete(jobId, status, claimedAt)` | 184–197 | `FinishWith`, `ReleaseMine` |
| src/core/scheduler.ts | `Scheduler.unfinishedRuns(maxAgeMs)`, `recover` | 199–225 | `RestartWith`, `Stuck`, `Newest` |
| src/store/db.ts | `triggers` … `UNIQUE (source, external_id)` | 12–24 | `Fresh` |
| src/daemon.ts | `start`: takeLock, recover, unfinishedRuns(DAY) … await reprocessStuckTriggers, replayed runJob, timers | 218–266 | `Restart`, `DispatchReplays` |
| src/daemon.ts | `tickGovernorAndClock` (claimDue → `void this.runJob`) | 252, 290–297 | `ClaimDue` |
| src/daemon.ts | `runJob` / `finish` (complete with `run.claimedAt` + trigger `done`), `done: finish` | 320–372 | `RunFinishes` |
| src/daemon.ts | `reprocessStuckTriggers` (still skips `source 'clock'`; replay is `unfinishedRuns`) | 861–876 | — |
| src/agent/concierge.ts | `pump`'s catch calls `cur.done` for a system run; `handle` → `input.done?.(...)` | 105–125, 144–209 | when `RunFinishes` happens |

Before trusting a result, check whether the covered code moved:

```sh
git -C /home/user/vigil-agent diff --stat ef2c26f70f347992c3a4acbf23915db9bda33ef5 -- \
  src/core/scheduler.ts src/store/db.ts src/daemon.ts src/agent/concierge.ts
```

If a covered function changed, re-read it against the action that cites it before you run
the check. Move the sync commit forward (here and in `.pi/skills/verify-scheduler/SKILL.md`)
only after you confirmed the model describes the code at the new commit; then update the lines.

## Findings history

All fixed in 166ea0c ("fix: bugs found by model checking the scheduler and worker pool"); each
now has a regression config that must pass and a mutant that reverts the fix and must fail.

- **S1 — a slot exactly at the claim instant was lost** (`regressions/LostSlotAtNow.cfg`,
  `NoLostSlot`; revert: `MutCountGe`). `countSlots` broke on `next >= to`; now `next > to`.
- **S2 — a stale `complete()` freed a re-claimed job** (`regressions/StaleComplete.cfg`,
  `OverlapOnlyAfterLease`; revert: `MutCompleteById`). Now `complete` clears `running_since`
  only when it equals the run's `claimedAt`.
- **S3 — a claimed run cut by a crash never ran** (`regressions/CrashDropsRun.cfg`,
  `AtJobRuns`; revert: `MutNoReplay`). Now `Daemon.start` replays each job's newest `received`
  clock trigger from `unfinishedRuns(DAY)`, holding the job (`MutReplayNoHold` shows the hold
  is needed: without it the next slot's claim overlaps the replayed run).

No open findings.

## By design (must fail as named)

- **Overlap after the lease** (`bydesign/LeaseOverlap.cfg`, `NoOverlap`). A run that outlives
  `RUN_LEASE_MS` (6 h) is presumed dead and the next claim overlaps it. That is the only way two
  runs of one job overlap now (`OverlapOnlyAfterLease` holds).
- **The replay window** (`bydesign/ReplayWindow.cfg`, `AtJobRuns`). `unfinishedRuns(DAY)` only
  replays triggers younger than a day: if vigil stays down longer, a claimed run is never run
  and its trigger stays `received`.
- Not a check, but true of the code: a replayed run is at-least-once. If the process died
  between a run's side effect and `finish()`, the run happens again; 4e2683a made `remind` and
  `ticket` runs idempotent per slot, `agent` runs (concierge turns) are not.

## Reading a counterexample

Read every TLC result with the pstack `/statechart` skill: it gives the shortest path to each
broken rule in plain words and draws the states. Map each step to code: `Tick` (time passes),
`ClaimDueWith` (= `claimDue` + `runJob` start), `RunFinishes` (`finish()` → `complete()`),
`Crash`, `RestartWith` (`Daemon.start` up to its first await: `recover()` + `unfinishedRuns`),
`DispatchReplays` (the replayed `runJob` calls; the claim timer exists from then on).
Variables are DB columns: `nextRun` = `next_run_at`, `runningSince` = `running_since`,
`triggers` = rows of `triggers` (`coalesced` from the payload, `at` = `created_at`), `runs` =
in-memory `runJob` calls (`started` = `claimedAt`), `replay` = the list `unfinishedRuns`
returned, `starting` = `Daemon.start` has not created its timers. `Null` is -1. Then replay the
path on the real code before calling it a bug: a scratch script with `new Db(":memory:")` (or a
file, for a crash), `ManualClock` and `Scheduler`, one call per step.

## Model error or bug?

- A step the code cannot take (a claim while `starting`, two claims at one instant without a
  `finish`, a run finishing twice) → model error: fix the action and cite the line. Example
  from the last sync: time passing during `Daemon.start`'s awaits made a replayed run's lease
  expire before it was dispatched; the assumption "runs end within the lease" had to count
  from `claimedAt` for replayed runs too.
- A step the code can take only outside the assumptions below → out of scope; say so.
- The path replays on the real code → bug: report it with the path in the code's words. Never
  weaken a property or the model to make it pass; do not change `src/` unless asked.

## When the code changes on purpose

1. Find the action whose `\* code:` line cites the changed lines; make it do exactly what the
   new code does (one `Db.tx()` or one synchronous block = one action; each `await` = a step
   boundary).
2. A new guard or path gets a mutant in `mutants/` that removes it (code mutation at the top),
   added to `check.sh` with its expected violation.
3. A fixed finding becomes a config in `regressions/` plus a mutant that reverts the fix.
4. Run `check.sh` (and `--deep` before a release), then update the coverage table and the sync
   commit here and in the `.pi` copy.

## Bounds, assumptions, not covered

- Bounds: one `every` job (period 2) and one `at` job (time 3), lease 3, replay window 20
  (longer than the clock, except `ReplayWindow.cfg`: 2), clock 0..14 (main/lease), 0..12
  (live), 0..9 (regressions, by-design, mutants), 0..18 (`--deep`); at most 2 crashes (main),
  1 (live, lease), 3 (deep). A pass covers these bounds only.
- Time is abstract integers; `every` is `after + period` exactly as the code computes it.
  `cron` is not modelled separately: its `nextRunAt` is also strictly after `after` and
  `countSlots` iterates it the same way (argued, not checked).
- Assumes one daemon per database. Since 4f5ff60 `Daemon.start` takes `daemon.lock` in one
  immediate transaction (two starts are serialized), refuses while the holder is a live vigil
  with a fresh heartbeat, and a daemon that finds it lost the lock stops itself (outbox findings
  F2b/F2c). A holder whose heartbeat is over 2 minutes old can still be taken over while alive
  (a long event-loop stall), and it then runs until its next heartbeat; not modelled. Also assumes a
  clock that does not go backwards, and that `finish()`'s two statements are not split by a
  process kill (a kill between them only makes the run repeat after the restart).
- Not covered: `create`, `ensure` (system jobs re-armed at start), `setEnabled`, `remove`,
  `/pause` (claimDue skipped while paused; slots then coalesce), what a run does (outbox,
  tickets; the per-slot idempotence of `remind`/`ticket`), the concierge queue order and
  preemption (only "`done` is eventually called" is assumed, except in `MutDropDone`), the
  1000-slot cap in `countSlots`, `dropped` triggers (older `received` ones superseded at a
  restart, which only happens when runs outlive the lease).
