// `vigil demo`: a day with vigil, in the terminal, without accounts or keys. The real daemon,
// governor, scheduler, tools and approval gate run against a scripted model and a fast clock; only
// the model and the phone are pretend. What it prints is what the phone would have shown.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Channel, InboundMessage, OutboundMessage, SendResult } from "./channels/types.ts";
import { defaultConfig, paths } from "./config.ts";
import { ManualClock, MINUTE } from "./core/time.ts";
import { Daemon } from "./daemon.ts";

const TZ = "UTC";
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

class Phone implements Channel {
	readonly id = "telegram" as const;
	sent: OutboundMessage[] = [];
	private handler?: (m: InboundMessage) => Promise<void>;
	private seq = 0;
	private readonly clock: ManualClock;
	constructor(clock: ManualClock) {
		this.clock = clock;
	}
	async start(h: (m: InboundMessage) => Promise<void>): Promise<void> {
		this.handler = h;
	}
	async send(m: OutboundMessage): Promise<SendResult> {
		this.sent.push(m);
		const buttons = m.buttons?.flat().map((b) => `[${b.label}]`).join(" ");
		const buzz = m.silent ? dim("(silent)") : "📳";
		console.log(`${time(this.clock.now())}  ${buzz} ${bold("vigil")}: ${m.text.replace(/\n/g, "\n                ")}${buttons ? `\n                ${dim(buttons)}` : ""}`);
		return { externalId: `1:${this.sent.length}` };
	}
	ownerConversation(): string {
		return "1";
	}
	async stop(): Promise<void> {}
	async type(text: string): Promise<void> {
		console.log(`${time(this.clock.now())}     ${bold("you")}: ${text}`);
		await this.handler?.({ channel: "telegram", externalId: `1:in${++this.seq}`, senderId: "1", conversation: "1", kind: "message", text, at: this.clock.now() });
	}
	async press(label: string): Promise<void> {
		const b = [...this.sent].reverse().flatMap((m) => m.buttons?.flat() ?? []).find((x) => x.label === label);
		if (!b) return;
		console.log(`${time(this.clock.now())}     ${bold("you")}: ${dim(`tap [${label}]`)}`);
		await this.handler?.({ channel: "telegram", externalId: `1:b${++this.seq}`, senderId: "1", conversation: "1", kind: "button", text: "", data: b.data, at: this.clock.now() });
	}
}

function time(t: number): string {
	return dim(new Date(t).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }));
}

type Msg = { role: string; content: unknown };
const textOf = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string }).text ?? "").join("") : "");
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** The notes repository the demo pushes for real (to a local bare "remote"). */
let notesRepo = "";

/** The pretend model: what a good model would do at each step of the story. */
function brain(msgs: Msg[]): AssistantMessage {
	const system = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
	// Look only at the current turn: the last user message and the tool results after it.
	const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
	const user = textOf(msgs[lastUser]?.content);
	const tool = textOf([...msgs.slice(lastUser + 1)].reverse().find((m) => m.role === "toolResult")?.content);
	const worker = system.includes("You are a vigil worker");
	if (worker) {
		if (tool.startsWith("Reported")) return fauxAssistantMessage("Done.");
		if (system.includes("e-ink")) {
			return call("report", {
				kind: "ready",
				summary: "Top 3 for reading papers: reMarkable Paper Pro (best pen feel, 11.8\"), Boox Note Air4 C (Android, colour, opens any PDF app), Kindle Scribe (cheapest, weakest PDF tools). For dense two-column papers I'd pick the Boox.",
			});
		}
		if (system.includes("push the notes")) {
			if (tool.includes("Not run")) return call("report", { kind: "blocked", summary: "The push was not approved." });
			if (/main -> main|new branch/.test(tool)) return call("report", { kind: "ready", summary: "Pushed your reading notes to origin/main." });
			if (tool) return call("report", { kind: "failed", summary: `The push failed: ${tool.slice(0, 120)}` });
			return call("bash", { command: `git -C ${notesRepo} push origin main 2>&1` });
		}
		return fauxAssistantMessage("Nothing to do.");
	}
	if (user.includes("call the bank")) {
		if (!tool) return call("schedule_job", { name: "call the bank", kind: "at", spec: new Date(Date.UTC(2026, 10, 5, 11, 0)).toISOString(), action: "remind", prompt: "Call the bank" });
		if (tool.startsWith("Scheduled")) return call("spawn_ticket", { title: "Compare e-ink tablets", request: "find me the 3 best e-ink tablets for reading papers", scope: "Research and compare; no purchases." });
		return fauxAssistantMessage("Done: reminder at 11:00. I'm researching e-ink tablets in the background and will report back.");
	}
	if (user.includes("push")) {
		if (!tool) return call("spawn_ticket", { title: "Push reading notes", request: "push the notes repo to GitHub", scope: "git push of ~/notes only." });
		return fauxAssistantMessage("On it.");
	}
	if (user.includes("[job")) {
		if (tool) return fauxAssistantMessage("OK");
		if (user.includes("price")) return call("notify", { text: "The Boox Note Air4 C dropped to $399 (was $499).", urgency: "normal", topic: "prices" });
	}
	return fauxAssistantMessage("OK");
}

export async function runDemo(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "vigil-demo-"));
	// A real repository and a local "remote", so the approved push in the story really happens.
	const remote = join(home, "remote.git");
	notesRepo = join(home, "work", "notes");
	const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" });
	git("init", "-q", "--bare", remote);
	git("init", "-q", "-b", "main", notesRepo);
	writeFileSync(join(notesRepo, "reading.md"), "# Reading notes\n\n- Attention budgets for agents\n");
	git("-C", notesRepo, "add", ".");
	git("-C", notesRepo, "-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-qm", "notes");
	git("-C", notesRepo, "remote", "add", "origin", remote);
	const clock = new ManualClock(Date.UTC(2026, 10, 5, 8, 55));
	const faux = registerFauxProvider({ provider: "demo", models: [{ id: "scripted" }] });
	faux.setResponses(Array.from({ length: 300 }, () => ((ctx: { messages: Msg[] }) => brain(ctx.messages)) as never));
	const rt = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	rt.registerProvider("demo", { baseUrl: "http://demo.invalid", apiKey: "x", api: faux.api, models: [{ id: "scripted", name: "scripted", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 2000 }] } as never);
	const cfg = defaultConfig();
	cfg.owner = { name: "Ayesha", timezone: TZ, identities: { telegram: ["1"] }, notify: ["telegram"] };
	cfg.models = { concierge: ["demo/*"], worker: ["demo/*"], triage: ["demo/*"], dream: ["demo/*"] };
	cfg.proactive = { mode: "auto", heartbeatMinutes: 0, dreamAt: null };
	cfg.sandbox = "off";
	const phone = new Phone(clock);
	const d = await Daemon.create({ paths: paths(home), cfg, channels: new Map([["telegram", phone]]), clock, modelRuntime: rt, timers: false, log: () => {} });
	await d.start();
	const settle = async () => {
		for (let i = 0; i < 80; i++) {
			await new Promise((r) => setTimeout(r, 25));
			await d.s.outbox.deliverDue();
			if (d.concierge.pending() === 0 && d.workers.activeCount() === 0 && i > 4) break;
		}
	};
	const until = async (h: number, m: number, day = 5) => {
		const target = Date.UTC(2026, 10, day, h, m);
		while (clock.t < target) {
			clock.t = Math.min(target, clock.t + 5 * MINUTE);
			await d.tickOnce();
		}
		await settle();
	};
	const narrate = (s: string) => console.log(`\n${dim(`— ${s}`)}`);

	console.log(bold("\nA day with vigil") + dim("  (scripted model, real daemon; quiet hours 22:30–08:00, 3 interruptions a day)\n"));
	narrate("You write in the morning. Quick things are done at once; research goes to a background worker.");
	await phone.type("morning! remind me to call the bank at 11, and find me the 3 best e-ink tablets for reading papers");
	await settle();
	await until(11, 1);
	narrate("A notice vigil starts on its own is high urgency: it interrupts, and it carries its own off switch.");
	d.s.notifier.notify({ urgency: "high", topic: "ci", text: "CI on main is red since 13:58: test_login times out." });
	clock.t = Date.UTC(2026, 10, 5, 14, 0);
	await settle();
	narrate("Risky actions wait for your approval.");
	await phone.type("push my reading notes to github");
	await settle();
	await phone.press("Approve");
	await settle();
	narrate("Night: a watcher finds a price drop. Normal urgency during quiet hours is held, not sent.");
	clock.t = Date.UTC(2026, 10, 5, 23, 40);
	d.concierge.enqueue({ kind: "system", tag: 'job "price check"', text: "The price of the Boox Note Air4 C dropped from $499 to $399." });
	await settle();
	console.log(`${time(clock.now())}  ${dim("(nothing sent: quiet hours)")}`);
	narrate("Morning: what was held goes out as one message when quiet hours end.");
	await until(8, 1, 6);
	const b = d.s.notifier.budget();
	console.log(dim(`\nInterruptions in the last 24 h: ${b.interruptsUsed} of ${b.interruptsMax}. Everything else waited, was batched, or was asked for.\n`));
	await d.stop();
	rmSync(home, { recursive: true, force: true });
}
