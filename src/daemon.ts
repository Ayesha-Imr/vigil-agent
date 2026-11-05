// The daemon: builds the services, starts the channels, routes every inbound message through the
// gate, and runs the loops (outbox, governor, scheduler, watchers, workers).

import { execFile, execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Concierge } from "./agent/concierge.ts";
import { loadGatePolicy } from "./agent/gate.ts";
import { ModelRouter } from "./agent/models.ts";
import { DREAM_PROMPT, fill, HEARTBEAT_PROMPT } from "./agent/prompts.ts";
import type { Services } from "./agent/services.ts";
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
const PAIR_TTL_MS = 15 * 60_000;
const PAIR_MAX_FAILURES = 10;
export const DREAM_JOB = "dream";
export const REVIEW_JOB = "weekly review";

/** vigil's shipped skills directory (formal verification and others). */
export function shippedSkillsDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const p of [join(here, "..", "skills"), join(here, "..", "..", "skills")]) if (existsSync(p)) return p;
	return join(here, "..", "skills");
}

/**
 * Whether the process that holds the lock is still a running vigil. A live process that looks like
 * vigil (or node) is never taken over, even with a stale heartbeat: a suspended machine makes the
 * heartbeat look old while the holder is fine (finding F2b). A dead pid, or a pid reused by some
 * other program, is taken over.
 */
export function lockHolderAlive(lock: { pid: number; at: number }): boolean {
	try {
		process.kill(lock.pid, 0);
	} catch {
		return false;
	}
	try {
		const cmd = readFileSync(`/proc/${lock.pid}/cmdline`, "utf8");
		return /node|vigil|bun/.test(cmd);
	} catch {
		// No /proc (macOS): ask ps what the pid runs. A suspended machine leaves the heartbeat old
		// while the holder is alive, so the heartbeat alone is not evidence (outbox finding F2d).
		try {
			const comm = execFileSync("ps", ["-p", String(lock.pid), "-o", "comm="], { encoding: "utf8", timeout: 5_000 });
			return /node|vigil|bun/.test(comm);
		} catch {
			return Date.now() - lock.at < 2 * 60_000;
		}
	}
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
		const memory = new Memory(o.paths.memory, () => cfg.owner.timezone, () => clock.now());
		const writable = [o.paths.work, o.paths.memory, o.paths.skills, "/tmp"];
		let gate = loadGatePolicy(o.paths.policy, writable, o.paths.home);
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
			fetchAttachments: async (channel, attachments, acceptsImages) => {
				const ch = o.channels.get(channel);
				const images: { type: "image"; data: string; mimeType: string }[] = [];
				const notes: string[] = [];
				if (!attachments.length) return { images, notes };
				const dir = join(o.paths.home, "inbox", localDate(clock.now(), cfg.owner.timezone));
				mkdirSync(dir, { recursive: true });
				for (const [i, a] of attachments.entries()) {
					if (!ch?.download) {
						notes.push(`[${a.kind} attached, but this channel cannot download it]`);
						continue;
					}
					try {
						const file = await ch.download(a);
						const ext = a.name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? (file.mimeType.includes("jpeg") ? ".jpg" : file.mimeType.includes("png") ? ".png" : file.mimeType.includes("ogg") ? ".ogg" : ".bin");
						const base = (a.name ?? `${a.kind}-${clock.now()}-${i}`).replace(/[^\w.-]+/g, "_").replace(/\.[A-Za-z0-9]{1,8}$/, "");
						const path = join(dir, `${base}${ext}`);
						writeFileSync(path, file.data);
						const isImage = file.mimeType.startsWith("image/");
						if (isImage && acceptsImages && file.data.length < 8_000_000) images.push({ type: "image", data: file.data.toString("base64"), mimeType: file.mimeType });
						notes.push(`[${a.kind} saved at ${path}${isImage && acceptsImages ? ", and shown to you above" : ""}]`);
					} catch (err) {
						notes.push(`[${a.kind} attached, download failed: ${(err as Error).message}]`);
					}
				}
				return { images, notes };
			},
			typing: async (channel, conversation) => {
				await o.channels.get(channel)?.typing?.(conversation).catch(() => {});
			},
		};
		const d = new Daemon(s, o.channels, o.timers ?? true, o.log ?? ((l) => console.log(l)));
		d.reloadPolicy = () => {
			gate = loadGatePolicy(o.paths.policy, writable, o.paths.home);
		};
		return d;
	}

	reloadPolicy: () => void = () => {};

	/**
	 * One daemon per database: two would each think they own the outbox and the running jobs, and send
	 * twice (verification/outbox, finding TwoDaemonsDoubleSend). A lock row with the owner's pid and
	 * a heartbeat; a lock whose process is gone, or whose heartbeat is stale, is taken over.
	 */
	private takeLock(): void {
		const s = this.s;
		// One immediate transaction: two daemons starting at once are serialized by SQLite, and the
		// second sees the first's lock (verification/outbox, finding F2c).
		s.db.tx(() => {
			const lock = s.db.getKv<{ pid: number; at: number }>("daemon.lock");
			if (lock && lock.pid !== process.pid && lockHolderAlive(lock)) {
				throw new Error(`vigil is already running on this home (pid ${lock.pid}). Stop it first, or talk to it through the HTTP API.`);
			}
			s.db.setKv("daemon.lock", { pid: process.pid, at: Date.now() });
		});
	}

	/** Whether this process still holds the lock; the outbox sends only while it does. */
	holdsLock(): boolean {
		return this.s.db.getKv<{ pid: number }>("daemon.lock")?.pid === process.pid;
	}

	/** Heartbeat the lock; a daemon that lost it (another took over) stops instead of sending twice. */
	private heartbeatLock(): void {
		if (!this.holdsLock()) {
			this.log("another vigil took over this home; this one stops (finding F2b)");
			void this.stop();
			return;
		}
		this.s.db.setKv("daemon.lock", { pid: process.pid, at: Date.now() });
	}

	async start(): Promise<void> {
		const s = this.s;
		this.takeLock();
		s.outbox.mayDeliver = () => this.holdsLock();
		s.scheduler.recover();
		// Runs claimed before a crash but never done run now (verification/scheduler, finding S3).
		const unfinished = s.scheduler.unfinishedRuns(DAY);
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
		this.offerPairing();
		await this.reprocessStuckTriggers();
		for (const run of unfinished) void this.runJob(run);
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
			every(30_000, () => this.heartbeatLock());
			every(30_000, () => this.tickGovernorAndClock());
			every(60_000, () => this.checkWatchers());
			every(15_000, () => this.workers.pump());
			every(10 * 60_000, () => s.models.refresh());
			every(5 * 60_000, () => this.checkModelHealth());
			if (s.cfg.healthcheckUrl) {
				const ping = () => fetch(s.cfg.healthcheckUrl!, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
				void ping();
				every(5 * 60_000, ping);
			}
		}
		this.workers.pump();
		s.db.event("daemon.started", "vigil started");
		this.log("vigil is running");
	}

	/** Tell the owner, once a day at most, when no model has answered for half an hour. */
	checkModelHealth(): void {
		const m = this.s.models;
		const down = this.s.clock.now() - m.lastSuccessAt;
		if (m.failuresSinceSuccess < 3 || down < 30 * 60_000) return;
		const cooling = m.coolingDown().map((c) => c.model).join(", ");
		this.s.notifier.notify({
			urgency: "high",
			topic: "vigil:models",
			dedupKey: `models-down:${localDate(this.s.clock.now(), this.s.cfg.owner.timezone)}`,
			text: `I can't reach any model (${m.failuresSinceSuccess} failures in ${Math.round(down / 60_000)} min${cooling ? `; cooling down: ${cooling}` : ""}). Check /status, or /login codex if the login expired.`,
		});
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
		this.s.scheduler.ensure({ name: REVIEW_JOB, kind: "cron", spec: "0 18 * * 0", prompt: "built in", action: "agent" });
		const off = (name: string) => {
			const job = this.s.scheduler.list().find((j) => j.created_by === "system" && j.name === name);
			if (job?.enabled) this.s.scheduler.setEnabled(job.id, false);
		};
		if (p.heartbeatMinutes > 0) {
			this.s.scheduler.ensure({ name: HEARTBEAT_JOB, kind: "every", spec: String(p.heartbeatMinutes), prompt: "built in", action: "agent" });
		} else off(HEARTBEAT_JOB);
		if (p.dreamAt) {
			const [h, m] = p.dreamAt.split(":").map(Number);
			this.s.scheduler.ensure({ name: DREAM_JOB, kind: "cron", spec: `${m} ${h} * * *`, prompt: "built in", action: "agent" });
		} else off(DREAM_JOB);
	}

	async runJob(run: JobRun): Promise<void> {
		const s = this.s;
		const { job } = run;
		const finish = (status: string) => {
			s.scheduler.complete(job.id, status, run.claimedAt);
			s.db.run("UPDATE triggers SET status = 'done', note = ?, processed_at = ? WHERE id = ?", status.slice(0, 500), s.clock.now(), run.triggerId);
		};
		try {
			if (job.created_by === "system" && job.name === HEARTBEAT_JOB) return finish(await this.heartbeat());
			if (job.created_by === "system" && job.name === DREAM_JOB) return finish(await this.dream());
			if (job.created_by === "system" && job.name === REVIEW_JOB) return finish(this.weeklyReview());
			switch (job.action) {
				case "remind": {
					// The owner chose this time, so it goes out as asked, quiet hours or not. Keyed by
					// slot, so a run replayed after a crash does not remind twice.
					const ref = `${job.id}:${run.slot}`;
					const already = s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE ref_kind = 'notice' AND ref_id = ?", ref)?.n ?? 0;
					const route = s.ownerRoute();
					if (!already && route) s.outbox.enqueue({ ...route, text: `⏰ ${job.prompt}`, ref: { kind: "notice", id: ref } });
					else if (!already) {
						// No channel right now: keep it where the panel, /digest and the next reply show it.
						s.notifier.notify({ urgency: "high", topic: "reminder", text: `⏰ ${job.prompt}`, dedupKey: ref });
						return finish("no channel: kept for the digest");
					}
					return finish("reminded");
				}
				case "ticket": {
					const rule = `job ${job.id} slot ${run.slot}`;
					const existing = s.tickets.list("all").find((t) => t.mandate.rule === rule);
					if (existing) return finish(`ticket ${existing.id} (already opened for this slot)`);
					const t = s.tickets.create({
						title: job.name,
						mandate: {
							request: job.prompt,
							scope: job.created_by === "owner" ? "The scheduled task as written by the owner." : "A task vigil scheduled itself; investigate and report only.",
							strength: job.created_by === "owner" ? "explicit" : "inferred",
							rule,
						},
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

	/**
	 * The weekly attention review, without a model: what vigil sent, what the owner disliked, and
	 * what observe mode would have done. It waits for the digest like any low notice.
	 */
	weeklyReview(): string {
		const s = this.s;
		const since = s.clock.now() - 7 * DAY;
		const count = (sql: string, ...args: (string | number)[]) => s.db.get<{ n: number }>(sql, ...args)?.n ?? 0;
		const interrupts = count("SELECT COUNT(*) AS n FROM notices WHERE decision = 'deliver' AND created_at > ?", since);
		const digested = count("SELECT COUNT(*) AS n FROM notices WHERE status = 'digested' AND created_at > ?", since);
		const dropped = count("SELECT COUNT(*) AS n FROM notices WHERE status = 'dropped' AND created_at > ?", since);
		const dislikes = s.db.all<{ text: string }>("SELECT text FROM events WHERE kind = 'feedback' AND at > ?", since);
		const observed = s.db.all<{ text: string }>("SELECT text FROM events WHERE kind = 'observe' AND at > ? ORDER BY id DESC", since);
		const done = count("SELECT COUNT(*) AS n FROM tickets WHERE ended_at > ? AND stage = 'done'", since);
		if (!interrupts && !digested && !observed.length && !done) return "skipped: quiet week";
		const lines = [`Week in review: ${done} task(s) done, ${interrupts} interruption(s), ${digested} item(s) in digests, ${dropped} dropped as repeats or muted.`];
		if (dislikes.length) lines.push(`You disliked ${dislikes.length} notice(s); those topics are quieter for a week.`);
		if (observed.length && s.cfg.proactive.mode === "observe") {
			lines.push(`Observe mode would have acted ${observed.length} time(s), e.g. ${observed.slice(0, 2).map((o) => o.text.replace(/^would /, "")).join("; ")}. If that looks right: /mode auto`);
		}
		s.notifier.notify({ urgency: "low", topic: "vigil:review", text: lines.join(" "), dedupKey: `review:${localDate(s.clock.now(), s.cfg.owner.timezone)}` });
		return "review queued";
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
		// A repeated request becomes one low-urgency offer to automate it, waiting for the digest.
		const suggestion = /^SUGGEST:\s*(.+)$/m.exec(r.text)?.[1]?.trim();
		if (suggestion) s.notifier.notify({ urgency: "low", topic: "vigil:suggestion", text: `💡 ${suggestion}`, dedupKey: `suggest:${today}` });
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
		if (msg.kind === "message" && this.tryPair(msg)) {
			done("done", "paired");
			return;
		}
		if (!isOwner(s.cfg, msg.channel, msg.senderId)) {
			// One log line per stranger per hour: a flood must not fill the database.
			const key = `${msg.channel}:${msg.senderId}`;
			if ((this.droppedAt.get(key) ?? 0) < s.clock.now() - 3_600_000) {
				this.droppedAt.set(key, s.clock.now());
				s.db.event("gate.dropped", `${msg.channel} message from non-owner ${msg.senderId} (${msg.senderName ?? "?"})`);
			}
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
			const [kind] = (msg.data ?? "").split(":");
			if (msg.channel === "http" && (kind === "approve" || kind === "deny" || kind === "answer") && !s.cfg.channels.http?.allowApprovals) {
				// Any process on this machine that finds the HTTP token could press this button, including
				// the agent's own tools. Approvals come from a chat app where the owner's identity is
				// checked, unless the owner opted in (for example with tools sandboxed away from the token).
				s.db.event("gate.http-approval-refused", `refused ${kind} over HTTP; approve from a chat app or set channels.http.allowApprovals`);
				done("dropped", "approvals over HTTP are off");
				say("Approvals over the HTTP API are off. Use the buttons in Telegram/Discord, or set channels.http.allowApprovals.");
				return;
			}
			done("done", this.handleButton(msg.data ?? "", say));
			return;
		}
		if (msg.kind === "reaction") {
			done("done", this.handleReaction(msg));
			return;
		}

		const text = msg.text.trim();
		if (/^\/login\b/i.test(text)) {
			// The stored copy of the message must not keep an API key.
			s.db.run("UPDATE triggers SET payload = ? WHERE id = ?", JSON.stringify({ ...msg, text: "/login [redacted]" }), triggerId);
		}
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
			const at = s.db.get<{ ticket_id: string; question: string; status: string }>("SELECT ticket_id, question, status FROM attentions WHERE id = ?", ref.id);
			if (at && at.status !== "open") {
				// Already answered: treat this as a follow-up to the ticket, keeping the first answer.
				if (s.tickets.addInput(at.ticket_id, "owner_message", text)) {
					this.workers.pump();
					done("done", `follow-up to ${at.ticket_id}`);
					return;
				}
			} else if (at) {
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
		if (s.paused()) {
			say("I'm paused, so I've noted this but won't act on it. /resume to continue.");
		}
		const context = ref?.kind === "notice" || ref?.kind === "digest" ? this.refText(msg) : "";
		// Stays 'processing' until the concierge has answered, so a crash in between replays it.
		done("processing", "to concierge");
		this.concierge.enqueue({ kind: "owner", channel: msg.channel, conversation: msg.conversation, externalId: msg.externalId, text: context + text, at: msg.at, triggerIds: [triggerId], attachments: msg.attachments });
	}

	/**
	 * Pairing: a channel with no owner yet prints a one-time code to the server log at startup; the
	 * first person who sends `/pair <code>` to the bot becomes its owner. Only someone who can read
	 * the server's log can pair, so a stranger who finds the bot cannot.
	 */
	private tryPair(msg: InboundMessage): boolean {
		const s = this.s;
		const m = /^\/pair\s+([A-Za-z2-7]{10})\s*$/.exec(msg.text.trim());
		if (!m) return false;
		const offer = s.db.getKv<{ code: string; until: number }>(`pair:${msg.channel}`);
		if (!offer || (s.cfg.owner.identities[msg.channel]?.length ?? 0) > 0) return false;
		if (s.clock.now() > offer.until) {
			s.db.setKv(`pair:${msg.channel}`, null);
			s.db.event("pair.expired", `pairing code for ${msg.channel} expired; restart vigil for a new one`);
			return true;
		}
		const fails = this.pairFailures.get(msg.channel) ?? 0;
		if (fails >= PAIR_MAX_FAILURES) return true; // locked until restart; strangers get no reply
		if (m[1].toUpperCase() !== offer.code) {
			this.pairFailures.set(msg.channel, fails + 1);
			s.db.event("pair.failed", `wrong pairing code on ${msg.channel} from ${msg.senderId}`);
			if (fails + 1 >= PAIR_MAX_FAILURES) {
				s.db.setKv(`pair:${msg.channel}`, null);
				this.log(`${msg.channel}: ${PAIR_MAX_FAILURES} wrong pairing codes; pairing is off until vigil restarts`);
				s.notifier.notify({ urgency: "high", topic: "vigil:pairing", text: `Someone sent ${PAIR_MAX_FAILURES} wrong pairing codes to the ${msg.channel} bot. Pairing there is off until vigil restarts.` });
			}
			return true;
		}
		s.cfg.owner.identities[msg.channel] = [msg.senderId];
		saveConfig(s.cfg, s.paths);
		s.db.setKv(`pair:${msg.channel}`, null);
		this.channels.get(msg.channel)?.setOwner?.(msg.senderId);
		s.db.event("pair", `paired ${msg.channel} owner ${msg.senderId} (${msg.senderName ?? "?"})`);
		// Tell the owner's other channels: a pairing they did not make is the first sign of trouble.
		s.notifier.notify({ urgency: "high", topic: "vigil:pairing", text: `New owner identity paired on ${msg.channel}: ${msg.senderName ?? msg.senderId}. If this was not you, stop vigil and remove it from config.json.` });
		s.outbox.enqueue({ channel: msg.channel, conversation: msg.conversation, text: `Paired. You're vigil's owner on ${msg.channel}. Say hi, or /help.`, ref: { kind: "reply", id: msg.externalId } });
		void s.outbox.deliverDue();
		return true;
	}

	private readonly pairFailures = new Map<ChannelId, number>();
	private readonly droppedAt = new Map<string, number>();

	/**
	 * Print a pairing code for every chat channel that has no owner yet: 10 random base32
	 * characters, valid for 15 minutes from now.
	 */
	private offerPairing(): void {
		for (const id of this.channels.keys()) {
			if (id === "http" || id === "cli" || id === "ntfy") continue;
			if ((this.s.cfg.owner.identities[id]?.length ?? 0) > 0) continue;
			const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
			const code = Array.from({ length: 10 }, () => alphabet[randomInt(0, 32)]).join("");
			this.s.db.setKv(`pair:${id}`, { code, until: this.s.clock.now() + PAIR_TTL_MS });
			this.log(`${id} has no owner yet. Within 15 minutes, send this to the bot from your own account:  /pair ${code}`);
		}
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
		if (kind === "mute" || kind === "less") {
			const topic = s.notifier.topicOf(id);
			if (!topic) {
				say("That notice is too old to act on.");
				return `${kind}: unknown notice`;
			}
			if (kind === "mute") {
				s.notifier.mute(topic, DAY);
				say(`Muted "${topic}" for a day. /unmute ${topic} to undo.`);
			} else {
				s.notifier.dislike(id);
				say(`Got it: fewer "${topic}" notices this week.`);
			}
			return `${kind} ${topic}`;
		}
		return `unknown button ${data}`;
	}

	private handleReaction(msg: InboundMessage): string {
		const s = this.s;
		const ref = msg.replyTo ? s.outbox.lookupRef(msg.channel, msg.replyTo) : undefined;
		if (!ref || ref.kind !== "notice") return "reaction ignored";
		const emoji = msg.data ?? "";
		if (/👎|😒|🙄|💩|🤮/.test(emoji)) {
			const topic = s.notifier.dislike(ref.id);
			return topic ? `disliked ${topic}` : "dislike: unknown notice";
		}
		// Telegram allows only a fixed set of reactions (no 🔕), so 😴 is the main one; others for other apps.
		if (/😴|🥱|🙈|🙉|🙊|🔕|🔇|🤫/.test(emoji)) {
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
				this.concierge.resume();
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
			case "/approve":
			case "/deny": {
				// Typed approvals for apps without buttons (WhatsApp, Signal): the id must be named.
				if (!args[0]?.startsWith("ap_")) {
					say(`${cmd} <approval id>, as shown in the request.`);
					return true;
				}
				this.handleButton(`${cmd.slice(1).toLowerCase()}:${args[0]}`, say);
				return true;
			}
			case "/why": {
				// The governor's recent decisions, in words: why something was or was not sent.
				const tz = s.cfg.owner.timezone;
				const said: Record<string, string> = {
					deliver: "sent now",
					hold: "held: quiet hours",
					digest: "saved for the digest",
					"drop:duplicate": "dropped: you already had this news",
					"drop:muted": "dropped: topic muted",
				};
				const rows = s.db.all<{ created_at: number; effective: string; topic: string; text: string; decision: string; status: string }>(
					"SELECT created_at, effective, topic, text, decision, status FROM notices ORDER BY created_at DESC LIMIT 8",
				);
				const b = s.notifier.budget();
				const lines = rows.map((r) => {
					const hhmm = new Date(r.created_at).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
					const later = r.decision !== "deliver" && r.status === "digested" ? " (then sent in a digest)" : r.status === "expired" ? " (then expired)" : "";
					return `${hhmm} ${said[r.decision] ?? r.decision}${later} [${r.effective}/${r.topic}] ${r.text.slice(0, 70)}`;
				});
				say([`Budget: ${b.interruptsUsed}/${b.interruptsMax} interruptions used in the last 24 h${b.quietNow ? "; quiet hours now" : ""}.`, ...lines].join("\n") || "Nothing decided yet.");
				return true;
			}
			case "/memory": {
				const text = s.memory.core().replace(/^# Memory[\s\S]*?(?=## )/, "").trim();
				say(text.length > 3500 ? `${text.slice(0, 3500)}\n…` : text || "Nothing remembered yet.");
				return true;
			}
			case "/jobs": {
				const tz = s.cfg.owner.timezone;
				const lines = s.scheduler.list().map((j) => `${j.enabled ? "" : "(off) "}${j.name}: ${j.kind} ${j.spec}${j.next_run_at ? `, next ${new Date(j.next_run_at).toLocaleString("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}${j.created_by === "system" ? " [built in]" : ` (${j.id})`}`);
				say(lines.join("\n") || "No jobs.");
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
		const usage = s.db.getKv<{ day: string; roles: Record<string, number> }>("usage");
		if (usage && usage.day === localDate(s.clock.now(), s.cfg.owner.timezone)) {
			const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
			lines.push(`tokens today: ${Object.entries(usage.roles).map(([r, n]) => `${r} ${k(n)}`).join(" · ")}`);
		}
		return lines.join("\n");
	}

	/** Triggers stored but not processed before a crash are routed again. */
	private async reprocessStuckTriggers(): Promise<void> {
		const rows = this.s.db.all<{ id: number; payload: string }>(
			"SELECT id, payload FROM triggers WHERE status IN ('received', 'processing') AND source NOT IN ('clock', 'watch') AND created_at > ? ORDER BY id",
			this.s.clock.now() - DAY,
		);
		for (const r of rows) {
			const msg = JSON.parse(r.payload) as InboundMessage;
			// Answered before the crash, but not yet marked: do not answer twice.
			const answered = this.s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE ref_kind = 'reply' AND ref_id = ?", msg.externalId);
			if ((answered?.n ?? 0) > 0) {
				this.s.db.run("UPDATE triggers SET status = 'done', note = 'answered before restart' WHERE id = ?", r.id);
				continue;
			}
			await this.route(msg, r.id);
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const t of this.timers) clearInterval(t);
		for (const ch of this.channels.values()) await ch.stop().catch(() => {});
		// Release anything that waits (approvals, the concierge's turn) before the database closes.
		this.s.approvals.dispose();
		this.concierge.dispose();
		await this.workers.stopAll();
		if (this.s.db.getKv<{ pid: number }>("daemon.lock")?.pid === process.pid) this.s.db.setKv("daemon.lock", null);
		this.s.db.close();
	}
}

const HELP = `vigil commands
/status — what is going on
/tickets — open background work · /stop <id>
/jobs — what is scheduled · /memory — what vigil remembers
/why — why recent things were or weren't sent
/digest — what is waiting for the digest
/mute <topic> [hours] · /unmute <topic>
/mode off|observe|auto — proactive work
/pause · /resume — stop and restart everything new
/new — fresh conversation (memory is kept)
/login codex · /login opencode <key>
Anything else is a message to vigil. Reply to one of its messages to talk about that thing. React 👎 to a notice to hear less of that topic, 😴 to mute it for a day.`;

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

