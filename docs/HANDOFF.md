# Handoff

State at the end of the first build session (November 2026).

## Done

- The daemon, the channels, the agent layer, the panel, the CLI, `vigil demo` and `vigil eval`.
  About 590 tests pass, and CI is green.
- Five TLA+ models (governor, approvals, outbox, scheduler, workers), each synced to the current
  code. Each has mutants that undo its fixes, and none has an open finding.
- Trace validation of the real governor and outbox against their models.
- Three security audits and one code review. Every confirmed finding is fixed and has a
  regression test. See [REPORT.md](REPORT.md).

## Manual steps on GitHub

The build session could only push commits, so these are still to do:

1. Delete the branches `wip/governor-resync` and `wip/outbox-trace`. Their work is all on `main`.
2. Set the repository description: "An always-on personal agent on pi with a model-checked
   attention budget: it works in the background and only interrupts you when it's worth it."
3. Set the topics: `ai-agent`, `pi`, `tla-plus`, `formal-verification`, `telegram-bot`,
   `personal-assistant`, `typescript`.
4. Optional: the first commit has a co-author trailer. Removing it means rewriting history and
   force-pushing.

## Not yet tested

- **Real models.** Nothing has run against a real LLM yet. Run `vigil login codex` (or
  `vigil login opencode <key>`), then `vigil eval`, and fix the prompts the scenarios show are
  weak.
- **Real chat apps.** Telegram, Discord, Slack, Signal and WhatsApp are tested only with fake
  channels. Pair one with `/pair` and try the README's walkthrough.

## Next work, roughly in order of value

1. A week of real use with the default policy. Then `vigil simulate` on that history, to tune the
   budget, gap and quiet hours.
2. Trace validation for the scheduler and the workers. Follow `verification/outbox/trace/`, which
   records between awaits.
3. DST in the governor model (`crossed()` with repeated and skipped hours). Today only unit tests
   cover it.
4. A per-topic urgency learned from 👎 and mutes, with the governor's rules kept as hard
   constraints on top.

When code covered by a model changes, use the verify skills in `.claude/skills/`. Each one says
how to tell whether a change touches its model and how to resync it.
