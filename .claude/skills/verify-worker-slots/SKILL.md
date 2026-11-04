---
name: verify-worker-slots
description: Model-check vigil's worker pool and ticket inputs (TLA+/TLC) — no ticket runs twice, max workers plus one reserved slot for owner input, owner input is never starved or lost, a stopped ticket stays stopped, the event loop is never starved by run restarts. Use whenever a change touches src/agent/workers.ts (WorkerPool.pump, run, session, recover), src/core/tickets.ts (runnable, addInput, takeInputs, report, stop, setStage, setSessionFile), the report/ask_owner/ticket_message/ticket_stop tools in src/agent/tools.ts, or where src/daemon.ts calls addInput/pump/stop/recover; and before claiming anything about worker concurrency, ticket stop, or delivery of owner messages to workers.
---

# Verify the worker slots

`verification/workers/Workers.tla` is a TLA+ model of how vigil runs tickets: `pump()`
(synchronous, over `runnable()` in created order, with the `max + 1` limit for owner input),
`run()` with its two interleaving points (`await this.session(t)` and each
`await promptWithFallback`), the `finally` that re-pumps, the owner's messages and `/stop`,
the worker's `report`/`ask_owner` calls during a turn, turn errors and the turn timeout, a
crash and `recover()`. It also models Node's rule that microtasks run before timers and I/O
(`Micro`), which is what finding W4 is about. TLC checks every interleaving within the bounds.

## Properties (property — harm if broken)

| Name | Property | Harm |
| --- | --- | --- |
| `NoDoubleRun` | A ticket never has two runs at once. | Two workers edit the same ticket directory and repeat outside actions. |
| `SlotLimit` | At most `workers.max` runs, and `max + 1` only when one run started with owner input pending. | Background work exceeds the configured concurrency (cost, rate limits). |
| `ReservedSlotWorks` | Right after a pump, a runnable ticket with owner input is waiting only if all `max + 1` slots are taken. | The owner's reply to a ticket waits behind background work. |
| `StoppedRejectsInputs` | A stopped ticket stays ended and accepts no input. | A ticket the owner stopped comes back to life. |
| `StoppedNeverRunsAgain` | After `/stop`, the ticket starts no new run and no new turn. | The worker keeps doing the work the owner withdrew. |
| `OwnerNeverStarved` (liveness) | A pending owner message is eventually taken by a turn (or the ticket is stopped). | The owner's message to a ticket is silently never delivered. |
| `NoInputLost` (`InputNeverLost` + liveness) | Every input reaches a turn that returns, or a session that is reopened, unless the owner stopped the ticket; none stays pending for ever. | The worker never sees what the owner told it. |
| `EventLoopProgress` (liveness) | The event loop always gets back to timers and I/O. | The whole daemon freezes: no messages, no timers, no outbox. |

## Run it

```sh
verification/workers/check.sh
```

About 45–80 s on 4 cores (the two big runs use all cores, the rest run in parallel). Needs
Java 17+ and `tla2tools.jar` (env `TLA2TOOLS_JAR`, else `/home/user/tools/tla2tools.jar` or
`~/tools/tla2tools.jar`); last run with TLC 2026.11.03.180953 (rev 309e489). One
`PASS`/`FAIL` line per check, then `ALL AS EXPECTED` (exit 0) or `UNEXPECTED RESULTS`
(exit 1). `PASS` means "the expected result": the model of the current code passes, each
finding still reproduces, each fix variant passes, each mutant shows its named violation.

One check by hand (from `verification/workers`):

```sh
java -XX:+UseParallelGC -DTLA-Library=$PWD -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers auto -cleanup \
  -noGenerateSpecTE Workers.tla -config findings/StopDuringStart.cfg
```

## Files

- `Workers.tla` — the model. Every action's comment names the code it mirrors. Variants are a
  record of flags (`Base` = current code); each flag is read at the code point it mirrors.
  `Fixed` = all suggested fixes; `SpecFixW1`…`SpecFixW4` = one fix each.
- `Workers.cfg` — main safety check of the current code: must pass.
- `findings/*.cfg` — current-code findings and one by-design characterisation: must FAIL as named.
- `fixes/FixAll.cfg` — every property on `Fixed`, with a crash: must pass.
- `mutants/*.tla|cfg` — one broken variant per property, each mirroring a concrete code
  mutation written at the top of the file. Mutants for properties the current code already
  breaks start from `Fixed`.
- `chart.mmd` — the `/statechart` chart of one ticket (inputs in `chart/`: the view, the
  config, and `mkchart.py`, which makes a comment-free, parameter-free copy of the model; see
  "Reading a counterexample").

## Coverage record

Sync commit: `0cea30c87636024ff65ac441a06dbf4bfbd7f9aa` (covered files clean at that commit).

| File | Function / code | Lines | Model |
| --- | --- | --- | --- |
| src/agent/workers.ts | `WorkerPool.pump` (runnable loop, `running.has`, owner count, limit, start, `.finally` delete/dispose/pump) | 36–55 | `PumpStarts`, `NewRun`, `Pump`, `Finally` |
| src/agent/workers.ts | `session` (buildSession from `t.session_file`) | 57–85 | `SessionStart`, `SessionFail` |
| src/agent/workers.ts | `run` (setStage, await session, turn loop, timeout, setSessionFile, error, post-loop report/dispose) | 87–138 | `NewRun`, `SessionStart`, `SessionFail`, `LoopStep`, `PromptReturn`, `PostLoop` |
| src/agent/workers.ts | `recover` | 140–154 | `Restart` |
| src/core/tickets.ts | `setStage`, `setSessionFile`, `report`, `stop`, `addInput`, `takeInputs`, `hasPendingInputs`, `runnable` | 142–222 | `Pump`, `PromptReturn`, `WorkerTool`, `Stop`, `OwnerMessage`, `LoopStep`, `RunnableIn` |
| src/agent/tools.ts | `ticket_message`, `ticket_stop` (concierge); `report`, `ask_owner` (worker) | 152–173, 276–337 | `OwnerMessage`, `Stop`, `WorkerTool` |
| src/agent/sessions.ts | `buildSession` throws when no model has credentials | 68–72 | `SessionFail`, `Micro` |
| src/daemon.ts | `start` (workers.recover 165, 15 s pump timer 192, final pump 201); `wakeWorkers` 81; `route` addInput then pump 455–471; answer button 554–555; `/stop` 669 | 81, 162–201, 455–471, 554–555, 669 | `Restart`, `TimerPump`, `OwnerMessage`, `Stop` |

Before trusting a result, see whether the covered code moved:

```sh
git -C /home/user/vigil-agent diff --stat 0cea30c87636024ff65ac441a06dbf4bfbd7f9aa -- \
  src/agent/workers.ts src/core/tickets.ts src/agent/tools.ts src/agent/sessions.ts src/daemon.ts
```

If a covered function changed, re-read it against the action that cites it before running the
check. Move the sync commit forward (here and in the `.pi` copy) only after you confirmed the
model describes the code at the new commit; then update the line numbers.

## Findings in the code at the sync commit

All four were replayed on the real `WorkerPool` + `Tickets` with a stub session (scratch
scripts, one step per model action). `check.sh` expects each to reproduce.

**W1 — `/stop` during session start does not stop a new ticket** (`findings/StopDuringStart.cfg`,
`StoppedNeverRunsAgain`). 1. `pump()` starts the ticket: `setStage('working')`, then
`await this.session(t)`. 2. The owner sends `/stop`: `tickets.stop` sets `ended`/`stopped`.
3. The session resolves; `takeInputs` is empty, `first` is computed from the stale snapshot
`t.last_report` (null), so `run()` prompts "Start the work described in your mandate.".
The worker then does the whole mandate the owner withdrew. Fix: after
`session = await this.session(t)` (workers.ts:92), re-read the ticket and return if
`status === 'ended'`. Also note (not modelled as a violation): `/stop` never aborts a turn
already in flight, and that turn's `report`/`ask_owner` still overwrite `stage = 'stopped'`
and message the owner.

**W2 — an owner message pending at `ready` can be stranded** (`findings/OwnerInputStranded.cfg`,
`OwnerNeverStarved`). 1. A run's turn is in flight (stage `working`, status `open`). 2. The
owner replies to the ticket: `addInput` inserts a pending row; the stage is `working`, so it is
left alone. 3. The worker calls `report('ready')`: status `ended`, stage `done`. 4. The turn then
ends with a model error or the turn timeout (or it was the 20th turn): `run()` returns without
taking the input. 5. `finally` → `pump()`: `runnable()` lists only `status = 'open'` tickets.
The row stays `pending` for ever; the owner's message is never delivered and nobody is told.
(`chart.mmd` shows it as "Finished (ready), message waiting", whose only way out is /stop.)
Fix: in `Tickets.report` (tickets.ts:151–170) do not end a ticket that has pending inputs:
`const ends = (kind === "ready" || kind === "dropped") && !this.hasPendingInputs(id)` (stage
then `review`, which `addInput`/`runnable` already treat as resumable).

**W3 — a cut first turn loses its input** (`findings/InputLost.cfg`, `InputNeverLost`).
1. A ticket's first run takes the owner's message (`takeInputs` marks it delivered).
2. The turn hits `turnTimeoutMinutes` (or the process dies). On timeout `run()` returns before
`setSessionFile` (workers.ts:112–116), so `tickets.session_file` stays NULL. 3. Sessions are
disposed after every run, so the next run calls `buildSession` with `file: null` → a brand-new
session. The message the owner sent is in an orphaned JSONL; the worker never sees it, though
the owner was told "Reply to continue". Fix: store `session.sessionFile` right after
`this.session(t)` resolves (before the first prompt), and open a not-yet-written file as empty.

**W4 — no worker model + a pending input freezes the daemon** (`findings/HotLoop.cfg`,
`EventLoopProgress`). 1. A ticket has a pending input (a reply, a concierge note, or the
recovery note `recover()` adds after a restart). 2. `pump()` → `run()` → `session()` →
`buildSession` throws at once ("no model with credentials for role worker"). 3. `run()` reports
`failed` and returns; `finally` → `pump()`; the ticket is still runnable (stage `failed`,
input pending) → `run()` again. Every step is a microtask, so timers, I/O and `/login` never
run: the daemon is stuck at 100% CPU, writing a `ticket.report` event row per loop (replay:
20,000 loops, a 0 ms timer never fired). Fix: in `pump()`'s `.finally` (workers.ts:48–52) do
not re-pump after a run whose session failed to start (leave the retry to the 15 s timer), or
mark the start failure and skip that ticket until its inputs change.

**By design — the reserved slot is one slot** (`findings/SecondOwnerWaits.cfg`,
`SecondOwnerNeverWaits`). With `max` slots busy and two tickets holding owner input, the first
takes the reserved slot and the second waits until any run ends (a run can be up to 20 turns
of up to `turnTimeoutMinutes` each). `ReservedSlotWorks` and (with the fixes) `OwnerNeverStarved`
hold: the second owner message is delayed, not starved.

## Reading a counterexample

Read every TLC result with the pstack `/statechart` skill: it gives the shortest path to each
broken rule in plain words and draws the states. The chart of this model is `chart.mmd`; to
redraw it, give `/statechart` the copy that `chart/mkchart.py` writes (that copy has no
comments and no variant parameter, which the chart tool needs) with `chart/Chart.cfg` and the
view `chart/view.mjs`. Step names map to code: `TimerPump` (15 s timer / start / wakeWorkers →
`pump`), `OwnerMessage` (`addInput` + `pump`), `Stop` (`tickets.stop`), `SessionReady` /
`SessionThrows` (`await this.session(t)` resolves / throws), `WorkerCallsTool` (`report`,
`ask_owner`), `TurnReturns` (`await promptWithFallback` returns ok / error / timeout),
`RunSettles` (the `.finally`), `Crash`, `Restart` (`recover`), `ModelFlip` (worker models
appear/disappear). Variables are DB columns (`status`, `stage`, `stopped` =
`stopped_by_owner`, `lastRep` = `last_report IS NOT NULL`, `sessFile` = `session_file IS NOT
NULL`, `inputs.own/oth` = some pending owner / other row) and memory (`runs` = the `running`
map; `ph` starting/prompting/ending; `taken` = the turn holds rows). Then replay the path on
the real code: `new WorkerPool(stubServices)` with a real `Tickets` on `Db(":memory:")` and a
stub `session()` that resolves/throws/blocks as the path says.

## Model error or bug?

- The path needs a step the code cannot take (two steps where the code has no `await` between
  them, a pump while paused, a run after `stop` without passing `runnable()`) → model error:
  fix the action and cite the line.
- The path needs a condition outside the assumptions (two daemons, `/pause`, a deleted ticket)
  → out of scope; say so.
- The path replays on the real code → bug: report it as a finding in the code's words. Never
  weaken a property or the model to make it pass; do not change `src/` unless asked.

## When the code changes on purpose

1. Find the action whose comment cites the changed lines and make it do what the new code
   does (code between two `await`s = one action; `Db.tx()` = atomic; a `.finally` = its own
   step; anything without I/O after a settled promise is a microtask → `Micro`).
2. A new guard or path gets a flag in `Base` read at that point, and a mutant in `mutants/`
   (code mutation at the top) wired into `check.sh` with its expected violation.
3. A fixed finding starts passing: move it into `Workers.cfg` / `fixes/FixAll.cfg` and update
   `Fixed`.
4. Run `check.sh`; update the coverage table and sync commit here and in
   `.pi/skills/verify-worker-slots/SKILL.md`.

## Bounds, assumptions, not covered

- Bounds (main): 2 tickets, `workers.max` = 1 (+1 reserved), 2 turns per run (code: 20),
  2 inputs from the owner/concierge (plus recovery notes), 1 crash, worker tools `ready` and
  `ask_owner`, turn outcomes ok/error/timeout. Findings and mutants use smaller bounds
  (`SecondOwnerWaits`: 3 tickets). `progress`/`blocked` reports exist in the model
  (`ToolKinds`) but are not in the shipped configs, to keep the run short.
- Abstractions: `ticket_inputs` is "some pending owner row / some pending other row" per
  ticket — exact because the code only tests `COUNT > 0` and `takeInputs` takes all rows;
  `last_report` is "exists" plus the run's own "final report since start"; `buildSession` is
  assumed to do I/O when it succeeds and to throw synchronously when no model exists.
- Not covered: `/pause` and `/resume`, `stopAll`, ticket creation (tickets exist at start),
  `delegate`, approvals inside a turn, what pi persists inside a session file, the attention
  table (an answer is an owner input), notifications, concierge behaviour.
