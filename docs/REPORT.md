# vigil: an always-on agent with a verified attention budget

*Technical report, November 2026. Draft.*

## Abstract

Always-on personal agents run in the background, watch things for their owner, and message them
first. Their characteristic failure is not a wrong answer but a wrong *interruption*: a ping at 3
a.m., the same news twice, a flood of low-value updates. We describe vigil, an open-source
always-on agent built on the pi agent harness. It treats the owner's attention as a resource with
a hard budget, enforced by a small pure state machine (the *attention governor*) between the
agent and the phone. We verify the governor's promises (a daily interrupt budget, quiet hours,
mutes, deduplication, no lost notices) in three independent layers: TLA+ model checking of the
design, property-based tests of the TypeScript implementation, and runtime re-checks against the
recorded delivery history before every send. We apply the same method to the other places where
an always-on agent can do lasting harm: approvals for risky tool calls, the durable outbox, the
scheduler and the worker pool. The model checker and the tests found real defects, including
approval and sandbox bypasses, a scheduler slot that could hold its job for six hours, and
notification times that misfired across daylight-saving changes. We report each, with its fix.

## 1. Problem

An always-on agent combines three things that are each fine alone:

1. **It runs unattended.** It acts on schedules and on changes it observes, not only on requests.
2. **It can speak first.** It sends messages to a phone that vibrates.
3. **It has tools.** It can run commands, write files and reach the network with the owner's
   credentials.

The first two together make attention the scarce resource: each unsolicited message has a real
cost, and the agent pays none of it. The first and third together make safety a standing concern:
there is nobody watching each step. Prompts help with both ("only notify when it matters"), but a
prompt is a request to a model, not a guarantee.

DeepSeek's dsh-superagent prototype states the principle we start from: *take as little human
attention as possible, and give as much value as possible*. vigil carries the principle from a
team bot to a personal agent. It makes the attention part a property of the code that can be
checked.

## 2. Design

vigil adapts dsh-superagent's domain model (Trigger, Ticket, Mandate, Report, Attention, stored work)
to one owner (see [DESIGN.md](DESIGN.md)).

- **Sources**: chat channels (Telegram, Discord, WhatsApp, HTTP, CLI), a scheduler, and watchers.
  Every event becomes a Trigger, stored before it is processed and keyed for idempotence.
- **Gate**: a deterministic owner check before any model sees a message.
- **Concierge**: one long-lived pi session across all channels. It answers quick requests itself
  and hands longer work to **workers** (one pi session and directory per ticket).
- **Triage**: watcher changes are judged by a cheap model in a session with no tools (the "rule of
  two": untrusted input, but no private data and no side effects), under an accept mode
  `off | observe | auto` that starts in `observe`.
- **Governor**: every unsolicited message passes `offer(notice, now)`, which returns `deliver`,
  `hold` (quiet hours), `digest`, `drop:duplicate` or `drop:muted`.
- **Approval gate**: a pi extension that holds risky tool calls until the owner approves that exact
  call. Approvals are bound to a hash of tool and arguments, single-use, and expiring.
- **Sandbox**: shell commands run under bubblewrap, with a read-only system, vigil's own state and
  the user's keys hidden, and only work directories writable.

### 2.1 The governor

State: the notices offered in the last seven days, the times of recent interrupts and critical
deliveries, mutes and per-topic penalties. Policy: time zone, quiet window, digest times, daily
budget `B` (default 3), minimum gap `G` (default 60 min), critical cap `C` (default 3), dedup window
and default expiry.

`offer` applies, in order: mute → drop; duplicate key within the window → drop; critical within
the cap → deliver (ignoring quiet hours and `B`; over the cap it is treated as high); low → digest;
quiet hours → hold; within `B` and `G` → deliver; else → digest. `tick` expires stale notices and
flushes one digest at each digest time and when quiet hours end. When the owner writes first,
waiting notices are offered to the reply, and are marked delivered only once that reply is stored.

The rules this guarantees (checked in §3):

| Rule | Statement |
| --- | --- |
| Budget | In any 24 h window, individual high/normal deliveries ≤ `B`, at least `G` apart |
| CriticalCap | In any 24 h window, critical deliveries ≤ `C` |
| Quiet | No unsolicited non-critical delivery during quiet hours, digests included |
| NoMuted | Nothing is delivered on a muted topic |
| NoDuplicate | Two delivered notices never share a dedup key within the dedup window |
| Conservation | Every offered notice is in exactly one state and delivered at most once |
| EventuallyResolved | Every waiting notice is eventually delivered, dropped or expired |

## 3. Verification

We follow pstack's formal-verification method: choose targets where a bug costs the most and
tests reach the least; keep the model true to the code (each action names its function, one
atomic step in code is one step in the model); show every property failing on a broken variant
before trusting a pass; report findings as findings; and leave a project-local skill so the next
agent can rerun and maintain the check.

**Three layers for the governor.** A defect has to get past all three to reach the phone.

1. *Model checking* (TLA+/TLC): every interleaving of offers, ticks, replies and mutes, with
   discrete time and small bounds.
2. *Property-based tests* (fast-check): random sequences of the same actions against the real
   TypeScript, 400 runs per property, in four time zones with different policies.
3. *Runtime guard*: before each send, the rules are checked again against the delivery history in
   the database. That history is independent of the governor's own state. A violation refuses the
   send.

**Other targets.** Approvals (no unapproved execution, single use, denied/expired never run),
the outbox (order per conversation, no loss, duplicates only through a crash window), the
scheduler (one trigger per slot, no overlap, no lost slot), and the worker pool (no double run,
slot limits, the owner's message never starved).

**Behavioural evals.** The language model sits outside every guarantee above, so vigil ships
scenario evals (`vigil eval`) that run against the owner's real models. Each scenario checks
*actions*, not wording: a reminder must become a scheduled job, not a promise in text; arithmetic
must be answered without opening a ticket; a heartbeat with nothing to report must send nothing; an
outage must be notified as critical or high; an instruction hidden in a pasted email must not be
followed. The scenarios are themselves tested both ways: a scripted well-behaved model passes them,
and a scripted badly behaved one fails each for the stated reason. Without credentials the runner
refuses to run, since an agent that cannot think would "pass" every silence check.

<!-- RESULTS: filled from verification/README.md when the runs complete -->

## 4. Findings

Defects found by the tests, the model checker and a code audit, and fixed:

| Area | Defect | Found by |
| --- | --- | --- |
| Gate | `cat auth.json` after a `cd`, `tar ~/.ssh`, `rm -f -r` and `git clean -fd` classified safe | property and unit tests |
| Gate | An agent tool that read the HTTP token could press the approve button for its own call | audit |
| Gate | `write ~/.bashrc` passed the root check (pi expands `~`; the check did not) | audit |
| Watchers | A command watcher ran an arbitrary shell command on a schedule without approval | audit |
| Watchers | A page returning to an earlier state was never reported again | unit tests |
| Scheduler | A replayed slot marked its job running with no run to complete it (held for 6 h) | unit tests |
| Governor | Digest times in a skipped DST hour never fired; in a repeated hour they fired twice | audit, then tests |
| Workers | Stopping the daemon left helper sessions running and writing after the database closed | writing the F1c regression test |
| Gate | A typed `/approve <id>` over the HTTP API bypassed the refusal that covered approve buttons | third review |
| Workers | A clean shutdown during a worker turn reported the ticket failed, so it was never recovered | third review |
| Config | `BRAVE_API_KEY` from the environment was written to config.json on save | third review |
| SSRF | The address check ran before the fetch's own DNS lookup (a rebinding window) | second audit, closed later |
| Concierge | Notices handed to a reply were marked delivered even if the reply failed | audit |
| Tickets | Follow-ups addressed by a ticket's short name were silently lost | audit |
| HTTP API | Concurrent requests could receive each other's replies | audit |
| ntfy | Signed action URLs on a public topic let anyone approve | audit |
| Models | A request ID containing `401` cooled a whole provider down for 30 minutes | unit tests |
| Gate | `git -C repo push` (any git global option) skipped every git rule | writing `vigil demo` |
| Gate | Relative paths and symlinks (`read ../../config.json`) walked around protected-file rules | second audit |
| Pairing | A 6-digit code with no expiry or rate limit could be brute-forced | second audit |
| SSRF | IPv4-mapped IPv6 literals (`[::ffff:a9fe:a9fe]`) passed the internal-address check | second audit |
| Inferred work | Tickets started from untrusted pages could read and write memory | second audit |

Defects found by model checking (each replayed on the real code before it was fixed, and each fix
checked by the model):

| Spec | Defect | Harm |
| --- | --- | --- |
| Governor | A notice shown to a reply being written could also go out in the end-of-quiet digest during the turn | The owner was told twice |
| Governor | A reply with an error but some text did not mark its notices told | Repeated in a digest |
| Governor | A mute during a turn dropped a notice the reply had already told; after an unmute it came back | A duplicate |
| Governor | `/digest` did not expire notices first; gap and dedup windows longer than the history were accepted | A stale notice shown; a rule silently weaker than configured |
| Scheduler | A run that outlived its lease could free the job a newer run held | Overlap no longer bounded by the lease |
| Scheduler | A run claimed just before a crash never ran | A lost reminder or job |
| Scheduler | A slot due exactly at the claim instant was neither run nor counted | Missed runs under-reported |
| Workers | `/stop` while a worker session was starting did not stop it | Withdrawn work done anyway |
| Workers | An owner message pending when a ticket reported ready was never delivered | A lost message |
| Workers | Inputs of a first turn cut by a timeout were lost | "Reply to continue" that went nowhere |
| Workers | No worker model plus a pending input re-ran the ticket on promise callbacks | The daemon froze at 100% CPU |
| Outbox | A ticket's question (and its approval ask) could be overtaken by the ticket's next report | Messages out of order |
| Outbox | Two daemons on one database each sent every message; the first lock was not atomic and could be taken from a suspended, live holder | Every message twice |
| Outbox | A worker's helper session sent its approval ask with no order key, ahead of the ticket's pending question | Asked to approve before seeing the question |
| Outbox | Without /proc (macOS), a daemon started after a machine suspend took the lock from a live holder, which kept sending its snapshot | A few messages twice |
| Workers | A crash during a ticket's first turn left no session file recorded; the restart began a new session without the owner's message | The owner's instruction silently lost |
| Governor | A notice claimed for a reply could be pruned from the history before the reply ended | Neither told nor released |
| Governor | A claim released after its topic was muted returned the notice to the queue | A muted topic delivered in a digest |

The mutation discipline mattered: several first drafts of the models passed trivially, and only
showed their weakness when a mutant that removes a real check was *not* caught. Writing the
property-based tests and the model of the same rule separately also paid off. The tests caught gate
and watcher bugs the models do not cover, and the models caught ordering bugs the tests never
reached.

## 5. Limitations

- **Bounds.** Model checking covers small configurations: a few notices, a short horizon, small
  budgets. A pass is evidence about the design within those bounds, not a proof for all sizes.
- **The model is a model.** It describes the code at a recorded commit. The verify skills record
  coverage and a sync commit so drift can be detected, but they cannot prevent it.
- **Not verified**: the language models themselves, the channel libraries, pi's internals, and
  anything an LLM chooses to do *within* its permissions. The governor bounds *how often* the agent
  can interrupt, not *whether* each interruption is worth it.
- **No live evaluation yet.** We have not measured usefulness per interruption with real users.
  The weekly review and the 👎 feedback loop collect the data such a study would need.

## 6. Related work

dsh-superagent (DeepSeek) for the domain model and the attention principle. OpenClaw for heartbeat
checklists and "nothing to report" replies. Hermes Agent for cheap deterministic gates before any
model wakes. Letta's sleep-time compute, and OpenClaw's "dreaming", for nightly memory
consolidation. Meta's rule of two for sessions that read untrusted input. Research on notification
batching (Fitz et al. 2019) for digests over immediate delivery.

## 7. Future work

- Learn per-topic urgency from the owner's reactions, with the governor's rules as hard
  constraints on top of the learned policy (safe exploration for notification timing).
- An offline benchmark of notification streams with owner judgements, to compare policies
  (`vigil simulate` is the harness for it).
- Refinement checking of the TypeScript against the TLA+ model via trace validation, rather than
  two separate checks of the same rules.
