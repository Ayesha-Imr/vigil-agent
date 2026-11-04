---
name: verify-scheduler
description: Model-check vigil's job scheduler (TLA+/TLC) — one trigger per slot, no self-overlap, no lost slot, "at" jobs fire once, claimed runs complete. Use whenever a change touches src/core/scheduler.ts (nextRunAt, countSlots, claimDue, complete, recover), the triggers table in src/store/db.ts, or Daemon.start / tickGovernorAndClock / runJob / reprocessStuckTriggers in src/daemon.ts, or the concierge's `done` callback path for system inputs; and before claiming anything about job timing, coalescing or crash recovery.
---

# Verify the scheduler

`verification/scheduler/Scheduler.tla` is a TLA+ model of how vigil turns job schedules into
runs: `claimDue` (one `Db.tx()`), the in-flight run (`runJob`, which awaits a concierge turn,
heartbeat or dream), `finish()` → `complete()`, a crash (memory gone, DB kept) and restart
(`recover()`). TLC checks every interleaving of those steps within the bounds below.

## Properties (property — harm if broken)

| Name | Property | Harm |
| --- | --- | --- |
| `OneTriggerPerSlot` | A job's slot never yields two trigger rows. | The owner's job runs twice for one scheduled time. |
| `NoOverlap` | A job never has two runs in flight at once (assuming every run ends within `RUN_LEASE_MS`). | Two heartbeats or two copies of an owner job act at the same time. |
| `OverlapOnlyAfterLease` | When runs can outlive the lease, a second run starts only after the first held the job for longer than `RUN_LEASE_MS`. | The lease's "one extra run, and only after 6 h" promise turns into back-to-back overlapping runs. |
| `NoLostSlot` | Every due slot is either the trigger's own slot or counted in its `coalesced`, and none is counted twice. | The concierge is told a wrong number of missed runs. |
| `AtJobsFireOnce` | An `at` job yields at most one trigger. | A one-off reminder or action fires twice. |
| `ClaimedRunCompletes`, `AtJobRuns` (liveness) | Every claimed run reaches `finish()`; an `at` job within the bound runs to completion. | A scheduled action silently never happens. |

## Run it

```sh
verification/scheduler/check.sh
```

About 10–25 s on 4 cores. Needs Java 17+ and `tla2tools.jar` (env `TLA2TOOLS_JAR`, else
`/home/user/tools/tla2tools.jar` or `~/tools/tla2tools.jar`); last run with TLC
2026.11.03.180953 (rev 309e489). It prints one `PASS`/`FAIL` line per check and ends with
`ALL AS EXPECTED` (exit 0) or `UNEXPECTED RESULTS` (exit 1). `PASS` means "the result was the
expected one": the model of the current code passes, each finding still reproduces, each fix
variant passes, and each mutant shows its named violation.

To run one check by hand (from `verification/scheduler`):

```sh
java -XX:+UseParallelGC -DTLA-Library=$PWD -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers auto -cleanup \
  -noGenerateSpecTE Scheduler.tla -config findings/StaleComplete.cfg
```

## Files

- `Scheduler.tla` — the model; every action's comment names the code it mirrors.
- `Scheduler.cfg` (main, safety, 2 crashes) and `SchedulerLive.cfg` (liveness, no crash): must pass.
- `findings/*.cfg` — current-code findings and one by-design characterisation; must FAIL as named.
- `fixes/*.tla|cfg` — the suggested code fix for each finding, modelled; must pass.
- `mutants/*.tla|cfg` — one broken variant per property, each mirroring a concrete code
  mutation written at the top of the file; must fail as named. `MutRewindOnly` and
  `MutNoUniqueOnly` are guard demos that must PASS: each removes one of the two guards of
  `OneTriggerPerSlot` and shows the other still holds it.

## Coverage record

Sync commit: `0cea30c87636024ff65ac441a06dbf4bfbd7f9aa` (covered files clean at that commit).
The model describes these, at these lines at the sync commit:

| File | Function / code | Lines | Model |
| --- | --- | --- | --- |
| src/core/scheduler.ts | `nextRunAt` (every, at) | 50–67 | `NextRunAt` |
| src/core/scheduler.ts | `countSlots` | 69–81 | `CountLoop`, `CountSlots` |
| src/core/scheduler.ts | `Scheduler.claimDue` (due query, INSERT … ON CONFLICT, `fresh`, UPDATE) | 135–179 | `Due`, `Fresh`, `ClaimDueWith` |
| src/core/scheduler.ts | `Scheduler.complete` | 181–189 | `FinishWith`, `ReleaseById` |
| src/core/scheduler.ts | `Scheduler.recover`, `RUN_LEASE_MS` | 47–48, 191–194 | `Restart`, `LEASE` |
| src/store/db.ts | `triggers` … `UNIQUE (source, external_id)` | 12–24 | `Fresh` |
| src/daemon.ts | `start` → `s.scheduler.recover()` | 162–165 | `Restart` |
| src/daemon.ts | `tickGovernorAndClock` (30 s timer, claimDue → `void this.runJob`) | 190, 228–235 | `ClaimDue` |
| src/daemon.ts | `runJob` / `finish` (complete + trigger `done`), `done: finish` for agent jobs | 258–299 | `RunFinishes` |
| src/daemon.ts | `reprocessStuckTriggers` skips `source 'clock'` | 740–755 | `Restart` (no replay) |
| src/agent/concierge.ts | `handle` → `input.done?.(...)` for system inputs | 136–189 | when `RunFinishes` happens |

Before trusting a result, see whether the covered code moved:

```sh
git -C /home/user/vigil-agent diff --stat 0cea30c87636024ff65ac441a06dbf4bfbd7f9aa -- \
  src/core/scheduler.ts src/store/db.ts src/daemon.ts src/agent/concierge.ts
```

If a covered function changed, re-read it against the action that cites it before you run
the check. Move the sync commit forward (here and in the `.pi` copy) only after you have
confirmed that the model describes the code at the new commit; then update the line numbers.

## Findings in the code at the sync commit

`check.sh` expects each of these to reproduce. When one stops reproducing, the code was fixed
(or the model drifted): confirm which, then move the config from `findings/` to the main
checks (or delete it) and say so.

**S1 — a slot exactly at the claim instant is lost** (`findings/LostSlotAtNow.cfg`, `NoLostSlot`).
Every-2 job, claimed late: 1. `next_run_at` = 2; nobody claims at 2. 2. At `now` = 4,
`claimDue` claims slot 2; slots 2 and 4 are both due. 3. `countSlots(2, 4)` stops when
`next >= to` (4 ≥ 4): `coalesced` = 0. 4. `next_run_at = nextRunAt(now)` = 6. Slot 4 is in
neither. Harm: the run's prompt under-reports missed runs by one (real clock: only when the
claim lands on the exact millisecond of a slot, so rare; with `ManualClock` it is common).
Fix: `countSlots` loop test `next > to` (scheduler.ts:76). Model: `fixes/FixCountSlots`.

**S2 — a stale `complete()` frees a re-claimed job** (`findings/StaleComplete.cfg`,
`OverlapOnlyAfterLease`). 1. Heartbeat claimed at 2 (run A). 2. A is still going past the lease
(e.g. its concierge turn is queued behind /pause or a long turn). 3. At 6 `claimDue` presumes A
dead and claims again (run B, `running_since` = 6). 4. At 8 A's `finish()` →
`complete(job.id)` sets `running_since = NULL` though B holds the job. 5. Same instant,
`claimDue` claims slot 8: run C starts while B is 2 units old. Harm: after one long run the
lease no longer limits overlap; B and C (and their `last_status` writes) race. Replayed on the
real `Scheduler` with `ManualClock`. Fix: `JobRun` carries `claimedAt`;
`complete(jobId, status, claimedAt)` adds `AND running_since = ?` (scheduler.ts:182–189,
daemon.ts:262). Model: `fixes/FixStaleComplete`.

**S3 — a claimed run cut by a crash never runs** (`findings/CrashDropsRun.cfg`, `AtJobRuns`).
1. `at` job (an `agent` action: "at 9:00, check X and tell me") is claimed: trigger
`received`, `enabled = 0`. 2. Its concierge turn is in memory; the process dies. 3. Restart:
`recover()` clears `running_since`; `reprocessStuckTriggers` skips `source 'clock'`;
`next_run_at` is already past the slot (NULL for `at`). 4. The trigger stays `received` for
ever; the job never runs. Every-jobs lose that slot too (not folded into the next `coalesced`).
Harm: contradicts DESIGN.md's "a crash can repeat an action but never lose one". (For `remind`
jobs the window is only the synchronous gap after the claim commits; for `agent`, heartbeat
and dream jobs it is the whole turn.) Replayed on the real `Scheduler` + `Db` file.
Fix: in `Daemon.start` after `recover()`, re-dispatch each job's newest `received` clock
trigger through `runJob` (mark older ones done, set `running_since`). Model:
`fixes/FixReplayClockTriggers`.

**By design — overlap after the lease** (`findings/LeaseOverlap.cfg`, `NoOverlap`). If a run
outlives `RUN_LEASE_MS` (6 h), `claimDue` starts another while it still runs. This is the
lease's purpose (a dead process must not hold a job for ever); `NoOverlap` holds only under
the assumption that runs end within the lease. Exactly then is overlap possible: a run older
than `RUN_LEASE_MS` plus a newer one — and, through S2, also two young ones.

## Reading a counterexample

Read every TLC result with the pstack `/statechart` skill: it gives the shortest path to each
broken rule in plain words and draws the states. Map each step back to code with the action
names: `Tick` (time passes), `ClaimDueWith` (= `claimDue` + `runJob` start), `RunFinishes`
(`finish()` → `complete()`), `Crash`, `Restart` (`recover()`). Variables are DB columns:
`nextRun` = `next_run_at`, `runningSince` = `running_since`, `triggers` = rows of `triggers`
(`coalesced` from the payload, `at` = `created_at`), `runs` = in-memory `runJob` calls.
`Null` is -1. Then replay the path on the real code before calling it a bug: a scratch script
with `new Db(":memory:")`, `ManualClock` and `Scheduler`, one call per step (that is how S1–S3
were confirmed).

## Model error or bug?

- A step the code cannot take (a claim while `up` is FALSE, two claims at one instant without
  `finish`, a run finishing twice) → model error: fix the action, cite the line.
- A step the code can take but only under conditions the model omits (clock going backwards,
  two daemons on one DB) → outside the assumptions below; say so, do not "fix" the model.
- The path replays on the real code → bug. Report it as a finding with the path in the code's
  words. Do not weaken the property or the model to make it pass, and do not change `src/`
  unless asked.

## When the code changes on purpose

1. Find the action whose comment cites the changed lines; edit it to do exactly what the new
   code does (one `Db.tx()` or one synchronous block = one action; each `await` = a step
   boundary).
2. If the change adds a guard or a path, add a mutant in `mutants/` that removes it, with the
   code mutation at the top, and add it to `check.sh` with its expected violation.
3. If a finding is fixed, the finding config starts to pass: move it to the main checks.
4. Run `check.sh`, then update the coverage table and the sync commit (here and in
   `.pi/skills/verify-scheduler/SKILL.md`).

## Bounds, assumptions, not covered

- Bounds: one `every` job (period 2) and one `at` job (time 3), lease 3, clock 0..14
  (main/live; 9 for findings and mutants, 12 for the S3 fix), at most 2 crashes (main),
  1 (S3), 0 (liveness). A pass covers these bounds only.
- Time is abstract integers; `every` is `after + period` exactly as the code computes it.
  `cron` is not modelled separately: `nextRunAt` for cron is also strictly after `after`, and
  `countSlots` iterates it the same way, so S1 applies to cron too (argued, not checked).
- Assumes one daemon process per database (a second `vigil` start would `recover()` the first
  one's running jobs) and a clock that does not go backwards.
- Not covered: `create`, `ensure` (system jobs re-armed at start), `setEnabled`, `remove`,
  `/pause` (claimDue skipped while paused; slots then coalesce), what a run does (outbox,
  tickets), the concierge queue order and preemption (only "done is eventually called" is
  assumed, except in `MutDropDone`), the 1000-slot cap in `countSlots`.
