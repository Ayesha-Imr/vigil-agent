// The daemon: builds the services, starts the channels, routes every inbound message through the
// gate, and runs the loops (outbox, governor, scheduler, watchers, workers).

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Concierge } from "./agent/concierge.ts";
import { loadGatePolicy } from "./agent/gate.ts";
import { ModelRouter } from "./agent/models.ts";
import { DREAM_PROMPT, fill, HEARTBEAT_PROMPT } from "./agent/prompts.ts";
import { sendSolicited, type Services } from "./agent/services.ts";
import { buildSession, promptWithFallback } from "./agent/sessions.ts";
import { triage } from "./agent/triage.ts";
import { WorkerPool } from "./agent/workers.ts";
import type { Channel, InboundMessage } from "./channels/types.ts";
import { type ChannelId, governorPolicy, isOwner, type Paths, saveConfig, type VigilConfig } from "./config.ts";
import { Approvals } from "./core/approvals.ts";
import { Notifier, type OwnerRoute } from "./core/notifier.ts";
import { Outbox } from "./core/outbox.ts";
import { type JobRun, Scheduler } from "./core/scheduler.ts";
import { Tickets } from "./core/tickets.ts";
import { type Clock, DAY, HOUR, localDate, systemClock } from "./core/time.ts";
import { type Fetcher, Watchers } from "./core/watchers.ts";
import { Memory } from "./memory/memory.ts";
import { Db } from "./store/db.ts";

export interface DaemonOptions {
	paths: Paths;
	cfg: VigilConfig;
	channels: Map<ChannelId, Channel>;
	clock?: Clock;
	modelRuntime?: ModelRuntime;
	/** Where proactive messages go; defaults to the first configured notify channel with an owner chat. */
	ownerRoute?: () => OwnerRoute | undefined;
	fetcher?: Fetcher;
	/** Set false in tests to drive loops by hand with tickOnce(). */
	timers?: boolean;
	log?: (line: string) => void;
}

export const HEARTBEAT_JOB = "heartbeat";
export const DREAM_JOB = "dream";

/** vigil's shipped skills directory (formal verification and others). */
export function shippedSkillsDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const p of [join(here, "..", "skills"), join(here, "..", "..", "skills")]) if (existsSync(p)) return p;
	return join(here, "..", "skills");
}

export function defaultOwnerRoute(cfg: VigilConfig, channels: Map<ChannelId, Channel>): OwnerRoute | undefined {
	for (const id of cfg.owner.notify) {
		const ch = channels.get(id);
		const conversation = ch?.ownerConversation();
		if (ch && conversation) return { channel: id, conversation };
	}
	return undefined;
}

export class Daemon {
	readonly s: Services;
	readonly concierge: Concierge;
	readonly workers: WorkerPool;
	private readonly channels: Map<ChannelId, Channel>;
	private readonly timers: NodeJS.Timeout[] = [];
	private readonly useTimers: boolean;
	private readonly log: (line: string) => void;
	private stopped = false;

	private constructor(s: Services, channels: Map<ChannelId, Channel>, useTimers: boolean, log: (line: string) => void) {
		this.s = s;
		this.channels = channels;
		this.useTimers = useTimers;
		this.log = log;
		this.concierge = new Concierge(s);
		this.workers = new WorkerPool(s);
		s.wakeWorkers = () => this.workers.pump();
	}

	static async create(o: DaemonOptions): Promise<Daemon> {
		const clock = o.clock ?? systemClock;
		const db = new Db(o.paths.db);
		const modelRuntime =
			o.modelRuntime ??
			(await ModelRuntime.create({
				authPath: join(o.paths.agentDir, "auth.json"),
				modelsPath: join(o.paths.agentDir, "models.json"),
				allowModelNetwork: true,
			}));
		const cfg = o.cfg;
		const outbox = new Outbox(db, clock, o.channels);
		const route = o.ownerRoute ?? (() => defaultOwnerRoute(cfg, o.channels));
		const notifier = new Notifier({ db, clock, outbox, policy: () => governorPolicy(cfg), route });
		const memory = new Memory(o.paths.memory, () => cfg.owner.timezone);
		const writable = [o.paths.work, o.paths.memory, o.paths.skills, "/tmp"];
		let gate = loadGatePolicy(o.paths.policy, writable);
		const models = new ModelRouter(modelRuntime, () => cfg.models, clock);
		await models.refresh().catch(() => {});
		const s: Services = {
			cfg,
			paths: o.paths,
			db,
			clock,
			outbox,
			notifier,
			approvals: new Approvals(db, clock),
			scheduler: new Scheduler(db, clock, () => cfg.owner.timezone),
			watchers: new Watchers(db, clock, o.fetcher),
			memory,
			tickets: new Tickets(db, clock, o.paths.work),
			models,
			modelRuntime,
			gatePolicy: () => gate,
			ownerRoute: route,
			skillsDir: shippedSkillsDir(),
			paused: () => db.getKv<boolean>("paused") === true,
			wakeWorkers: () => {},
		};
		const d = new Daemon(s, o.channels, o.timers ?? true, o.log ?? ((l) => console.log(l)));
		d.reloadPolicy = () => {
			gate = loadGatePolicy(o.paths.policy, writable);
		};
		return d;
	}

	reloadPolicy: () => void = () => {};

	async start(): Promise<void> {
		const s = this.s;
		s.scheduler.recover();
		const recovered = this.workers.recover();
		if (recovered) this.log(`recovered ${recovered} ticket(s) that were mid-turn`);
		this.ensureSystemJobs();
		for (const [id, ch] of this.channels) {
			try {
				await ch.start((m) => this.onInbound(m));
				this.log(`channel ${id}: started`);
			} catch (err) {
				this.log(`channel ${id}: failed to start: ${(err as Error).message}`);
				this.channels.delete(id);
			}
		}
		await this.reprocessStuckTriggers();
		if (this.useTimers) {
			const every = (ms: number, fn: () => unknown) => {
				const t = setInterval(() => {
					Promise.resolve()
						.then(fn)
						.catch((err) => this.log(`loop error: ${(err as Error).stack ?? err}`));
				}, ms);
				t.unref?.();
				this.timers.push(t);
			};
			every(3_000, () => s.outbox.deliverDue());
			every(30_000, () => this.tickGovernorAndClock());
			every(60_000, () => this.checkWatchers());
			every(15_000, () => this.workers.pump());
			every(10 * 60_000, () => s.models.refresh());
		}
		this.workers.pump();
		s.db.event("daemon.started", "vigil started");
		this.log("vigil is running");
	}

	/** Run every loop once. For tests and `vigil tick`. */
	async tickOnce(): Promise<void> {
		await this.tickGovernorAndClock();
		await this.checkWatchers();
		this.workers.pump();
		await this.s.outbox.deliverDue();
	}

	private async tickGovernorAndClock(): Promise<void> {
		const s = this.s;
		s.approvals.expire();
		s.notifier.tick();
		if (s.paused()) return;
		for (const run of s.scheduler.claimDue()) void this.runJob(run);
		await s.outbox.deliverDue();
	}

	private async checkWatchers(): Promise<void> {
		if (this.s.paused() || this.s.cfg.proactive.mode === "off") return;
		for (const change of await this.s.watchers.checkDue()) await triage(this.s, change);
	}

	private ensureSystemJobs(): void {
		const p = this.s.cfg.proactive;
		if (p.heartbeatMinutes > 0) {
			this.s.scheduler.ensure({ name: HEARTBEAT_JOB, kind: "every", spec: String(p.heartbeatMinutes), prompt: "built in", action: "agent" });
		}
		if (p.dreamAt) {
			const [h, m] = p.dreamAt.split(":").map(Number);
			this.s.scheduler.ensure({ name: DREAM_JOB, kind: "cron", spec: `${m} ${h} * * *`, prompt: "built in", action: "agent" });
		}
	}

	async runJob(run: JobRun): Promise<void> {
		const s = this.s;
		const { job } = run;
		const finish = (status: string) => {
			s.scheduler.complete(job.id, status);
			s.db.run("UPDATE triggers SET status = 'done', note = ?, processed_at = ? WHERE id = ?", status.slice(0, 500), s.clock.now(), run.triggerId);
		};
		try {
			if (job.created_by === "system" && job.name === HEARTBEAT_JOB) return finish(await this.heartbeat());
			if (job.created_by === "system" && job.name === DREAM_JOB) return finish(await this.dream());
			switch (job.action) {
				case "remind": {
					// The owner chose this time, so it goes out as asked, quiet hours or not.
					const route = s.ownerRoute();
					if (route) s.outbox.enqueue({ ...route, text: `⏰ ${job.prompt}`, ref: { kind: "notice", id: job.id } });
					return finish("reminded");
				}
				case "ticket": {
					const t = s.tickets.create({
						title: job.name,
						mandate: { request: job.prompt, scope: "The scheduled task as written by the owner.", strength: "explicit", rule: `job ${job.id}` },
						origin: { channel: "system", conversation: "" },
					});
					this.workers.pump();
					return finish(`ticket ${t.id}`);
				}
				case "agent": {
					const late = run.coalesced ? ` (${run.coalesced} earlier run(s) were missed while vigil was down and are folded into this one)` : "";
					this.concierge.enqueue({
						kind: "system",
						tag: `job "${job.name}"`,
						text: `${job.prompt}${late}\nThis runs because the owner scheduled it. Tell the owner only what they would want to hear now (notify), or nothing.`,
						done: finish,
					});
					return;
				}
			}
		} catch (err) {
			finish(`error: ${(err as Error).message}`);
		}
	}

	/** Heartbeat with a cheap gate: no checklist and no stuck work means no model call. */
	private async heartbeat(): Promise<string> {
		const s = this.s;
		const checklist = s.memory
			.heartbeat()
			.split("\n")
			.filter((l) => /^\s*[-*\d]/.test(l))
			.join("\n");
		const open = s.tickets.list("open");
		const stuck = open.filter((t) => s.clock.now() - t.updated_at > 6 * HOUR);
		if (!checklist.trim() && !stuck.length) return "skipped: nothing to look at";
		return await new Promise<string>((resolve) => {
			this.concierge.enqueue({
				kind: "system",
				tag: "heartbeat",
				text: fill(HEARTBEAT_PROMPT, {
					now: new Date(s.clock.now()).toISOString(),
					owner: s.cfg.owner.name,
					checklist: checklist || "(empty)",
					tickets: open.map((t) => `${t.id} [${t.stage}] ${t.title}, updated ${Math.round((s.clock.now() - t.updated_at) / HOUR)} h ago`).join("\n") || "(none)",
					waiting: String(s.notifier.waiting().length),
				}),
				done: resolve,
			});
		});
	}

	/** Nightly memory consolidation in a throwaway session, then a git commit of the memory dir. */
	private async dream(): Promise<string> {
		const s = this.s;
		const tz = s.cfg.owner.timezone;
		const today = localDate(s.clock.now(), tz);
		const yesterday = localDate(s.clock.now() - DAY, tz);
		const journals = `${s.memory.journalFor(yesterday)}\n${s.memory.journalFor(today)}`.trim();
		if (!journals) return "skipped: empty journal";
		const before = readFileSync(s.memory.memoryPath, "utf8");
		const { session } = await buildSession(s, {
			role: "dream",
			cwd: s.paths.memory,
			persistence: { kind: "memory" },
			prompt: fill(DREAM_PROMPT, { owner: s.cfg.owner.name, path: s.memory.memoryPath, memory: before, journals: journals.slice(-30_000) }),
			builtinTools: ["read", "write"],
			customTools: [],
			requester: "dream",
			skills: false,
		});
		const r = await promptWithFallback(s, session, "dream", "Consolidate now.");
		session.dispose();
		await gitCommit(s.paths.memory, `dream ${today}`);
		return r.error ? `error: ${r.error}` : r.text.slice(0, 200);
	}

	/** Every inbound message: store, gate, route. */
	async onInbound(msg: InboundMessage): Promise<void> {
		const s = this.s;
		const ins = s.db.run(
			`INSERT INTO triggers (source, external_id, kind, strength, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(source, external_id) DO NOTHING`,
			msg.channel,
			msg.externalId,
			msg.kind,
			"explicit",
			JSON.stringify(msg),
			s.clock.now(),
		);
		if (ins.changes !== 1) return; // Already seen: a redelivery after a reconnect.
		await this.route(msg, ins.lastInsertRowid);
	}

	private async route(msg: InboundMessage, triggerId: number): Promise<void> {
		const s = this.s;
		const done = (status: string, note: string) =>
			s.db.run("UPDATE triggers SET status = ?, note = ?, processed_at = ? WHERE id = ?", status, note.slice(0, 300), s.clock.now(), triggerId);
		if (!isOwner(s.cfg, msg.channel, msg.senderId)) {
			s.db.event("gate.dropped", `${msg.channel} message from non-owner ${msg.senderId} (${msg.senderName ?? "?"})`);
			done("dropped", "not the owner");
			return;
		}
		const to: OwnerRoute = { channel: msg.channel, conversation: msg.conversation };
		const say = (text: string) => {
			// The HTTP API answers synchronously by matching replyTo to the request's id.
			s.outbox.enqueue({ ...to, text, ref: { kind: "reply", id: msg.externalId }, replyTo: msg.channel === "http" ? msg.externalId : undefined });
			void s.outbox.deliverDue();
		};

		if (msg.kind === "button") {
			done("done", this.handleButton(msg.data ?? "", say));
			return;
		}
		if (msg.kind === "reaction") {
			done("done", this.handleReaction(msg));
			return;
		}

		const text = msg.text.trim();
		if (text.startsWith("/")) {
			const handled = await this.handleCommand(text, to, say);
			if (handled) {
				done("done", `command ${text.split(/\s+/)[0]}`);
				return;
			}
		}

		// A reply to something vigil sent goes to what that message was about.
		const ref = msg.replyTo ? s.outbox.lookupRef(msg.channel, msg.replyTo) : undefined;
		if (ref?.kind === "attention") {
			const at = s.db.get<{ ticket_id: string; question: string }>("SELECT ticket_id, question FROM attentions WHERE id = ?", ref.id);
			if (at) {
				s.db.run("UPDATE attentions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?", text, s.clock.now(), ref.id);
				s.tickets.addInput(at.ticket_id, "answer", `Q: ${at.question}\nA: ${text}`);
				this.workers.pump();
				done("done", `answer to ${ref.id}`);
				return;
			}
		}
		if (ref?.kind === "ticket") {
			const ok = s.tickets.addInput(ref.id, "owner_message", text);
			if (ok) {
				this.workers.pump();
				done("done", `follow-up to ${ref.id}`);
				return;
			}
		}
		const context = ref?.kind === "notice" || ref?.kind === "digest" ? this.refText(msg) : "";
		this.concierge.enqueue({ kind: "owner", channel: msg.channel, conversation: msg.conversation, externalId: msg.externalId, text: context + text, at: msg.at });
		done("done", "to concierge");
	}

	private refText(msg: InboundMessage): string {
		const row = this.s.db.get<{ text: string }>("SELECT text FROM outbox WHERE channel = ? AND external_id = ?", msg.channel, msg.replyTo ?? "");
		return row ? `(replying to your message: "${row.text.slice(0, 300)}") ` : "";
	}

	private handleButton(data: string, say: (t: string) => void): string {
		const s = this.s;
		const [kind, id, extra] = data.split(":");
		if (kind === "approve" || kind === "deny") {
			const r = s.approvals.decide(id, kind === "approve");
			if (!r.changed) say(r.approval ? `That request is already ${r.approval.status}.` : "Unknown request.");
			else say(kind === "approve" ? "👍 Approved." : "Denied.");
			return `${kind} ${id}: ${r.changed ? "applied" : "ignored"}`;
		}
		if (kind === "answer") {
			const at = s.db.get<{ ticket_id: string; question: string; choices: string; status: string }>("SELECT * FROM attentions WHERE id = ?", id);
			if (!at) return "unknown attention";
			const choice = (JSON.parse(at.choices) as string[])[Number(extra)] ?? extra;
			if (at.status !== "open") {
				say("Already answered.");
				return "attention already answered";
			}
			s.db.run("UPDATE attentions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?", choice, s.clock.now(), id);
			s.tickets.addInput(at.ticket_id, "answer", `Q: ${at.question}\nA: ${choice}`);
			this.workers.pump();
			say(`→ ${choice}`);
			return `answered ${id}`;
		}
		return `unknown button ${data}`;
	}

	private handleReaction(msg: InboundMessage): string {
		const s = this.s;
		const ref = msg.replyTo ? s.outbox.lookupRef(msg.channel, msg.replyTo) : undefined;
		if (!ref || ref.kind !== "notice") return "reaction ignored";
		const emoji = msg.data ?? "";
		if (/👎|😒|🙄|💩/.test(emoji)) {
			const topic = s.notifier.dislike(ref.id);
			return topic ? `disliked ${topic}` : "dislike: unknown notice";
		}
		if (/🔕|🔇|🤫|🙊/.test(emoji)) {
			const topic = s.notifier.topicOf(ref.id);
			if (topic) s.notifier.mute(topic, DAY);
			return topic ? `muted ${topic} for a day` : "mute: unknown notice";
		}
		return "reaction recorded";
	}

	/** Slash commands work without a model, so they work when providers do not. */
	private async handleCommand(text: string, to: OwnerRoute, say: (t: string) => void): Promise<boolean> {
		const s = this.s;
		const [cmd, ...args] = text.split(/\s+/);
		switch (cmd.toLowerCase()) {
			case "/help":
			case "/start":
				say(HELP);
				return true;
			case "/status":
				say(this.statusText());
				return true;
			case "/pause":
				s.db.setKv("paused", true);
				say("Paused. I keep listening and recording, but start nothing and send nothing new. /resume to continue.");
				return true;
			case "/resume":
				s.db.setKv("paused", false);
				this.workers.pump();
				say("Resumed.");
				return true;
			case "/mode": {
				const m = args[0];
				if (m !== "off" && m !== "observe" && m !== "auto") {
					say(`Proactive mode is ${s.cfg.proactive.mode}. Use /mode off|observe|auto.`);
					return true;
				}
				s.cfg.proactive.mode = m;
				saveConfig(s.cfg, s.paths);
				say(`Proactive mode: ${m}.`);
				return true;
			}
			case "/mute": {
				if (!args[0]) {
					const mutes = Object.entries(s.notifier.mutes());
					say(mutes.length ? mutes.map(([t, u]) => `${t} until ${new Date(u).toLocaleString("en-GB", { timeZone: s.cfg.owner.timezone })}`).join("\n") : "Nothing muted. /mute <topic> [hours]");
					return true;
				}
				const hours = Number(args[1] ?? 24);
				s.notifier.mute(args[0], (Number.isFinite(hours) ? hours : 24) * HOUR);
				say(`Muted ${args[0]} for ${hours} h.`);
				return true;
			}
			case "/unmute":
				if (args[0]) s.notifier.unmute(args[0]);
				say(args[0] ? `Unmuted ${args[0]}.` : "/unmute <topic>");
				return true;
			case "/digest": {
				const w = s.notifier.takeForReply();
				say(w.length ? w.map((n) => `- ${n.text}`).join("\n") : "Nothing waiting.");
				return true;
			}
			case "/tickets": {
				const list = s.tickets.list("open");
				say(list.length ? list.map((t) => `${t.id} [${t.stage}] ${t.title}`).join("\n") : "No open tickets.");
				return true;
			}
			case "/stop":
				if (!args[0]) {
					say("/stop <ticket id>");
					return true;
				}
				say(s.tickets.stop(args[0]) ? `Stopped ${args[0]}.` : `No open ticket ${args[0]}.`);
				return true;
			case "/new":
				await this.concierge.reset();
				say("Started a fresh conversation. Memory is kept.");
				return true;
			case "/login":
				void this.login(args[0] ?? "", args.slice(1).join(" "), to, say);
				return true;
			default:
				return false;
		}
	}

	/** Log in to a provider from chat. Codex uses a device code; OpenCode Go takes an API key. */
	async login(provider: string, secret: string, _to: OwnerRoute, say: (t: string) => void): Promise<void> {
		const s = this.s;
		const id = provider === "codex" || provider === "openai-codex" ? "openai-codex" : provider === "opencode" || provider === "opencode-go" ? "opencode-go" : "";
		if (!id) {
			say("Use /login codex (ChatGPT subscription, device code) or /login opencode <api key>.");
			return;
		}
		try {
			if (id === "opencode-go") {
				if (!secret) {
					say("Send /login opencode <your OpenCode Go API key>. Delete that message afterwards.");
					return;
				}
				await s.modelRuntime.login(id, "api_key", { prompt: async () => secret, notify: () => {} });
			} else {
				await s.modelRuntime.login(id, "oauth", {
					prompt: async (p) => {
						if (p.type === "select") return p.options.find((o) => o.id.includes("device"))?.id ?? p.options[0].id;
						throw new Error(`login needs input vigil cannot give from chat: ${p.message}`);
					},
					notify: (e) => {
						if (e.type === "device_code") say(`Open ${e.verificationUri} and enter the code: ${e.userCode}`);
						else if (e.type === "auth_url") say(`Open: ${e.url}${e.instructions ? `\n${e.instructions}` : ""}`);
						else if (e.type === "info") say(e.message);
					},
				});
			}
			await s.models.refresh();
			say(`Logged in to ${id}. Models: ${s.models.candidates("concierge").slice(0, 3).map((m) => m.id).join(", ") || "none found"}.`);
		} catch (err) {
			say(`Login failed: ${(err as Error).message}`);
		}
	}

	statusText(): string {
		const s = this.s;
		const b = s.notifier.budget();
		const open = s.tickets.list("open");
		const approvals = s.approvals.pending();
		const problems = s.outbox.problems();
		const lines = [
			`vigil ${s.paused() ? "PAUSED" : "running"} · mode ${s.cfg.proactive.mode} · ${b.quietNow ? "quiet hours" : "awake"}`,
			`interrupts ${b.interruptsUsed}/${b.interruptsMax} today · critical ${b.criticalsUsed}/${b.criticalsMax} · ${b.waiting} waiting for digest`,
			`tickets: ${open.length} open (${this.workers.activeCount()} running)`,
			...open.slice(0, 8).map((t) => `  ${t.id} [${t.stage}] ${t.title}`),
		];
		if (approvals.length) lines.push(`approvals waiting: ${approvals.map((a) => `${a.id} ${a.tool}`).join(", ")}`);
		if (problems.length) lines.push(`messages failing: ${problems.length}`);
		const cooling = s.models.coolingDown();
		if (cooling.length) lines.push(`models cooling down: ${cooling.map((c) => c.model).join(", ")}`);
		const model = s.models.pick("concierge");
		lines.push(`model: ${model ? `${model.provider}/${model.id}` : "none — /login codex or /login opencode <key>"}`);
		return lines.join("\n");
	}

	/** Triggers stored but not processed before a crash are routed again. */
	private async reprocessStuckTriggers(): Promise<void> {
		const rows = this.s.db.all<{ id: number; payload: string }>(
			"SELECT id, payload FROM triggers WHERE status = 'received' AND source NOT IN ('clock', 'watch') AND created_at > ? ORDER BY id",
			this.s.clock.now() - DAY,
		);
		for (const r of rows) await this.route(JSON.parse(r.payload) as InboundMessage, r.id);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const t of this.timers) clearInterval(t);
		for (const ch of this.channels.values()) await ch.stop().catch(() => {});
		await this.workers.stopAll();
		this.concierge.dispose();
		this.s.db.close();
	}
}

const HELP = `vigil commands
/status — what is going on
/tickets — open background work · /stop <id>
/digest — what is waiting for the digest
/mute <topic> [hours] · /unmute <topic>
/mode off|observe|auto — proactive work
/pause · /resume — stop and restart everything new
/new — fresh conversation (memory is kept)
/login codex · /login opencode <key>
Anything else is a message to vigil. Reply to one of its messages to talk about that thing. React 👎 to a notice to hear less of that topic, 🔕 to mute it for a day.`;

function gitCommit(dir: string, message: string): Promise<void> {
	const git = (args: string[]) =>
		new Promise<void>((resolve) => {
			execFile("git", ["-C", dir, ...args], { timeout: 30_000 }, () => resolve());
		});
	return (async () => {
		if (!existsSync(join(dir, ".git"))) await git(["init", "-q"]);
		await git(["add", "-A"]);
		await git(["-c", "user.name=vigil", "-c", "user.email=vigil@localhost", "commit", "-qm", message]);
	})();
}

export const _forTests = { sendSolicited };
