---
name: verify-approvals
description: Model-check vigil's approvals for risky tool calls (TLA+/TLC) — a call runs only on a consumed owner approval for that exact call before expiry, each approval runs at most one call, denied and expired requests never run, only the owner's presses decide, and the gate never hangs. Use whenever a change touches src/core/approvals.ts (request, wait, decide, consume, expire, dispose), the approval gate in src/agent/gate.ts (the tool_call hook), how a button press reaches decide() in src/daemon.ts (route, handleButton, the HTTP allowApprovals refusal, tickGovernorAndClock's expire), isOwner in src/config.ts, or how a channel maps senders to owner identities; and before claiming anything about who can approve what.
---

# Verify approvals

`verification/approvals/Approvals.tla` is a TLA+ model of a risky tool call held by the gate
until the owner approves that exact call. node:sqlite is synchronous and the daemon is one JS
thread, so a run of code with no `await` is one step in the model. TLC checks every interleaving
of: two tool calls (same or different arguments) requesting approvals and retrying, button
presses by the owner, a stranger and an HTTP client on any approval ever sent (late, twice,
stale, another call's), wait timers, the 30-s expiry sweep, aborts, shutdown (`dispose`), and the
clock moving on.

## Properties (property — harm if broken)

| Name | Property | Harm |
| --- | --- | --- |
| `NoUnapprovedExecution` | A call runs only if `consume()` returned true for an approval with this call's hash that the owner approved before it expired. | A risky command runs without the owner's yes. |
| `SingleUse` | One approval lets at most one call run, once. | One yes runs a command twice. |
| `DeniedNeverRuns` | When the owner's first word on a request was Deny, nothing runs on it. | A denied command runs. |
| `ExpiredNeverRuns` | Nothing runs on an approval at or after its expiry. | A stale yes runs a command long after. |
| `OwnerOnly` | Every decision that changed an approval came from the owner. | Someone else, or the agent itself, approves. |
| `GateResolves` (liveness) | A call held by the gate is eventually run or blocked. | The agent hangs on a tool call. |

"The owner's first word" is the semantics `decide()` promises: only a pending, unexpired request
changes, so a later tap (Deny after Approve, or the reverse) is ignored and reported.

## Who can press a button: the boundary decide() does not check

`decide(id, approve)` takes no identity. Owner identity is enforced by its caller,
`Daemon.route()`: `isOwner(cfg, channel, senderId)` drops non-owners, and approve/deny arriving on
the `http` channel is refused unless `channels.http.allowApprovals` is true (commit 81f48ef),
because `isOwner()` is true for every HTTP request and anything holding the token (the panel, a
signed ntfy button, the agent's own tools) can send one. The model has three principals:
`owner` (an identity in `owner.identities`, or the `vigil chat` terminal on the daemon's stdin),
`stranger` (any other chat sender) and `http` (an attacker-capable principal). Only `owner`
presses count as the owner's word. Assumptions: channels report sender ids truthfully, and the
CLI channel is only reachable by the person at the terminal.

## Run it

```sh
bash verification/run.sh --only approvals          # about 40 s on 4 cores
bash verification/run.sh --only approvals --deep   # adds MaxTime = 4 (about 1 min more)
bash verification/mutate.sh approvals              # every property fails on a broken variant
```

Needs Java 11+; TLC comes from `$TLA2TOOLS` or is downloaded once (TLC 1.7.4, sha256-checked)
by `verification/lib.sh`. `PASS` = every rule holds; `FAIL` = a rule broke or TLC errored;
`FINDING` = a `findings/*.cfg` reproduced the violation it records; `FIXED?` = it no longer does
(see below). TLC's full output is in `verification/out/approvals-<config>.out`.

## Files

- `Approvals.tla` — the model; every action's comment names the code it mirrors.
- `MCApprovals.tla` — symmetry over calls and hashes (safety only).
- `Approvals.cfg` (safety, must pass), `Approvals_live.cfg` (liveness, must pass),
  `Approvals_deep.cfg` (`--deep`).
- `findings/HttpApprovalsOptIn.cfg` — `\* expect: OwnerOnly`; must break it (see below).
- Mutants: `verification/mutants/approvals-*.mutant`, each naming the code change it mirrors.

`AnyIdToConsume = TRUE` lets the gate present any approval id to `consume()`; gate.ts presents
its own `a.id`. Checking the larger set shows that approvals.ts alone keeps the rules (the
`hash` check is what stops one call from running on another call's approval), so a future caller
that resumes calls by id stays safe.

## Reading results

Read every TLC result with the pstack `/statechart` skill (vendored in `skills/statechart/`): it
gives each violation as its shortest path in plain words and, on a pass, draws the state graph.
For a chart, shrink the config (one call, `MaxApprovals = 1`) to stay under its 500-state budget.

By hand: after `Error: Invariant X is violated.` in `verification/out/…out`, each `State k:
<Action …>` is one step. Tell it in the code's words, for example: "a worker's `bash` call hits
`approvalGate` → `request()` creates ap 1, `ask()` sends the buttons, `wait()` registers →
`POST /api/button approve:ap_1` with the HTTP token → `route()` → `handleButton` → `decide()`
approves → the gate's `consume(a.id, callHash(...))` returns true → the call runs".

## Action ↔ code

| Action | Code (sync commit) |
| --- | --- |
| `Request(c)` | gate.ts:174–185: `classify` risky, `approvals.request()` (approvals.ts:53), `h.ask()` (outbox enqueue of the buttons), `approvals.wait()` up to its first await (approvals.ts:86) |
| `Press(p, a, b)` | `Daemon.route` src/daemon.ts:430 (`isOwner` :438, HTTP refusal :452) → `handleButton` :569 → `decide()` approvals.ts:120, which calls the waiter |
| `Timer(c)` | `wait()`'s `setTimeout`: `expire()` then `done(status === "approved" ? …)` |
| `Sweep` | `Daemon.tickGovernorAndClock` daemon.ts:257 `approvals.expire()` (approvals.ts:154) |
| `Abort(c)` | `wait()`'s abort listener: UPDATE to expired if pending/approved, `done("expired")` |
| `Dispose` | `Approvals.dispose()` at shutdown |
| `Continue(c, a)` | gate.ts:187: `outcome === "approved" && consume(a.id, callHash(tool, input))` (`consume()` approvals.ts:141) |
| `Retry(c)` | the model issues the same tool call again (a new `tool_call` event) |

Not modeled: `classify()` and the rules (which calls are risky), `callHash`/`stableStringify`
collisions (assumed injective), pi mutating `event.input` after the hook returns, the outbox
delivery of the buttons, a restart (rows persist and waiters do not; covered by `Dispose` plus
retries as new calls), more than two calls or three approvals.

## Coverage record

Sync commit: `4c99637b24dc9967b2dd55f5ad77bb5296605d61` (covered files clean at that commit).

| File | Code covered | Blob at sync commit |
| --- | --- | --- |
| src/core/approvals.ts | `request`, `wait` (timer, abort listener, disposed), `decide`, `consume`, `expire`, `dispose` | `9368484524190db26f4add0b9d7bd6cdef93687e` |
| src/agent/gate.ts | `approvalGate`'s `tool_call` hook (request, ask, wait, consume) | `2cde942627bcdb773eb3203b24d045150ce01966` |
| src/daemon.ts | `route` (isOwner drop, HTTP approve/deny refusal), `handleButton` approve/deny, `tickGovernorAndClock` expire | `f050e25a3668d447257273ac4395368e656228d8` |
| src/config.ts | `isOwner`, `channels.http.allowApprovals` | `b2ccacff6987e11d2d38bbd6a95eabd5d402b3f9` |

To find drift: `git diff 4c99637 -- src/core/approvals.ts src/agent/gate.ts src/daemon.ts src/config.ts`,
and look for any new caller of `decide()`, `consume()` or `expire()`, a new way to press a
button, or a channel whose sender ids are not the platform's own (`git grep -n "decide(\|consume("`).

## When the code changes on purpose

1. Read the diff of the covered files since the sync commit, and decide per change: no effect;
   the model no longer describes the code (a new await between steps, a new guard, a new
   caller); or the promise changed on purpose (cite the evidence).
2. Change `Approvals.tla` from the code: one step with no `await` in the code is one action, and
   each action's comment names its code. Change a property only for a promise that changed on
   purpose; write down the old and new wording.
3. Run `bash verification/run.sh --only approvals` and `bash verification/mutate.sh approvals`.
   Every mutant must still be caught; add one for each new check in the code.
4. Move the sync commit and blob ids forward only after you confirm the model describes the code
   at the new commit. Copy this file to `.pi/skills/verify-approvals/SKILL.md`.

## When a finding stops reproducing

`FIXED?` on `findings/HttpApprovalsOptIn.cfg` means `OwnerOnly` now holds with
`AllowHttpApprovals = TRUE`: either the code now authenticates HTTP presses as the owner (model
that, then delete the finding) or the model drifted. Find out which before trusting a pass.

## Open findings at the sync commit

- No bug in the code as configured by default: every property holds within the bounds, and
  every mutant is caught.
- `HttpApprovalsOptIn` (OwnerOnly, a documented opt-in risk): with
  `channels.http.allowApprovals = true`, anything holding the HTTP token, or a signed ntfy button
  URL, approves as the owner, including the agent's own tool calls. Keep it off unless tools
  cannot read vigil's config or environment.
- By design and checked: a late Approve (after expiry, before the sweep) is ignored by
  `decide()`; an Approve then Deny runs the call (first word wins); a stale button for another
  approval only decides that approval.
