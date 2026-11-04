# FAQ

**What does it cost to run?**
A small always-on machine (a $4–6/month VPS, or a computer you already have) plus the model
subscriptions you already pay for: ChatGPT Plus/Pro through Codex, and/or OpenCode Go. vigil keeps
model calls down: watchers and the heartbeat only wake a model when something changed or there is
something to look at, triage uses the cheaper model, and slash commands use no model at all.

**Will it spam me?**
Not by design. Everything vigil says on its own passes the attention governor: by default at most
3 interruptions a day, an hour apart, nothing but critical alerts during quiet hours, repeats
dropped, and the rest batched into two digests. Every interruption has a Mute button. `/why` shows
why something was or wasn't sent, and `vigil simulate` shows what a stricter or looser policy would
have done with your own history.

**Can it do things I didn't ask for?**
It acts when you ask, or when a rule you wrote allows it: a job you scheduled, a watcher you set up.
Proactive work from watchers starts in observe mode, which records what vigil would have done and
does nothing. Risky actions (pushing, deleting, `sudo`, tools that send, pay or delete) wait for
your Approve button, whoever started them.

**What stops a web page from taking over the agent?**
Several layers. Content is labelled as data. Triage of watched pages runs on a model with no tools,
and work it starts gets no file tools. Approvals come only from your chat app. vigil's own config
and your credentials are off limits to every tool, and with bubblewrap installed the shell runs
in a sandbox where they are hidden. None of this makes an LLM incorruptible, but an injected page
should not be able to run a risky command, read a credential, or approve its own action.

**Why TLA+?**
Because the bugs that matter here are about *order and time*: two messages racing, a crash between
two steps, a timer firing during quiet hours, a run outliving its lease. Tests check the orderings
someone thought of; a model checker checks all of them within small bounds. It found real bugs
in vigil (see `verification/` and `docs/REPORT.md`).

**Does it work without internet?**
No. The models are remote. The daemon itself keeps working when providers or channels are down:
messages wait in the outbox, model failures fall back to the other provider, and you get one alert
when no model has answered for half an hour.

**Where is my data?**
In `~/.vigil` on your machine: a SQLite database, memory files, session transcripts and your
provider tokens. Messages go to your model providers to be answered, and to the chat apps you use.
Nothing else leaves the machine.

**Why is WhatsApp "unofficial"?**
The official WhatsApp Cloud API needs paid templates to message you more than 24 hours after you
last wrote, and its terms exclude general-purpose AI chatbots. So vigil links as a WhatsApp device
through Baileys, which WhatsApp does not endorse and may ban. Use a spare number, or use Telegram.

**Can I use other models?**
Yes. pi supports many providers. Log in with pi's own `/login` against `~/.vigil/pi`, and list the
models in `config.json` under `models`, e.g. `"worker": ["anthropic/*", "openai-codex/*"]`. The
two subscriptions are just the defaults.

**Can several people use one vigil?**
No. vigil has exactly one owner, and that is a design choice: memory, attention budget and
approvals are all personal. Run one instance per person.
