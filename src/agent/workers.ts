// The worker pool: one pi session per ticket, in the ticket's own directory. At most
// `workers.max` tickets run a turn at once, plus one slot kept for a ticket the owner just wrote
// to, so new background work never blocks the owner's conversation with existing work.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Ticket, TicketInput } from "../core/tickets.ts";
import { fill, WORKER_PROMPT } from "./prompts.ts";
import type { Services } from "./services.ts";
import { buildSession, promptWithFallback } from "./sessions.ts";
import { delegateTool } from "./delegate.ts";
import { workerTools } from "./tools.ts";
import { webTools } from "./web.ts";

const BUILTIN = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/**
 * Work vigil inferred from untrusted content (a watcher change) gets the web and its report tools,
 * and no file tools at all: untrusted input plus network access must not also have private data
 * (the rule of two), or an injected page could read a file and send it out. The owner can reply to
 * the ticket to continue it as explicit work.
 */
const READ_ONLY: string[] = [];

export class WorkerPool {
	private readonly s: Services;
	private readonly running = new Map<string, Promise<void>>();
	private readonly sessions = new Map<string, AgentSession>();
	/** When a ticket's worker last failed to start; it waits a minute before the next try. */
	private readonly failedStart = new Map<string, number>();
	private stopping = false;
	/** Consecutive turns cut by a timeout or a model error, per ticket. */
	private readonly cutTurns = new Map<string, number>();

	constructor(s: Services) {
		this.s = s;
	}

	activeCount(): number {
		return this.running.size;
	}

	/** Start every runnable ticket that fits in a slot. */
	pump(): void {
		if (this.s.paused() || this.stopping) return;
		const max = this.s.cfg.workers.max;
		for (const t of this.s.tickets.runnable()) {
			if (this.running.has(t.id)) continue;
			if ((this.failedStart.get(t.id) ?? 0) > this.s.clock.now() - 60_000) continue;
			const ownerWaiting = this.s.db.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM ticket_inputs WHERE ticket_id = ? AND status = 'pending' AND kind IN ('owner_message', 'answer')",
				t.id,
			);
			const limit = (ownerWaiting?.n ?? 0) > 0 ? max + 1 : max;
			if (this.running.size >= limit) continue;
			const run = this.run(t).then(
				(started) => started,
				(err: unknown) => {
					// During shutdown the run was aborted on purpose; its ticket is recovered on restart.
					if (this.stopping) return false;
					// Never strand a ticket in "working" without a word.
					this.s.db.event("worker.error", `${t.id}: ${(err as Error)?.stack ?? err}`);
					this.s.tickets.report(t.id, "failed", `The worker stopped on an internal error: ${(err as Error)?.message ?? err}`);
					this.failedStart.set(t.id, this.s.clock.now());
					return false;
				},
			).then((started) => {
				this.running.delete(t.id);
				if (this.stopping) return;
				this.dispose(t.id);
				// A ticket whose worker could not even start is retried by the 15 s timer, not right
				// away: an immediate re-pump loops on promise callbacks and starves the event loop
				// (verification/workers, finding W4).
				if (started) this.pump();
			});
			this.running.set(t.id, run);
		}
	}

	private async session(t: Ticket): Promise<AgentSession> {
		const cached = this.sessions.get(t.id);
		if (cached) return cached;
		const mandate = [
			`Request: ${t.mandate.request}`,
			`Scope: ${t.mandate.scope}`,
			`Strength: ${t.mandate.strength === "explicit" ? "the owner asked for this" : "vigil inferred this from a rule the owner wrote; stay conservative"}`,
			t.mandate.rule ? `Rule: ${t.mandate.rule}` : "",
			`Ticket: ${t.id} (${t.title})`,
		]
			.filter(Boolean)
			.join("\n");
		const route = () => (t.origin.channel === "system" ? undefined : { channel: t.origin.channel, conversation: t.origin.conversation });
		const { session } = await buildSession(this.s, {
			role: "worker",
			cwd: t.dir,
			persistence: { kind: "dir", dir: join(this.s.paths.sessions, "tickets", t.id), file: t.session_file },
			prompt: fill(WORKER_PROMPT, {
				owner: this.s.cfg.owner.name,
				dir: t.dir,
				mandate,
				now: "{{now}}",
				tz: "{{tz}}",
				memory: t.mandate.strength === "inferred" ? "(No memory: this work started from untrusted content.)" : "{{memory}}",
			}),
			builtinTools: t.mandate.strength === "inferred" ? READ_ONLY : BUILTIN,
			customTools:
				t.mandate.strength === "inferred"
					? [...workerTools(this.s, t.id, { inferred: true }), ...webTools(() => this.s.cfg.search)]
					: [...workerTools(this.s, t.id), ...webTools(() => this.s.cfg.search), delegateTool(this.s, t.id, t.dir, route)],
			requester: `ticket ${t.id} (${t.title})`,
			ticketId: t.id,
			skills: true,
			approvalRoute: route,
		});
		this.sessions.set(t.id, session);
		return session;
	}

	/** Run a ticket's turns. Resolves false when the worker could not start at all. */
	private async run(t0: Ticket): Promise<boolean> {
		const startedAt = this.s.clock.now();
		this.s.tickets.setStage(t0.id, "working");
		let session: AgentSession;
		try {
			session = await this.session(t0);
		} catch (err) {
			this.failedStart.set(t0.id, this.s.clock.now());
			this.s.tickets.report(t0.id, "failed", `Could not start a worker: ${(err as Error).message}`);
			return false;
		}
		this.failedStart.delete(t0.id);
		// The owner may have stopped the ticket while the session was being built (finding W1).
		const t = this.s.tickets.get(t0.id);
		if (!t || t.stopped_by_owner || t.status === "ended") return true;
		// Record the session file before the first prompt: a crash mid-turn must resume the session
		// that holds the owner's message, not start a new one without it (finding W3c).
		if (session.sessionFile) this.s.tickets.setSessionFile(t.id, session.sessionFile);
		// Loop while inputs keep arriving during turns.
		for (let turn = 0; turn < 20; turn++) {
			const inputs = this.s.tickets.takeInputs(t.id);
			const first = turn === 0 && !t.last_report && inputs.length === 0;
			if (!first && inputs.length === 0) break;
			const text = first ? "Start the work described in your mandate." : renderInputs(inputs);
			// A hung provider call must not hold a worker slot forever.
			let timedOut = false;
			const limit = (this.s.cfg.workers.turnTimeoutMinutes ?? 60) * 60_000;
			const timer = setTimeout(() => {
				timedOut = true;
				void session.abort();
			}, limit);
			timer.unref?.();
			const r = await promptWithFallback(this.s, session, "worker", text).finally(() => clearTimeout(timer));
			// Shutdown aborted this turn: leave the ticket "working" so recover() picks it up on restart.
			if (this.stopping) return true;
			const persisted = session.sessionFile !== undefined && existsSync(session.sessionFile);
			if (persisted) this.s.tickets.setSessionFile(t.id, session.sessionFile!);
			if (timedOut || r.error) {
				// A cut turn whose session never reached disk would lose these inputs with it: queue
				// them again so the next run sees them (finding W3), at most twice in a row and after a
				// minute's pause, so a persistent model error cannot become a retry storm.
				const fails = (this.cutTurns.get(t.id) ?? 0) + 1;
				this.cutTurns.set(t.id, fails);
				if (!persisted && fails <= 2) for (const i of inputs) this.s.tickets.addInput(t.id, i.kind, i.text);
				this.failedStart.set(t.id, this.s.clock.now());
				if (timedOut) {
					this.s.tickets.report(t.id, "failed", `A turn ran past ${Math.round(limit / 60_000)} minutes and was stopped. Reply to continue.`);
				} else {
					this.s.tickets.report(t.id, "failed", `The model failed: ${r.error!.slice(0, 300)}`);
					this.s.notifier.notify({ urgency: "normal", topic: `ticket:${t.id}`, text: `❌ ${t.title}: the model failed (${r.error!.slice(0, 120)}). Reply to retry.`, ticketId: t.id });
				}
				return false;
			}
			this.cutTurns.delete(t.id);
			if (this.s.paused()) break;
		}
		const now = this.s.tickets.get(t.id);
		if (!now) return true;
		const reported = now.last_report && now.last_report.at >= startedAt && now.last_report.kind !== "progress";
		if (now.status === "ended" && now.stage === "stopped") return true;
		if (!reported && now.stage === "working") {
			// A turn that ended without a final report waits for a trigger (dsh-superagent's rule).
			this.s.tickets.report(t.id, "waiting", "ended a turn without a final report");
		}
		// pump() disposes the session after every run: sessions are on disk, and the next input
		// resumes from the file, so many idle tickets cost nothing.
		return true;
	}

	/** After a restart: tickets that were mid-turn get a recovery note and run again. */
	recover(): number {
		let n = 0;
		for (const t of this.s.tickets.list("open")) {
			if (t.stage !== "working") continue;
			this.s.tickets.addInput(
				t.id,
				"recovery",
				"vigil restarted while you were working. Check your directory, git state and anything outside before repeating an outside action, then continue.",
			);
			this.s.tickets.setStage(t.id, "queued");
			n++;
		}
		return n;
	}

	private dispose(id: string): void {
		this.sessions.get(id)?.dispose();
		this.sessions.delete(id);
	}

	/** Abort every run and wait (briefly) for them to end, so none writes after the database closes. */
	async stopAll(): Promise<void> {
		this.stopping = true;
		for (const s of this.sessions.values()) await s.abort().catch(() => {});
		const runs = [...this.running.values()];
		await Promise.race([Promise.allSettled(runs), new Promise((r) => setTimeout(r, 10_000).unref?.())]);
		for (const s of this.sessions.values()) s.dispose();
		this.sessions.clear();
	}
}

function renderInputs(inputs: TicketInput[]): string {
	return inputs
		.map((i) => {
			const label = i.kind === "owner_message" ? "The owner says" : i.kind === "answer" ? "The owner answered your question" : i.kind === "recovery" ? "Recovery note" : "Note from vigil";
			return `${label}: ${i.text}`;
		})
		.join("\n\n");
}
