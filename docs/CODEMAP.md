# Code map

Where things live, for someone changing vigil. Read [DESIGN.md](DESIGN.md) first for the concepts.

## Entry points

| File | What |
| --- | --- |
| `src/cli.ts` | The `vigil` command: init, login, models, start, chat, status, doctor, simulate, service, verify |
| `src/daemon.ts` | Builds the services, starts channels, routes every inbound message (gate, pairing, buttons, reactions, replies, slash commands), runs jobs, heartbeat, dream and weekly review, and the loops |
| `pi/vigil-remote.ts` | The pi extension shipped as a pi package: `vigil_ticket`, `vigil_notify`, `vigil_ask`, `/vigil`, long-run pings |

## Core (no model calls)

| File | What | Verified by |
| --- | --- | --- |
| `src/core/governor.ts` | The attention governor: pure `offer`, `tick`, `takeForReply`, `markDelivered`, `mute`, `penalize`, `crossed` (DST-aware) | `verification/governor`, `test/governor.property.test.ts` |
| `src/core/invariants.ts` | Runtime re-check of the governor's rules against the delivery history, before each send | `test/invariants.test.ts` |
| `src/core/notifier.ts` | The governor plus persistence and delivery through the outbox | e2e tests |
| `src/core/outbox.ts` | Stored-first outbound messages, retries, ordering per key, message refs for reply routing | `verification/outbox`, `test/outbox.test.ts` |
| `src/core/approvals.ts` | Hash-bound, single-use, expiring approvals | `verification/approvals`, `test/approvals.test.ts` |
| `src/core/scheduler.ts` | Jobs (cron, every, at) with one trigger per slot, no overlap, coalescing | `verification/scheduler`, `test/scheduler.test.ts` |
| `src/core/tickets.ts` | Tickets, mandates, reports, stages, the input queue | `verification/workers`, `test/tickets.test.ts` |
| `src/core/watchers.ts` | URL, feed and command watchers; compare-and-swap snapshots | `test/watchers.test.ts` |
| `src/core/time.ts` | Clocks, local time of day | |
| `src/store/db.ts` | SQLite schema, migrations, transactions, the audit log (secrets masked) | |
| `src/memory/memory.ts` | `MEMORY.md`, journals, notes, search | `test/memory.test.ts` |
| `src/simulate.ts` | `vigil simulate`: replay notices through the governor | `test/simulate.test.ts` |

## Agent layer (pi)

| File | What |
| --- | --- |
| `src/agent/sessions.ts` | Builds pi sessions per role (model, tools, skills, gate, sandbox, MCP), per-turn prompt filling, `promptWithFallback` |
| `src/agent/models.ts` | Role → model routing, error classes, cooldowns, provider fallback |
| `src/agent/concierge.ts` | The long-lived conversation: batching, steering, owner preemption, notes from elsewhere, attachments, typing |
| `src/agent/workers.ts` | The ticket worker pool: slots plus the owner's reserved slot, turn timeouts, recovery |
| `src/agent/triage.ts` | Watcher changes → a tool-less decision under the accept mode |
| `src/agent/tools.ts` | vigil's tools for each role |
| `src/agent/delegate.ts` | Parallel helper sessions for workers |
| `src/agent/web.ts` | `web_fetch` (with SSRF guard) and `web_search` |
| `src/agent/gate.ts` | The approval gate extension and its rules |
| `src/agent/sandbox.ts` | bubblewrap sandbox for the shell |
| `src/agent/prompts.ts` | Every prompt |
| `src/agent/services.ts` | The shared services object, solicited sends, concierge notes |

## Channels

`src/channels/types.ts` is the port. `telegram.ts`, `discord.ts`, `whatsapp.ts`, `ntfy.ts`, `http.ts`,
`cli.ts` implement it; `index.ts` builds the configured set. `src/panel/panel.ts` is the web panel
and the extra HTTP API routes.

## Skills and verification

- `skills/`: shipped to vigil's own agents. `formal-verification` (model-visible) points to the
  vendored pstack skills; also `github`, `research`, `morning-brief`, `vigil-admin`.
- `verification/`: TLA+ specs, mutants and `run.sh`. Each spec has a project-local verify skill in
  `.claude/skills/` and `.pi/skills/` that says when to rerun it and how to keep it in sync.

## Tests

`npm test` runs everything (about 500 tests, under 15 s): unit, property-based (fast-check) and
end-to-end tests. The e2e tests run the real daemon and real pi sessions against pi's faux provider and a fake
chat channel (`test/helpers/harness.ts`). No network, no keys.
