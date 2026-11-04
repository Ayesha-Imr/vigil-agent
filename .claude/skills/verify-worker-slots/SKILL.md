---
name: verify-worker-slots
description: Model-check vigil's worker pool and ticket inputs (TLA+/TLC) — no ticket runs twice, max workers plus one reserved slot for owner input, owner input is never starved, inputs are never lost silently, a stopped ticket stays stopped, failed starts and cut turns back off and retry a bounded number of times, the event loop is never starved by run restarts. Use whenever a change touches src/agent/workers.ts (WorkerPool.pump, run, session, recover, failedStart, cutTurns), src/core/tickets.ts (runnable, addInput, takeInputs, report, stop, setStage, setSessionFile), the report/ask_owner/ticket_message/ticket_stop tools in src/agent/tools.ts, or where src/daemon.ts calls addInput/pump/stop/recover; and before claiming anything about worker concurrency, ticket stop, retries, or delivery of owner messages to workers.
---

# Verify the worker slots

`verification/workers/Workers.tla` is a TLA+ model of how vigil runs tickets: `pump()`
(synchronous, over `runnable()` in created order, skipping a ticket whose `failedStart` is less
than 60 s old, with the `max + 1` limit for owner input), `run()` with its two interleaving
points (`await this.session(t0)` and each `await promptWithFallback`), pump's continuation
(`if (started) this.pump()`), owner messages and `/stop`, the worker's `report`/`ask_owner`
calls, cut turns (a model error or the turn timeout: re-queue the inputs if pi never wrote the
session file and fewer than three cut turns in a row, back off a minute), a crash and
`recover()`. It also models Node's rule that microtasks run before timers and I/O (`Micro`),
which is what `EventLoopProgress` is about. TLC checks every interleaving within the bounds.

## Properties (property — harm if broken)

| Name | Property | Harm |
| --- | --- | --- |
| `NoDoubleRun` | A ticket never has two runs at once. | Two workers edit one ticket directory and repeat outside actions. |
| `SlotLimit` | At most `workers.max` runs, and `max + 1` only when one started with owner input pending. | Background work exceeds the configured concurrency. |
| `ReservedSlotWorks` | Right after a pump, a runnable ticket with owner input waits only if all `max + 1` slots are taken or its worker failed to start / its turn was cut less than a minute ago. | The owner's reply waits behind background work. |
| `StoppedStaysStopped` (= `StoppedRejectsInputs` ∧ `StoppedNeverRunsAgain`) | A stopped ticket stays ended, accepts no input, and starts no new run or turn. | The worker keeps doing work the owner withdrew. |
| `OwnerNeverStarved` (liveness) | A pending owner message is eventually taken by a turn (or the ticket is stopped). | The owner's message is never delivered. |
| `NoInputStuck` (liveness) | No input stays pending for ever. | A note or reply waits for ever. |
| `InputNeverLostSilently` | An input marked delivered reaches a turn that returns or a session file that is reopened, unless the owner is told the turn failed. | The worker never sees what the owner said, and nobody knows. |
| `InputKeptForTwoCuts` | A cut turn's inputs survive (are re-queued) at least twice before being dropped. | A transient model error eats the owner's message. |
| `RetriesBounded` | A cut turn's inputs are re-queued at most twice in a row. | A persistent model error becomes a retry storm. |
| `RetryBackoff` | No run starts within a minute of the ticket's failed start or cut turn. | A failing provider is hit in a tight loop. |
| `EventLoopProgress` (liveness) | The event loop always gets back to timers and I/O. | The whole daemon freezes. |

## Run it

```sh
verification/workers/check.sh           # ~70-85 s on 4 cores
verification/workers/check.sh --deep    # adds WorkersDeep.cfg and WorkersLiveDeep.cfg (~5 min)
```

Needs Java 17+ and `tla2tools.jar` (env `TLA2TOOLS_JAR`, else `/home/user/tools/tla2tools.jar`
or `~/tools/tla2tools.jar`); last run with TLC 2026.11.03.180953 (rev 309e489). One
`PASS`/`FAIL` line per check, then `ALL AS EXPECTED` (exit 0) or `UNEXPECTED RESULTS`
(exit 1). `PASS` means "the expected result".

One check by hand (from `verification/workers`):

```sh
java -XX:+UseParallelGC -DTLA-Library=$PWD -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers auto -cleanup \
  -noGenerateSpecTE Workers.tla -config findings/CrashLosesInput.cfg
```

## Files

- `Workers.tla` — the model; each action has a `\* code: file:line` line. Code variants are a
  record of flags: `Base` = the current code; each flag is read at the code point it mirrors.
  `Fixed` = `Base` plus the suggested fix for the open finding W3c.
- Required (must pass): `Workers.cfg` (safety, 2 tickets, no crash), `WorkersCrash.cfg`
  (safety, 1 ticket, 1 crash), `WorkersLive.cfg` / `WorkersLiveCrash.cfg` (liveness),
  `WorkersOutage.cfg` (models vanish). With `--deep`: `WorkersDeep.cfg` (2 tickets + a crash,
  1,938,647 states) and `WorkersLiveDeep.cfg` (2 tickets, 2 inputs, 386,561 states).
- `regressions/*.cfg` — the old findings W1–W4, fixed in 166ea0c / 4e2683a; must pass.
- `findings/CrashLosesInput.cfg` — the open finding W3c; must FAIL as named until fixed.
  `findings/FixW3c.cfg` — the suggested fix; must pass.
- `bydesign/*.cfg` — characterisations that must FAIL as named.
- `mutants/*.tla|cfg` — one broken variant per property (several revert a fix), each with the
  code mutation at the top; must fail as named. `MutRepumpOnly` is a guard demo that must PASS.
- `chart.mmd` — the `/statechart` chart of one ticket (inputs in `chart/`: the view, the config,
  and `mkchart.py`, which writes a comment-free, parameter-free copy that the chart tool needs).

## Coverage record

Sync commit: `ef2c26f70f347992c3a4acbf23915db9bda33ef5` (covered files clean at that commit).

| File | Function / code | Lines | Model |
| --- | --- | --- | --- |
| src/agent/workers.ts | `WorkerPool.pump` (runnable loop, `running.has`, `failedStart` 60 s skip, owner count, limit, start, continuation: delete, dispose, `if (started) pump()`, rejection → report failed + failedStart) | 43–74 | `PumpStarts`, `NewRun`, `Pump`, `Finally`, `MinutePasses` |
| src/agent/workers.ts | `session` (buildSession from `t.session_file`) | 76–112 | `SessionStart`, `SessionFail` |
| src/agent/workers.ts | `run` (setStage; await session; failed start → `failedStart`, `return false`; re-read, return if stopped/ended; turn loop; timeout; `persisted`; cut turn: `cutTurns`, re-queue if `!persisted && fails <= 2`, `failedStart`, report, `return false`; clean turn: `cutTurns.delete`; post-loop) | 115–177 | `NewRun`, `SessionStart`, `SessionFail`, `LoopStep`, `PromptReturn`, `PostLoop` |
| src/agent/workers.ts | `recover` | 180–193 | `Restart` |
| src/core/tickets.ts | `setStage`, `setSessionFile`, `report` (no end while inputs pend, line 170), `stop`, `addInput`, `takeInputs`, `hasPendingInputs`, `runnable` | 155–236 | `Pump`, `PromptReturn`, `WorkerTool`, `Stop`, `OwnerMessage`, `LoopStep`, `RunnableIn` |
| src/agent/tools.ts | `ticket_message`, `ticket_stop` (concierge); `report`, `ask_owner` (worker) | 154–175, 290–340 | `OwnerMessage`, `Stop`, `WorkerTool` |
| src/agent/sessions.ts | `buildSession` throws when no model has credentials | 73 | `SessionFail`, `Micro` |
| src/daemon.ts | `start` (workers.recover 225, 15 s pump timer 254, final pump 263); `wakeWorkers` 104; `route` addInput then pump 528–544; answer button 638–639; `/stop` 785 | 104, 218–266, 528–544, 638–639, 785 | `Restart`, `TimerPump`, `OwnerMessage`, `Stop` |

Before trusting a result, check whether the covered code moved:

```sh
git -C /home/user/vigil-agent diff --stat ef2c26f70f347992c3a4acbf23915db9bda33ef5 -- \
  src/agent/workers.ts src/core/tickets.ts src/agent/tools.ts src/agent/sessions.ts src/daemon.ts
```

If a covered function changed, re-read it against the action that cites it before running the
check. Move the sync commit forward (here and in `.pi/skills/verify-worker-slots/SKILL.md`)
only after you confirmed the model describes the code at the new commit; then update the lines.

## Open finding

**W3c — a crash in a ticket's first turn silently loses the owner's input**
(`findings/CrashLosesInput.cfg`, `InputNeverLostSilently`). Replayed on the real `WorkerPool` +
`Tickets` with a `Db` file and a stub session:
1. The owner writes to a new ticket ("use the staging database, not prod"); `pump()` starts
   it, `takeInputs` marks the row `delivered`, pi writes the user message to its session file.
2. The process dies during that turn. `setSessionFile` runs only after a prompt returns, so
   `tickets.session_file` is still NULL.
3. Restart: `recover()` adds the recovery note; the next run's `session()` gets
   `session_file = null` and builds a new session; the worker's prompt is only "Recovery note:
   vigil restarted while you were working…".
The owner's instruction is gone, the worker resumes from the mandate alone, and nobody is told.
The cut-turn path no longer loses input (W3 fix); only a crash does, so the fix is the same
for both: store the session path before the first prompt — in `run()` right after the re-read
(workers.ts:128–129), `if (session.sessionFile) this.s.tickets.setSessionFile(t.id,
session.sessionFile)`. `SessionManager.open` accepts a path whose file does not exist yet (it
opens an empty session), so a crash before pi writes anything is harmless.
`findings/FixW3c.cfg` checks this fix (`Fixed`).

## Findings history (fixed; regression config must pass, revert mutant must fail)

- **W1** `/stop` while the session builds still started the mandate — fixed in 166ea0c (run()
  re-reads the ticket after the session await). `regressions/StopDuringStart.cfg`; revert:
  `MutNoRecheck`.
- **W2** an owner message pending at `ready` was stranded on an ended ticket — fixed in 166ea0c
  (`report` does not end a ticket with pending inputs; stage `review`).
  `regressions/OwnerInputStranded.cfg`; revert: `MutReportEnds`.
- **W3** a cut first turn lost its input — fixed for cut turns in 166ea0c (re-queue when the
  session file never reached disk), capped in 4e2683a. `regressions/InputLostCutTurn.cfg`;
  revert: `MutNoReadd`. The crash half is W3c above.
- **W4** no worker model + a pending input froze the event loop — fixed in 166ea0c (no re-pump
  after a failed start, `failedStart` 60 s skip). `regressions/HotLoop.cfg`; revert:
  `MutRepumpAfterFailedStart`. Either half alone suffices (`MutRepumpOnly` passes).
- Found while fixing W3 (by the code's authors, 4e2683a): an unbounded retry storm when a
  prompt fails before pi writes the file (no API key, auth check failed). Now bounded:
  `RetriesBounded` (revert: `MutNoReaddCap`) and `RetryBackoff` (revert: `MutNoCooldown`).

## By design (must fail as named)

- **The reserved slot is one slot** (`bydesign/SecondOwnerWaits.cfg`, `SecondOwnerNeverWaits`).
  With `max` slots busy and two tickets holding owner input, the second waits until any run
  ends. It is delayed, not starved (`OwnerNeverStarved` holds).
- **The third cut turn in a row drops its inputs** (`bydesign/DroppedAfterThreeCuts.cfg`, the
  strict `InputNeverLost`). After two re-queues, a cut turn whose session file never reached
  disk marks its inputs delivered and does not re-queue them; the owner is told "The model
  failed … Reply to retry" or "A turn ran past … Reply to continue". `InputNeverLostSilently`
  and `InputKeptForTwoCuts` hold. Note: `cutTurns` resets only on a clean turn, not on new
  owner input, so a fresh message sent after two cut turns gets no re-queue at all if its own
  turn is cut too.

## Reading a counterexample

Read every TLC result with the pstack `/statechart` skill: it gives the shortest path to each
broken rule in plain words and draws the states. To redraw `chart.mmd`, give `/statechart`
the copy that `chart/mkchart.py` writes, with `chart/Chart.cfg` and the view `chart/view.mjs`.
Step names map to code: `TimerPump` (15 s timer / start / wakeWorkers → `pump`),
`OwnerMessage` (`addInput` + `pump`), `Stop` (`tickets.stop`), `SessionReady` /
`SessionThrows` (`await this.session(t0)` resolves / throws), `WorkerCallsTool` (`report`,
`ask_owner`), `TurnReturns` (`await promptWithFallback` returns ok, or a cut turn),
`RunSettles` (pump's continuation), `AMinutePasses` (a `failedStart` entry turns 60 s old),
`Crash`, `Restart` (`recover`), `ModelFlip` (worker models appear/disappear). Variables are
DB columns (`status`, `stage`, `stopped` = `stopped_by_owner`, `lastRep` = `last_report IS NOT
NULL`, `sessFile` = `session_file IS NOT NULL`, `inputs.own/oth` = some pending owner / other
row, `inputs.lost/dropNotified/droppedEarly` = how a delivered row failed to arrive) and memory
(`runs` = the `running` map: `ph` starting/prompting/ending, `tOwn/tOth` = kinds the turn holds,
`onDisk` = pi wrote the session file, `noPump` = run() resolved false; `cooling` = `failedStart`
under 60 s; `cut` = `cutTurns`). Then replay the path on the real code: `new WorkerPool(stub)`
with a real `Tickets` on a `Db`, and a stub `session()` whose object has `prompt`,
`getSessionStats`, `messages`, `getLastAssistantText`, `dispose`, and resolves/throws/blocks as
the path says.

## Model error or bug?

- The path needs a step the code cannot take (two steps where the code has no `await` between
  them, a pump while paused, a run after `stop` without passing `runnable()`) → model error:
  fix the action and cite the line.
- The path needs a condition outside the assumptions below → out of scope; say so.
- The path replays on the real code → bug: report it in the code's words. Never weaken a
  property or the model to make it pass; do not change `src/` unless asked.

## When the code changes on purpose

1. Find the action whose `\* code:` line cites the changed lines and make it do what the new
   code does (code between two `await`s = one action; `Db.tx()` = atomic; pump's continuation
   = its own step; anything without I/O after a settled promise is a microtask → `Micro`).
2. A new guard or path gets a flag in `Base` read at that point and a mutant in `mutants/`
   (code mutation at the top) wired into `check.sh` with its expected violation.
3. A fixed finding becomes a config in `regressions/` plus a mutant that reverts the fix.
4. A promise that changes on purpose (cite the commit or comment) changes its property; write
   the old and new wording in this file. Last sync: `ReservedSlotWorks` now excuses a ticket in
   its 60 s `failedStart` window (166ea0c); `NoInputLost` was split into
   `InputNeverLostSilently`, `InputKeptForTwoCuts` and the strict `InputNeverLost` (now by
   design, 4e2683a), plus `NoInputStuck`.
5. Run `check.sh` (and `--deep` before a release); update the coverage table and the sync
   commit here and in `.pi/skills/verify-worker-slots/SKILL.md`.

## Bounds, assumptions, not covered

- Bounds: `Workers.cfg` 2 tickets, `workers.max` = 1 (+1 reserved), 2 turns per run (code: 20),
  2 inputs, no crash, 432,443 states; `WorkersCrash.cfg` 1 ticket, 1 crash; `WorkersLive.cfg`
  2 tickets, 1 turn, 1 input; deep configs as listed above. Worker tools `ready` and
  `ask_owner`; a turn ends ok or is cut (a model error; the timeout takes the same branch).
  `progress`/`blocked` reports exist in the model (`ToolKinds`) but are not in the configs.
- Abstractions: `ticket_inputs` is "some pending owner row / some pending other row" per ticket
  — exact because the code only tests `COUNT > 0` and `takeInputs` takes all rows; `last_report`
  is "exists" plus the run's own "final report since start"; whether pi wrote the session file
  during a cut turn is a free choice (it does so when the user message is appended, which a
  prompt that fails its auth check never reaches); `buildSession` does I/O when it succeeds and
  throws synchronously when no model exists; 60 s passing is an unordered step.
- Not covered: `/pause` and `/resume`, `stopAll`, ticket creation (tickets exist at start),
  `delegate`, approvals inside a turn, an exception escaping `run()` (now reported as failed
  with a `failedStart`), the tool set of inferred tickets, the attention table (an answer is an
  owner input), notifications, concierge behaviour, two daemons on one database (see the
  `daemon.lock` note in `verify-scheduler`).
