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
goes through `handleCommand` to the same `handleButton`, and since d83a053 it is refused the same
way when it came over `http` or `ntfy` (before that it was not: fixed finding `TypedApproveOverHttp`).
The model checks the two refusals separately, so either one can fail on its own.

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
  own, so TRUE checks a superset), `Shutdown` (include `dispose()`).
- `MCApprovals.tla` — symmetry over calls and hashes (safety only).
- Required, run by `run.sh`: `Approvals.cfg` (every rule, three approval rows),
  `Approvals_shutdown.cfg` (every rule with `dispose()`, two rows), `Approvals_live.cfg` (liveness).
- `--deep`: `Approvals_deep.cfg` (MaxTime = 4, shutdown, every rule).
- `findings/HttpApprovalsOptIn.cfg` (`\* expect: OwnerOnly`): must break its rule.
- Mutants: `verification/mutants/approvals-*.mutant`, each naming the code change it mirrors
  (approvals-07 removes the button refusal, approvals-10 the typed one).

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
| `Press(p, a, b, t)` | `Daemon.route` src/daemon.ts:481 (`tryPair` :485, `isOwner` :489; button: HTTP refusal :508 → `handleButton` :637; typed: `handleCommand` :530 → `/approve` `/deny` :749, HTTP/ntfy refusal :757 → `handleButton`) → `decide()` approvals.ts:120, which calls the waiter |
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

Sync commit: `f3ff16b37ead2f70cad41f3e2f1529f07c71d150` (covered files clean at that commit).

| File | Code covered | Blob at sync commit |
| --- | --- | --- |
| src/core/approvals.ts | `request`, `wait` (timer, abort listener, disposed), `decide`, `consume`, `expire`, `dispose` | `9368484524190db26f4add0b9d7bd6cdef93687e` |
| src/agent/gate.ts | `approvalGate`'s `tool_call` hook (request, ask, wait, consume) | `83ac4f72ac2d7316e6b8df51d040bb08370ae767` |
| src/daemon.ts | `route` (tryPair, isOwner drop, HTTP button refusal), `handleCommand` `/approve` `/deny` (HTTP/ntfy refusal), `handleButton`, `tickGovernorAndClock` expire | `7a12c62c787931e3af00c101df4b5220cecadd91` |
| src/config.ts | `isOwner`, `channels.http.allowApprovals` | `aebcafe815d39402c7a244a52a5f92ee7d782bb0` |

To find drift: `git diff f3ff16b -- src/core/approvals.ts src/agent/gate.ts src/daemon.ts src/config.ts`,
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

`FIXED?` on `findings/HttpApprovalsOptIn.cfg` means HTTP presses with `allowApprovals = true` are
now authenticated as the owner: model that the way the code does, then delete the finding. If no
code change explains a `FIXED?`, the model drifted: find out why before trusting a pass.

## Findings

Open at the sync commit:

- **HttpApprovalsOptIn** (OwnerOnly; a documented opt-in risk): with `channels.http.allowApprovals
  = true`, anything holding the HTTP token or a signed ntfy button URL approves as the owner. Keep
  it off unless tools cannot read vigil's config or environment.

Fixed:

- **TypedApproveOverHttp** (OwnerOnly, NoUnapprovedExecution, DeniedNeverRuns), fixed in d83a053.
  `route()` refused approve/deny over HTTP only for `msg.kind === "button"`; a typed `/approve <id>`
  posted to the HTTP API went `handleCommand` → `handleButton` → `decide()`, so anything with the
  token, the agent's own tools included, could approve its own risky call, after which the owner's
  Deny was ignored. Replayed against the real daemon with `test/helpers/harness.ts`: the HTTP button
  press was refused, the typed message left the approval `consumed`, and the worker's `sudo true`
  ran. Mutant approvals-10 reverts the fix. Model gap, recorded honestly: the first approvals model
  (before 66af270) had only button presses and would have missed this; the typed action was added
  when `/approve` appeared in daemon.ts, and it found the bypass at once.

By design and checked: a late Approve (after expiry, before the sweep) is ignored by `decide()`; an
Approve then Deny runs the call (first word wins); a stale button for another approval decides
only that approval; after `dispose()` every waiting call is blocked.
