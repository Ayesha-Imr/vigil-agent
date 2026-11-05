---
name: verify-approvals
description: Model-check vigil's approvals for risky tool calls (TLA+/TLC) — a call runs only on a consumed owner approval for that exact call before expiry, each approval runs at most one call, denied and expired requests never run, only the owner decides, and the gate never hangs. Use whenever a change touches src/core/approvals.ts (request, wait, decide, consume, expire, dispose), the approval gate in src/agent/gate.ts (the tool_call hook), how a button press or a typed /approve or /deny reaches decide() in src/daemon.ts (route, tryPair, handleCommand, handleButton, the HTTP allowApprovals refusal, tickGovernorAndClock's expire), isOwner or channels.http.allowApprovals in src/config.ts, or how a channel maps senders to owner identities; and before claiming anything about who can approve what.
---

# Verify approvals

`verification/approvals/Approvals.tla` is a TLA+ model of a risky tool call held by the gate until
the owner approves that exact call. node:sqlite is synchronous and the daemon is one JS thread,
so a run of code with no `await` is one step in the model. TLC checks every interleaving of: two
tool calls (same or different arguments) requesting approvals and retrying; presses by the owner,
a stranger and an HTTP client, as a button or as a typed `/approve`/`/deny`, on any approval ever
sent (late, twice, stale, another call's); wait timers; the 30-s expiry sweep; aborts; shutdown
(`dispose`); and the clock moving on.

## Properties (property — harm if broken)

| Name | Property | Harm |
| --- | --- | --- |
| `NoUnapprovedExecution` | A call runs only if `consume()` returned true for an approval with this call's hash that the owner approved before it expired. | A risky command runs without the owner's yes. |
| `SingleUse` | One approval lets at most one call run, once. | One yes runs a command twice. |
| `DeniedNeverRuns` | When the owner's first word on a request was Deny, nothing runs on it. | A denied command runs. |
| `ExpiredNeverRuns` | Nothing runs on an approval at or after its expiry. | A stale yes runs a command long after. |
| `OwnerOnly` | Every decision that changed an approval came from the owner. | Someone else, or the agent itself, approves. |
| `GateResolves` (liveness) | A call held by the gate is eventually run or blocked. | The agent hangs on a tool call. |

"The owner's first word" is what `decide()` promises: only a pending, unexpired request changes,
so a later tap (Deny after Approve, or the reverse) is ignored and reported.

## Who can decide: the boundary decide() does not check

`decide(id, approve)` takes no identity; its caller enforces it. `Daemon.route()` first lets
`tryPair()` turn the first sender of a valid `/pair <code>` into an owner identity, then drops every
sender for whom `isOwner(cfg, channel, senderId)` is false. `isOwner()` is true for every HTTP
request and every CLI line. A button press (`msg.kind === "button"`) on the `http` channel is
refused unless `channels.http.allowApprovals`, because anything holding the HTTP token (the panel,
a signed ntfy button, the agent's own tools) can send one. A typed `/approve <id>` or `/deny <id>`
goes through `handleCommand` to the same `handleButton`, **without** that refusal: open finding
`TypedApproveOverHttp` below.

The model has three principals: `owner` (an identity in `owner.identities`, a paired identity, or
the `vigil chat` terminal on the daemon's stdin), `stranger` (any other chat sender), and `http`
(an attacker-capable principal: anything with the token). Only `owner` presses count as the
owner's word. Assumptions: channels report sender ids truthfully; the pairing code reaches only
the owner (it is printed to the server log); only the person at the terminal reaches the CLI channel.

## Run it

```sh
bash verification/run.sh --only approvals          # about 1 min on 4 cores
bash verification/run.sh --only approvals --deep   # adds the deeper configs (about 7 more minutes)
bash verification/mutate.sh approvals              # every property fails on a broken variant
```

Needs Java 11+; TLC comes from `$TLA2TOOLS` or is downloaded once (TLC 1.8.0, sha256-checked) by
`verification/lib.sh`. `PASS` = every rule in the config holds; `FAIL` = a rule broke or TLC
errored; `FINDING` = a `findings/*.cfg` reproduced the violation it records; `FIXED?` = it no
longer does (see below). TLC's full output is in `verification/out/approvals-<config>.out`.

## Files

- `Approvals.tla` — the model; every action's comment names the code it mirrors. Switches:
  `AllowHttpApprovals` (config), `AnyIdToConsume` (the gate may present any id; gate.ts presents its
  own, so TRUE checks a superset), `Shutdown` (include `dispose()`), `TypedRefusedOverHttp` (FALSE =
  the code; TRUE = the suggested fix for `TypedApproveOverHttp`).
- `MCApprovals.tla` — symmetry over calls and hashes (safety only).
- Required, run by `run.sh`: `Approvals.cfg` (the code as it is, two approval rows; it checks the
  rules the open finding leaves intact: TypeOK, SingleUse, ExpiredNeverRuns),
  `fixes/TypedRefusedOverHttp.cfg` (every rule, with the suggested fix), `Approvals_shutdown.cfg`
  (every rule with `dispose()`, two rows, with the fix), `Approvals_live.cfg` (liveness, the code).
- `--deep`: `Approvals_deep.cfg` (MaxTime = 4, shutdown, with the fix, every rule),
  `Approvals_code_deep.cfg` (the code, three rows).
- `findings/TypedApproveOverHttp.cfg` (`\* expect: OwnerOnly`) and
  `findings/HttpApprovalsOptIn.cfg` (`\* expect: OwnerOnly`): each must break its rule.
- Mutants: `verification/mutants/approvals-*.mutant`, each naming the code change it mirrors. The
  ones for NoUnapprovedExecution, DeniedNeverRuns and OwnerOnly run on the fix config, because the
  code config already breaks those rules.

## Reading results

Read every TLC result with the pstack `/statechart` skill (vendored in `skills/statechart/`): it
gives each violation as its shortest path in plain words and, on a pass, draws the state graph.
For a chart, shrink a config (one call, `MaxApprovals = 1`) to stay under its 500-state budget.

By hand: after `Error: Invariant X is violated.` in `verification/out/…out`, each `State k:
<Action …>` is one step; `Press(p, a, b, t)` is principal `p` pressing approve (`b`) on approval
`a`, typed (`t`) or as a button. Tell it in the code's words, for example: "a worker's `bash`
`sudo true` hits `approvalGate` → `request()` creates ap 1, `ask()` sends the buttons, `wait()`
registers → `POST /api/message {"text":"/approve ap_1"}` with the HTTP token → `route()` →
`handleCommand` → `handleButton` → `decide()` approves → the gate's `consume()` returns true → the
call runs".

## Action ↔ code (sync commit)

| Action | Code |
| --- | --- |
| `Request(c)` | gate.ts:217–228: classify risky, `approvals.request()` (approvals.ts:53), `h.ask()` (outbox enqueue of the buttons), `approvals.wait()` up to its first await (approvals.ts:86) |
| `Press(p, a, b, t)` | `Daemon.route` src/daemon.ts:481 (`tryPair` :485, `isOwner` :489; button: HTTP refusal :508 → `handleButton` :637; typed: `handleCommand` :530 → `/approve` `/deny` :749 → `handleButton`) → `decide()` approvals.ts:120, which calls the waiter |
| `Timer(c)` | `wait()`'s `setTimeout`: `expire()`, then `done(status === "approved" ? …)` |
| `Sweep` | `Daemon.tickGovernorAndClock` daemon.ts:298 `approvals.expire()` (approvals.ts:154) |
| `Abort(c)` | `wait()`'s abort listener: UPDATE to expired if pending/approved, then `done("expired")` |
| `Dispose` | `Approvals.dispose()` approvals.ts:166 at shutdown; a later `wait()` returns "expired" |
| `Continue(c, a)` | gate.ts:230: `outcome === "approved" && consume(a.id, callHash(tool, input))` (`consume()` approvals.ts:141) |
| `Retry(c)` | the model issues the same tool call again (a new `tool_call` event) |

Not modeled: `classify()` and the rules (which calls are risky), `callHash`/`stableStringify`
collisions (assumed injective), pi changing `event.input` after the hook returns, delivery of the
buttons, more than two calls or three approval rows.

## Coverage record

Sync commit: `66af270a9324d1292853781585c1eb522ef4d3d8` (covered files clean at that commit).

| File | Code covered | Blob at sync commit |
| --- | --- | --- |
| src/core/approvals.ts | `request`, `wait` (timer, abort listener, disposed), `decide`, `consume`, `expire`, `dispose` | `9368484524190db26f4add0b9d7bd6cdef93687e` |
| src/agent/gate.ts | `approvalGate`'s `tool_call` hook (request, ask, wait, consume) | `83ac4f72ac2d7316e6b8df51d040bb08370ae767` |
| src/daemon.ts | `route` (tryPair, isOwner drop, HTTP button refusal), `handleCommand` `/approve` `/deny`, `handleButton`, `tickGovernorAndClock` expire | `b5ba91c1f2eebcf38ebd9eef58cb58db5690bdcf` |
| src/config.ts | `isOwner`, `channels.http.allowApprovals` | `fe8ffe2d5515145af06b943ac90549f20a00fac8` |

To find drift: `git diff 66af270 -- src/core/approvals.ts src/agent/gate.ts src/daemon.ts src/config.ts`,
and look for any new caller of `decide()`, `consume()` or `expire()` (`git grep -n "decide(\|consume(\|handleButton("`),
a new way to press or type an approval, or a channel whose sender ids are not the platform's own.

## When the code changes on purpose

1. Read the diff of the covered files since the sync commit and decide per change: no effect; the
   model no longer describes the code (a new await between steps, a new guard, a new caller); or
   the promise changed on purpose (cite the evidence).
2. Change `Approvals.tla` from the code: one step with no `await` in the code is one action, and
   each action's comment names its code. Change a property only for a promise that changed on
   purpose; write down the old and new wording.
3. Run `bash verification/run.sh --only approvals` and `bash verification/mutate.sh approvals`.
   Every mutant must still be caught; add one for each new check in the code.
4. Move the sync commit and blob ids forward only after you confirm the model describes the code
   at the new commit. Copy this file to `.pi/skills/verify-approvals/SKILL.md`.

## When a finding stops reproducing

`FIXED?` on `findings/TypedApproveOverHttp.cfg` means the typed path is now refused over HTTP.
Model it the way the code does (set `TypedRefusedOverHttp` to the code's behavior, or remove the
switch), delete the finding and `fixes/TypedRefusedOverHttp.cfg`, put NoUnapprovedExecution,
DeniedNeverRuns and OwnerOnly back into `Approvals.cfg`, and point the mutants at it. `FIXED?` on
`HttpApprovalsOptIn` means HTTP presses are now authenticated as the owner: model that. If no code
change explains a `FIXED?`, the model drifted.

## Open findings at the sync commit

1. **TypedApproveOverHttp** (OwnerOnly; also NoUnapprovedExecution and DeniedNeverRuns). The
   allowApprovals refusal in `route()` covers only `msg.kind === "button"`. A typed `/approve <id>`
   posted to the HTTP API is a message: `handleCommand` → `handleButton` → `decide()`. Anything with
   the HTTP token, the agent's own tools included, can approve its own risky call, and once it has,
   the owner's Deny is ignored (first word wins). Replayed against the real daemon with
   `test/helpers/harness.ts`: after the button press over HTTP is refused, `onInbound({ channel:
   "http", kind: "message", text: "/approve ap_…" })` leaves the approval `consumed`, and the
   worker's `sudo true` runs. Fix: apply the same refusal in `handleCommand` for `/approve` and
   `/deny` (`if (to.channel === "http" && !s.cfg.channels.http?.allowApprovals)`), or move the check
   into one helper that both paths call before `handleButton`. Modeled as `TypedRefusedOverHttp`;
   with it every rule passes.
2. **HttpApprovalsOptIn** (OwnerOnly; a documented opt-in risk): with `channels.http.allowApprovals
   = true`, anything holding the HTTP token or a signed ntfy button URL approves as the owner. Keep
   it off unless tools cannot read vigil's config or environment.

By design and checked: a late Approve (after expiry, before the sweep) is ignored by `decide()`; an
Approve then Deny runs the call (first word wins); a stale button for another approval decides
only that approval; after `dispose()` every waiting call is blocked.
