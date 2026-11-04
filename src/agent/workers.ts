// The worker pool: one pi session per ticket, in the ticket's own directory. At most
// `workers.max` tickets run a turn at once, plus one slot kept for a ticket the owner just wrote
// to, so new background work never blocks the owner's conversation with existing work.

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
 * Work vigil inferred from untrusted content (a watcher change) gets read-only tools: an injected
 * page must not be able to steer a worker into running commands or writing files. The owner can
 * reply to the ticket to continue with full tools as explicit work.
 */
const READ_ONLY = ["read", "grep", "find", "ls"];

export class WorkerPool {
	private readonly s: Services;
	private readonly running = new Map<string, Promise<void>>();
	private readonly sessions = new Map<string, AgentSession>();

	constructor(s: Services) {
		this.s = s;
	}

	activeCount(): number {
		return this.running.size;
	}

	/** Start every runnable ticket that fits in a slot. */
	pump(): void {
		if (this.s.paused()) return;
		const max = this.s.cfg.workers.max;
		for (const t of this.s.tickets.runnable()) {
			if (this.running.has(t.id)) continue;
			const ownerWaiting = this.s.db.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM ticket_inputs WHERE ticket_id = ? AND status = 'pending' AND kind IN ('owner_message', 'answer')",
				t.id,
			);
			const limit = (ownerWaiting?.n ?? 0) > 0 ? max + 1 : max;
			if (this.running.size >= limit) continue;
			const run = this.run(t).finally(() => {
				this.running.delete(t.id);
				this.dispose(t.id);
				this.pump();
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
		const { session } = await buildSession(this.s, {
			role: "worker",
			cwd: t.dir,
			persistence: { kind: "dir", dir: join(this.s.paths.sessions, "tickets", t.id), file: t.session_file },
			prompt: fill(WORKER_PROMPT, { owner: this.s.cfg.owner.name, dir: t.dir, mandate, now: "{{now}}", tz: "{{tz}}", memory: "{{memory}}" }),
			builtinTools: t.mandate.strength === "inferred" ? READ_ONLY : BUILTIN,
			customTools:
				t.mandate.strength === "inferred"
					? [...workerTools(this.s, t.id), ...webTools(() => this.s.cfg.search)]
					: [...workerTools(this.s, t.id), ...webTools(() => this.s.cfg.search), delegateTool(this.s, t.id, t.dir)],
			requester: `ticket ${t.id} (${t.title})`,
			skills: true,
		});
		this.sessions.set(t.id, session);
		return session;
	}

	private async run(t: Ticket): Promise<void> {
		const startedAt = this.s.clock.now();
		this.s.tickets.setStage(t.id, "working");
		let session: AgentSession;
		try {
			session = await this.session(t);
		} catch (err) {
			this.s.tickets.report(t.id, "failed", `Could not start a worker: ${(err as Error).message}`);
			return;
		}
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
			if (timedOut) {
				this.s.tickets.report(t.id, "failed", `A turn ran past ${Math.round(limit / 60_000)} minutes and was stopped. Reply to continue.`);
				return;
			}
			if (session.sessionFile) this.s.tickets.setSessionFile(t.id, session.sessionFile);
			if (r.error) {
				this.s.tickets.report(t.id, "failed", `The model failed: ${r.error.slice(0, 300)}`);
				this.s.notifier.notify({ urgency: "normal", topic: `ticket:${t.id}`, text: `❌ ${t.title}: the model failed (${r.error.slice(0, 120)}). Reply to retry.`, ticketId: t.id });
				return;
			}
			if (this.s.paused()) break;
		}
		const now = this.s.tickets.get(t.id);
		if (!now) return;
		const reported = now.last_report && now.last_report.at >= startedAt && now.last_report.kind !== "progress";
		if (now.status === "ended" && now.stage === "stopped") {
			this.dispose(t.id);
			return;
		}
		if (!reported && now.stage === "working") {
			// A turn that ended without a final report waits for a trigger (dsh-superagent's rule).
			this.s.tickets.report(t.id, "waiting", "ended a turn without a final report");
		}
		// Sessions are on disk; keep none in memory between runs, so many idle tickets cost nothing.
		// The next input resumes the session from its file.
		this.dispose(t.id);
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

	async stopAll(): Promise<void> {
		for (const s of this.sessions.values()) await s.abort().catch(() => {});
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
