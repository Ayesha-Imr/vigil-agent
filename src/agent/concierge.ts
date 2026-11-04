// The concierge: the one long-lived session that talks with the owner. Owner messages from every
// channel land in the same conversation; replies go back to the chat they came from. Inputs that
// are not from the owner (jobs, heartbeats, worker reports) are private: the concierge speaks
// about them only through tools.

import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Attachment } from "../channels/types.ts";
import type { ChannelId } from "../config.ts";
import type { Origin } from "../core/tickets.ts";
import { localMinuteOfDay } from "../core/time.ts";
import { CONCIERGE_PROMPT, fill } from "./prompts.ts";
import { sendSolicited, type Services, takeConciergeNotes } from "./services.ts";
import { buildSession, promptWithFallback } from "./sessions.ts";
import { conciergeTools } from "./tools.ts";
import { webTools } from "./web.ts";

export type ConciergeInput =
	| { kind: "owner"; channel: ChannelId; conversation: string; externalId: string; text: string; at: number; triggerIds?: number[]; attachments?: Attachment[] }
	| { kind: "system"; tag: string; text: string; done?: (result: string) => void; retried?: boolean };

const SESSION_KEY = "concierge.session";
/** A reply that means "nothing to say". */
const SILENT = /^\s*(ok|no_reply|nothing to report\.?|heartbeat_ok)\s*$/i;

export class Concierge {
	private readonly s: Services;
	private session: AgentSession | undefined;
	private readonly queue: ConciergeInput[] = [];
	private current: ConciergeInput | undefined;
	private busy = false;
	private preempted: ConciergeInput | undefined;
	private origin: Origin = { channel: "system", conversation: "" };

	constructor(s: Services) {
		this.s = s;
	}

	private async ensureSession(): Promise<AgentSession> {
		if (this.session) return this.session;
		const file = this.s.db.getKv<string>(SESSION_KEY);
		const { session } = await buildSession(this.s, {
			role: "concierge",
			cwd: this.s.paths.home,
			persistence: { kind: "dir", dir: join(this.s.paths.sessions, "concierge"), file },
			prompt: fill(CONCIERGE_PROMPT, { owner: this.s.cfg.owner.name, now: "{{now}}", tz: "{{tz}}", mode: "{{mode}}", memory: "{{memory}}" }),
			builtinTools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
			customTools: [...conciergeTools(this.s, { currentOrigin: () => this.origin }), ...webTools(() => this.s.cfg.search)],
			requester: "concierge",
			skills: true,
			approvalRoute: () => (this.origin.channel === "system" ? undefined : { channel: this.origin.channel, conversation: this.origin.conversation }),
		});
		this.session = session;
		return session;
	}

	/** Queue an input. A follow-up from the owner while they are being answered steers that answer. */
	enqueue(input: ConciergeInput): void {
		const cur = this.current;
		if (input.kind === "owner" && cur?.kind === "owner" && cur.conversation === input.conversation && this.session?.isStreaming) {
			void this.session.steer(this.tag(input));
			return;
		}
		if (input.kind === "owner") {
			// The owner goes first: ahead of queued system work, and a system run in progress yields
			// (it is aborted and runs again afterwards) so a heartbeat never keeps the owner waiting.
			const at = this.queue.findIndex((q) => q.kind === "system");
			if (at === -1) this.queue.push(input);
			else this.queue.splice(at, 0, input);
			if (cur?.kind === "system" && this.session?.isStreaming) {
				this.preempted = cur;
				void this.session.abort();
			}
		} else {
			this.queue.push(input);
		}
		void this.pump();
	}

	/** After /resume: handle what queued up while paused. */
	resume(): void {
		void this.pump();
	}

	pending(): number {
		return this.queue.length + (this.busy ? 1 : 0);
	}

	private tag(input: Extract<ConciergeInput, { kind: "owner" }>): string {
		const m = localMinuteOfDay(input.at, this.s.cfg.owner.timezone);
		const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
		return `[${input.channel} ${hhmm}] ${input.text}`;
	}

	private async pump(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			while (this.queue.length && !this.s.paused()) {
				const input = this.takeBatch();
				this.current = input;
				await this.handle(input);
				this.current = undefined;
			}
		} finally {
			this.busy = false;
			this.current = undefined;
		}
	}

	/** Merge consecutive owner messages from one chat into a single turn. */
	private takeBatch(): ConciergeInput {
		const first = this.queue.shift()!;
		if (first.kind !== "owner") return first;
		const parts = [this.tag(first)];
		const triggerIds = [...(first.triggerIds ?? [])];
		const attachments = [...(first.attachments ?? [])];
		let last = first;
		while (this.queue[0]?.kind === "owner" && (this.queue[0] as typeof first).conversation === first.conversation) {
			last = this.queue.shift() as typeof first;
			parts.push(this.tag(last));
			triggerIds.push(...(last.triggerIds ?? []));
			attachments.push(...(last.attachments ?? []));
		}
		return { ...last, text: parts.join("\n"), triggerIds, attachments };
	}

	private async handle(input: ConciergeInput): Promise<void> {
		let session: AgentSession;
		try {
			session = await this.ensureSession();
		} catch (err) {
			const msg = (err as Error).message;
			this.s.db.event("concierge.error", msg);
			if (input.kind === "owner") {
				this.reply(input, `I can't think right now: ${msg}`);
				this.markDone(input.triggerIds);
			}
			if (input.kind === "system") input.done?.(`error: ${msg}`);
			return;
		}

		// What happened elsewhere since the last turn, so the conversation knows about it.
		const notes = takeConciergeNotes(this.s);
		const since = notes.length ? `(Since your last turn, for context; already handled: ${notes.map((n) => `\n- ${n}`).join("")})\n\n` : "";

		if (input.kind === "owner") {
			this.origin = { channel: input.channel, conversation: input.conversation, externalId: input.externalId };
			this.s.memory.journal("owner", input.text.replace(/^\[[^\]]+\]\s*/, ""));
			let text = since + (input.text.startsWith("[") ? input.text : this.tag(input));
			// Peek only: the notices count as told once a reply mentioning them is stored (below).
			const waiting = this.s.notifier.waiting();
			if (waiting.length) {
				text += `\n\n(While you were away, not yet told to the owner:\n${waiting.map((n) => `- [${n.effective}] ${n.text}`).join("\n")})`;
			}
			const typing = this.typing(input.channel, input.conversation);
			const files = await this.s.fetchAttachments(input.channel, input.attachments ?? [], session.model?.input?.includes("image") ?? false);
			if (files.notes.length) text += `\n${files.notes.join("\n")}`;
			const r = await promptWithFallback(this.s, session, "concierge", text, files.images).finally(() => clearInterval(typing));
			const out = r.error && !r.text ? `Something went wrong on my side (${r.error.slice(0, 200)}). Try again in a bit.` : r.text;
			if (out && !SILENT.test(out)) {
				this.reply(input, out);
				if (!r.error) this.s.notifier.confirmDelivered(waiting.map((n) => n.id));
			}
			this.s.db.setKv(SESSION_KEY, session.sessionFile ?? null);
			this.markDone(input.triggerIds);
			return;
		}

		this.origin = { channel: "system", conversation: "" };
		const r = await promptWithFallback(this.s, session, "concierge", `${since}[${input.tag}] ${input.text}`);
		this.s.db.setKv(SESSION_KEY, session.sessionFile ?? null);
		if (this.preempted === input) {
			// The owner interrupted this run; it goes again after their message, once.
			this.preempted = undefined;
			if (!input.retried) this.queue.push({ ...input, retried: true, text: `${input.text}\n(This run was interrupted by a message from the owner; start it again.)` });
			else input.done?.("interrupted twice; skipped");
			return;
		}
		input.done?.(r.error ? `error: ${r.error}` : r.text.slice(0, 500));
	}

	/** Show "typing…" in the owner's chat while a reply is being made. */
	private typing(channel: ChannelId, conversation: string): NodeJS.Timeout {
		const tick = () => void this.s.typing(channel, conversation);
		tick();
		const t = setInterval(tick, 4_000);
		t.unref?.();
		return t;
	}

	/** An owner message counts as handled only once it was answered; until then a restart replays it. */
	private markDone(ids: number[] | undefined): void {
		for (const id of ids ?? []) {
			this.s.db.run("UPDATE triggers SET status = 'done', processed_at = ? WHERE id = ?", this.s.clock.now(), id);
		}
	}

	private reply(input: Extract<ConciergeInput, { kind: "owner" }>, text: string): void {
		sendSolicited(this.s, { channel: input.channel, conversation: input.conversation }, text, { kind: "reply", id: input.externalId }, { urgent: true, replyTo: input.channel === "http" ? input.externalId : undefined });
		this.s.outbox.deliverDue().catch(() => {});
	}

	/** Start a fresh conversation (the old one stays on disk). */
	async reset(): Promise<void> {
		this.session?.dispose();
		this.session = undefined;
		this.s.db.setKv(SESSION_KEY, null);
	}

	dispose(): void {
		this.session?.dispose();
	}
}
