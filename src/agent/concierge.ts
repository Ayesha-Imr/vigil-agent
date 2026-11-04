// The concierge: the one long-lived session that talks with the owner. Owner messages from every
// channel land in the same conversation; replies go back to the chat they came from. Inputs that
// are not from the owner (jobs, heartbeats, worker reports) are private: the concierge speaks
// about them only through tools.

import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChannelId } from "../config.ts";
import type { Origin } from "../core/tickets.ts";
import { localMinuteOfDay } from "../core/time.ts";
import { CONCIERGE_PROMPT, fill } from "./prompts.ts";
import { sendSolicited, type Services } from "./services.ts";
import { buildSession, promptWithFallback } from "./sessions.ts";
import { conciergeTools } from "./tools.ts";

export type ConciergeInput =
	| { kind: "owner"; channel: ChannelId; conversation: string; externalId: string; text: string; at: number }
	| { kind: "system"; tag: string; text: string; done?: (result: string) => void };

const SESSION_KEY = "concierge.session";
/** A reply that means "nothing to say". */
const SILENT = /^\s*(ok|no_reply|nothing to report\.?|heartbeat_ok)\s*$/i;

export class Concierge {
	private readonly s: Services;
	private session: AgentSession | undefined;
	private readonly queue: ConciergeInput[] = [];
	private current: ConciergeInput | undefined;
	private busy = false;
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
			customTools: conciergeTools(this.s, { currentOrigin: () => this.origin }),
			requester: "concierge",
			skills: true,
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
		this.queue.push(input);
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
		let last = first;
		while (this.queue[0]?.kind === "owner" && (this.queue[0] as typeof first).conversation === first.conversation) {
			last = this.queue.shift() as typeof first;
			parts.push(this.tag(last));
		}
		return { ...last, text: parts.join("\n") };
	}

	private async handle(input: ConciergeInput): Promise<void> {
		let session: AgentSession;
		try {
			session = await this.ensureSession();
		} catch (err) {
			const msg = (err as Error).message;
			this.s.db.event("concierge.error", msg);
			if (input.kind === "owner") this.reply(input, `I can't think right now: ${msg}`);
			if (input.kind === "system") input.done?.(`error: ${msg}`);
			return;
		}

		if (input.kind === "owner") {
			this.origin = { channel: input.channel, conversation: input.conversation, externalId: input.externalId };
			this.s.memory.journal("owner", input.text.replace(/^\[[^\]]+\]\s*/, ""));
			let text = input.kind === "owner" && input.text.startsWith("[") ? input.text : this.tag(input);
			const waiting = this.s.notifier.takeForReply();
			if (waiting.length) {
				text += `\n\n(While you were away, not yet told to the owner:\n${waiting.map((n) => `- [${n.effective}] ${n.text}`).join("\n")})`;
			}
			const r = await promptWithFallback(this.s, session, "concierge", text);
			const out = r.error && !r.text ? `Something went wrong on my side (${r.error.slice(0, 200)}). Try again in a bit.` : r.text;
			if (out && !SILENT.test(out)) this.reply(input, out);
			this.s.db.setKv(SESSION_KEY, session.sessionFile ?? null);
			return;
		}

		this.origin = { channel: "system", conversation: "" };
		const r = await promptWithFallback(this.s, session, "concierge", `[${input.tag}] ${input.text}`);
		this.s.db.setKv(SESSION_KEY, session.sessionFile ?? null);
		input.done?.(r.error ? `error: ${r.error}` : r.text.slice(0, 500));
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
