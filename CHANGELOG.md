# Changelog

## 0.1.0 (2026-11-04)

The first version.

**Talking to vigil**
- Telegram (grammY, long polling), Discord DMs, Slack (Socket Mode), Signal (signal-cli),
  WhatsApp (Baileys, opt-in), ntfy push, an HTTP API
  with synchronous replies for iOS Shortcuts, and a terminal chat. One conversation across all of them.
- Pairing: a channel without an owner prints a one-time `/pair` code to the server log.
- Slash commands that work without a model: `/status`, `/tickets`, `/stop`, `/digest`, `/mute`,
  `/mode`, `/pause`, `/resume`, `/new`, `/login`.
- Photos and files from the phone; images go to models that accept them.
- A typing indicator while vigil answers; your messages interrupt slow background runs.

**Background work**
- Tickets with a mandate, one pi session and directory each, reports (`ready`, `blocked`, `failed`,
  `dropped`), structured questions with buttons, a reserved slot for the owner, turn timeouts,
  restart recovery, and parallel helper agents (`delegate`).
- Scheduler (cron with time zone, every N minutes, once), a cheap-gated heartbeat, nightly memory
  consolidation, and a weekly attention review.
- Watchers for pages, feeds and commands; triage under `off | observe | auto`.
- Web fetch and search tools; MCP servers from `mcp.json`.

**Attention**
- The attention governor: quiet hours, daily interrupt budget, minimum gap, critical cap, dedup,
  mutes, 👎 feedback, digests, and silent delivery when something must go out at night.
- Runtime invariant guards before each send.
- `vigil simulate` to try policies on your own history.

**Safety**
- Approval gate: risky calls wait for the owner's button; approvals are hash-bound, single-use and
  expiring; approvals never come from the HTTP API by default.
- bubblewrap sandbox for the shell; vigil's own state and the user's keys are hidden.
- Protected files (checked by real path), secret scrubbing, an SSRF guard for web fetches that checks
  the address inside the connection's own DNS lookup, and the rule of two for triage.
- Pairing codes expire, are single-use and lock out after repeated wrong guesses; approvals typed as
  `/approve <id>` on channels without buttons.

**Models**
- ChatGPT (Codex) via device-code login, also from the phone; OpenCode Go via API key; per-role
  model preferences with cooldowns and provider fallback; per-role reasoning effort; an alert when no
  model has answered for 30 minutes.

**Verification and tests**
- TLA+ models of the governor, approvals, outbox, scheduler and worker pool, with mutants that show
  each property can fail, and project-local verify skills to keep them in sync.
- 20 defects found by model checking and trace validation, each replayed on the TypeScript, fixed, and kept as a passing
  regression check with a mutant that undoes the fix (see docs/REPORT.md).
- About 580 unit, property and end-to-end tests that run the real daemon against pi's faux provider.
- `vigil demo` (a scripted day, no accounts) and `vigil eval` (behavioural scenarios on your models).

**Also**
- A web panel, a pi package for laptop pi sessions, Docker and systemd deployment, CI.
