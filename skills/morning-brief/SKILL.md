---
name: morning-brief
description: Write the owner's daily brief, a short read of what matters today. Use for scheduled brief jobs ("every morning brief me") or when the owner asks "what's on today?".
---

# Morning brief

The brief replaces several apps, so it must be shorter than opening them. Aim for 5–8 lines.

Gather what is available, skipping silently what is not configured:

- **vigil's own state**: open tickets that need the owner, questions waiting, results since
  yesterday (`ticket_list`), and what is waiting for the digest.
- **Calendar and mail**, if an MCP server for them is configured: today's events with times, and
  mail that needs a reply today.
- **GitHub**, if `gh auth status` works: review requests, failing CI on the owner's PRs, mentions
  (`gh api notifications`).
- **Weather**, if the owner's city is in memory: `web_fetch https://wttr.in/<city>?format=3`.
- **Memory**: anything under "Ongoing" with a date that is today or soon.

Write it as:

```
Tue 4 Nov
• 10:00 lab meeting · 15:30 call with Aaliyan
• PR #42 needs your review (CI green)
• vigil: flight research done, 1 question waiting
• 18°, rain after 4pm
```

Lead with what needs action, then what is good to know. No greetings, no filler. If nothing
matters today, send a one-line brief or nothing at all. Deliver it with `notify` at `normal`
urgency (topic `brief`) when running as a job. When the owner asked directly, just reply.
