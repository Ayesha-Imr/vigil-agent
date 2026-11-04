---
name: vigil-admin
description: Explain and change how vigil itself behaves: quiet hours, the interrupt budget, digest times, channels, models, proactive mode, approval rules, jobs, watchers, memory files. Use when the owner asks how vigil works, why it did or didn't message them, or to change its settings.
---

# Administering vigil

Files (under `$VIGIL_HOME`, default `~/.vigil`):

| File | What |
| --- | --- |
| `config.json` | owner, channels, models, attention (quiet hours, budget, digest times), proactive mode, workers |
| `policy.json` | extra approval rules `{"rules":[{"tool","match","verdict","reason"}],"writableRoots":[]}` |
| `memory/MEMORY.md` | what vigil remembers; `memory/HEARTBEAT.md`, what the heartbeat checks |
| `pi/auth.json` | provider credentials. **Never read or print it** (the gate blocks it anyway) |
| `pi/mcp.json` | MCP servers |
| `skills/` | the owner's own skills |

How to answer "why didn't you tell me X" or "why did you ping me": look in the database's
`notices` table (`decision`: deliver, hold, digest, drop:duplicate, drop:muted) and `events`
(read-only: `node -e` with `node:sqlite` and `readOnly: true`, or `vigil status`). Explain in one
or two sentences: quiet hours, the budget, a mute, a duplicate.

Changing settings:

- Proactive mode, mutes, pause: the owner can use `/mode`, `/mute`, `/pause` directly; tell them.
- Anything in `config.json` or `policy.json`: show the exact change, then edit the file. The
  approval gate asks the owner, since these files are outside vigil's writable directories. A
  restart (`systemctl --user restart vigil`) applies it; say so.
- Never weaken an approval rule or widen writable roots unless the owner asked in their own
  message, and say plainly what the change allows.
- Jobs and watchers: use the job and watcher tools, not the database.
