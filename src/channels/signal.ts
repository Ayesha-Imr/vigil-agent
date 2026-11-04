// Signal channel via a signal-cli daemon's JSON-RPC HTTP API:
//
//   signal-cli -a +15551234567 daemon --http 127.0.0.1:8080
//
// signal-cli (https://github.com/AsamK/signal-cli) must be installed, linked as a secondary device
// (`signal-cli link -n vigil`, then scan the QR code in Signal > Settings > Linked devices) and kept
// running separately; vigil does not manage it. It is an unofficial client, but it speaks the real
// Signal protocol, end to end encrypted. Messages arrive over the daemon's Server-Sent Events
// stream (GET /api/v1/events, signal-cli 0.13 or newer); sends are JSON-RPC calls (POST /api/v1/rpc).
//
// Signal has no buttons for bots, so buttons are rendered as a numbered list and a bare digit from
// the owner shortly afterwards counts as pressing that button (as on WhatsApp).

import { randomUUID } from "node:crypto";
import type { ChannelId } from "../config.ts";
import { type Attachment, type Channel, type InboundMessage, type OutboundMessage, PermanentSendError, type SendResult } from "./types.ts";
import { ButtonMemory, errorText, flattenButtons, type Log, renderWithButtons, stderrLog } from "./util.ts";

const ID: ChannelId = "signal";
const RPC_TIMEOUT_MS = 30_000;
const FIRST_CONNECT_WAIT_MS = 10_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const SENT_LIMIT = 500;

export interface SignalOptions {
	/** The signal-cli daemon's HTTP address, e.g. http://127.0.0.1:8080. */
	url: string;
	/** The number signal-cli runs as, e.g. +15551234567. */
	account: string;
	/** Owner phone numbers (or Signal UUIDs). The first one is the notify target. */
	ownerNumbers?: string[];
	log?: Log;
}

/** The parts of a signal-cli envelope vigil reads. */
export interface SignalEnvelope {
	source?: string | null;
	sourceNumber?: string | null;
	sourceUuid?: string | null;
	sourceName?: string | null;
	timestamp?: number;
	dataMessage?: SignalDataMessage | null;
}

export interface SignalDataMessage {
	timestamp?: number;
	message?: string | null;
	quote?: { id?: number; author?: string | null; authorNumber?: string | null } | null;
	reaction?: { emoji?: string; targetAuthor?: string | null; targetAuthorNumber?: string | null; targetSentTimestamp?: number; isRemove?: boolean } | null;
	attachments?: { id?: string; contentType?: string | null; filename?: string | null; size?: number }[] | null;
	sticker?: unknown;
	groupInfo?: unknown;
	groupV2?: unknown;
}

/** One Server-Sent Event. */
export interface SseEvent {
	event: string;
	data: string;
	id?: string;
}

/** An incremental Server-Sent Events parser: feed it text chunks, get complete events back. */
export class SseParser {
	private buffer = "";
	private event = "";
	private data: string[] = [];
	private id: string | undefined;

	push(chunk: string): SseEvent[] {
		this.buffer += chunk;
		const out: SseEvent[] = [];
		for (;;) {
			const m = /\r\n|\r|\n/.exec(this.buffer);
			if (!m) break;
			// A lone \r at the end may be the first half of \r\n; wait for more.
			if (m[0] === "\r" && m.index === this.buffer.length - 1) break;
			const line = this.buffer.slice(0, m.index);
			this.buffer = this.buffer.slice(m.index + m[0].length);
			const ev = this.line(line);
			if (ev) out.push(ev);
		}
		return out;
	}

	private line(line: string): SseEvent | undefined {
		if (line === "") {
			if (this.data.length === 0) {
				this.event = "";
				return undefined;
			}
			const ev: SseEvent = { event: this.event || "message", data: this.data.join("\n"), id: this.id };
			this.event = "";
			this.data = [];
			return ev;
		}
		if (line.startsWith(":")) return undefined; // a comment, e.g. a keep-alive
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") this.data.push(value);
		else if (field === "event") this.event = value;
		else if (field === "id") this.id = value;
		return undefined;
	}
}

/**
 * The envelope in an event's data. signal-cli sends the `receive` notification's params
 * (`{envelope, account}`); a whole JSON-RPC notification is accepted too.
 */
export function parseSignalEvent(data: string): { envelope: SignalEnvelope; account?: string } | undefined {
	let obj: unknown;
	try {
		obj = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (typeof obj !== "object" || obj === null) return undefined;
	const payload = ((obj as { params?: unknown }).params ?? obj) as { envelope?: unknown; account?: unknown };
	if (typeof payload.envelope !== "object" || payload.envelope === null) return undefined;
	return { envelope: payload.envelope as SignalEnvelope, account: typeof payload.account === "string" ? payload.account : undefined };
}

/**
 * Map a direct message to an InboundMessage, or undefined for group messages, receipts, typing
 * notices, sync messages, removed reactions and empties. Button digits are matched by the channel.
 */
export function fromSignalEnvelope(env: SignalEnvelope): InboundMessage | undefined {
	const sender = signalSender(env);
	const dm = env.dataMessage;
	if (!sender || !dm || dm.groupInfo || dm.groupV2) return undefined;
	const timestamp = dm.timestamp ?? env.timestamp;
	if (!timestamp) return undefined;
	const base = {
		channel: ID,
		externalId: `${sender}:${timestamp}`,
		senderId: sender,
		senderName: env.sourceName || undefined,
		conversation: sender,
		at: timestamp,
	};

	const reaction = dm.reaction;
	if (reaction) {
		if (reaction.isRemove || !reaction.emoji || !reaction.targetSentTimestamp) return undefined;
		return { ...base, kind: "reaction", text: reaction.emoji, data: reaction.emoji, replyTo: `${sender}:${reaction.targetSentTimestamp}` };
	}

	const parts: string[] = [];
	if (dm.message) parts.push(dm.message);
	const attachments: Attachment[] = [];
	for (const a of dm.attachments ?? []) {
		const mimeType = a.contentType ?? undefined;
		const kind: Attachment["kind"] = mimeType?.startsWith("image/") ? "photo" : mimeType?.startsWith("audio/") ? "voice" : mimeType?.startsWith("video/") ? "video" : "document";
		parts.push(kind === "photo" ? "[photo attached]" : kind === "voice" ? "[voice message attached]" : kind === "video" ? "[video attached]" : `[document attached: ${a.filename ?? "file"}]`);
		if (a.id) attachments.push({ kind, ref: `${sender}:${a.id}`, name: a.filename ?? undefined, mimeType });
	}
	if (dm.sticker) parts.push("[sticker]");
	if (parts.length === 0) return undefined;
	return {
		...base,
		kind: "message",
		text: parts.join("\n"),
		replyTo: dm.quote?.id ? `${sender}:${dm.quote.id}` : undefined,
		attachments: attachments.length ? attachments : undefined,
	};
}

/** Who sent an envelope: the phone number when Signal shares it, else the account UUID. */
export function signalSender(env: SignalEnvelope): string | undefined {
	const id = env.sourceNumber || env.source || env.sourceUuid;
	return id ? normalizeSignalId(id) : undefined;
}

/** `+92 300 1234567` or `923001234567` → `+923001234567`; UUIDs are lowercased. */
export function normalizeSignalId(id: string): string {
	const trimmed = id.trim();
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return trimmed.toLowerCase();
	if (/^\+?[\d\s().-]+$/.test(trimmed)) {
		const digits = trimmed.replace(/\D/g, "");
		return digits ? `+${digits}` : trimmed;
	}
	return trimmed;
}

/** Whether `id` is something signal-cli can send to: an E.164 number or a UUID. */
function isRecipient(id: string): boolean {
	return /^\+\d{6,15}$/.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

/** Parse an external id `conversation:timestamp`. */
export function parseSignalRef(ref: string): { conversation: string; timestamp: number } | undefined {
	const at = ref.lastIndexOf(":");
	if (at <= 0) return undefined;
	const timestamp = Number(ref.slice(at + 1));
	return Number.isInteger(timestamp) && timestamp > 0 ? { conversation: ref.slice(0, at), timestamp } : undefined;
}

/** A JSON-RPC error from signal-cli. */
export class SignalRpcError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

/** One recipient's outcome in a `send` result. */
export interface SignalSendResultEntry {
	type?: string;
	recipientAddress?: { number?: string | null; uuid?: string | null };
}

/** Throw the right error when no recipient of a `send` got the message. */
export function checkSendResults(results: SignalSendResultEntry[] | undefined): void {
	if (!results?.length || results.some((r) => r.type === "SUCCESS")) return;
	const types = results.map((r) => r.type ?? "UNKNOWN");
	if (types.includes("UNREGISTERED_FAILURE")) throw new PermanentSendError("signal: the recipient is not registered on Signal");
	if (types.every((t) => t === "IDENTITY_FAILURE")) {
		throw new PermanentSendError("signal: the recipient's safety number changed; trust it with signal-cli trust before vigil can send");
	}
	throw new Error(`signal: send failed: ${types.join(", ")}`);
}

/** JSON-RPC codes for requests signal-cli will never accept as sent (bad JSON, method or params). */
const PERMANENT_RPC_CODES = new Set([-32700, -32600, -32601, -32602]);

/**
 * PermanentSendError for failures retrying cannot fix (unregistered or invalid recipient, bad
 * request, untrusted identity); a plain Error for rate limits, 5xx, a stopped daemon and network.
 */
export function classifySignalError(err: unknown): Error {
	if (err instanceof PermanentSendError) return err;
	const msg = errorText(err);
	if (/rate ?limit|proof required|captcha/i.test(msg)) return new Error(`signal: rate limited: ${msg}`);
	if (err instanceof SignalRpcError) {
		if (PERMANENT_RPC_CODES.has(err.code)) return new PermanentSendError(`signal ${err.code}: ${msg}`);
		if (/unregistered|not registered|invalid (phone )?number|untrusted identity/i.test(msg)) return new PermanentSendError(`signal ${err.code}: ${msg}`);
		return new Error(`signal ${err.code}: ${msg}`);
	}
	const status = (err as { status?: unknown } | undefined)?.status;
	if (typeof status === "number") {
		if (status === 408 || status === 429 || status >= 500) return new Error(`signal HTTP ${status}: ${msg}`);
		if (status >= 400) return new PermanentSendError(`signal HTTP ${status}: ${msg}`);
	}
	return err instanceof Error ? err : new Error(msg);
}

/** Signal via a signal-cli JSON-RPC HTTP daemon. Conversations are phone numbers (or UUIDs). */
export class SignalChannel implements Channel {
	readonly id = ID;
	private readonly base: string;
	private readonly account: string;
	private owners: string[];
	private readonly log: Log;
	private readonly buttons = new ButtonMemory();
	/** External ids of messages vigil sent, so a quote of one names vigil's number as author. */
	private readonly sent = new Set<string>();
	private onInbound: ((msg: InboundMessage) => Promise<void>) | undefined;
	private stopped = false;
	private abort: AbortController | undefined;
	private loop: Promise<void> | undefined;
	private wake: (() => void) | undefined;

	constructor(opts: SignalOptions) {
		this.base = opts.url.replace(/\/+$/, "");
		this.account = normalizeSignalId(opts.account);
		this.owners = (opts.ownerNumbers ?? []).map(normalizeSignalId);
		this.log = opts.log ?? stderrLog;
	}

	/**
	 * Open the event stream. Resolves once it is connected, or after the first failed attempt
	 * (logged), so a signal-cli daemon that starts later is picked up by the reconnect loop.
	 */
	async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
		this.onInbound = onInbound;
		this.stopped = false;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, FIRST_CONNECT_WAIT_MS);
			this.loop = this.receive(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private async receive(firstAttempt: () => void): Promise<void> {
		let backoff = MIN_BACKOFF_MS;
		let first = true;
		while (!this.stopped) {
			const abort = new AbortController();
			this.abort = abort;
			try {
				const res = await fetch(`${this.base}/api/v1/events`, { headers: { accept: "text/event-stream" }, signal: abort.signal });
				if (res.status === 404) throw new Error("HTTP 404: no /api/v1/events here; needs signal-cli 0.13 or newer running `daemon --http`");
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				this.log(`signal: connected to ${this.base} as ${this.account}`);
				backoff = MIN_BACKOFF_MS;
				if (first) firstAttempt();
				first = false;
				const parser = new SseParser();
				const decoder = new TextDecoder();
				for await (const chunk of res.body) {
					for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) this.onEvent(ev);
				}
				if (!this.stopped) throw new Error("event stream ended");
			} catch (err) {
				if (this.stopped) break;
				this.log(`signal: event stream: ${errorText(err)}; reconnecting in ${backoff / 1000} s`);
				if (first) firstAttempt();
				first = false;
				await this.sleep(backoff);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
			}
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done(): void {
				clearTimeout(timer);
				resolve();
			}
			this.wake = done;
		});
	}

	private onEvent(ev: SseEvent): void {
		// The event name is not relied on: anything whose data holds an envelope is a message.
		const parsed = parseSignalEvent(ev.data);
		if (!parsed) return;
		// A multi-account daemon sends every account's messages; keep this account's.
		if (parsed.account && normalizeSignalId(parsed.account) !== this.account) return;
		const msg = fromSignalEnvelope(parsed.envelope);
		const onInbound = this.onInbound;
		if (!msg || !onInbound || msg.senderId === this.account) return;
		if (msg.kind === "message" && this.owners.includes(msg.conversation)) {
			const pressed = this.buttons.match(msg.conversation, msg.text, Date.now());
			if (pressed) {
				msg.kind = "button";
				msg.text = pressed.button.label;
				msg.data = pressed.button.data;
				msg.replyTo = pressed.messageId;
			}
		}
		onInbound(msg).catch((err: unknown) => this.log(`signal: handling ${msg.externalId} failed: ${errorText(err)}`));
	}

	/** Call a signal-cli JSON-RPC method. */
	private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const res = await fetch(`${this.base}/api/v1/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method, params, id: randomUUID() }),
			signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
		});
		const body = await res.text();
		let parsed: { result?: T; error?: { code?: number; message?: string } } | undefined;
		try {
			parsed = JSON.parse(body);
		} catch {}
		if (parsed?.error) throw new SignalRpcError(parsed.error.code ?? 0, parsed.error.message ?? "unknown error");
		if (!res.ok) throw Object.assign(new Error(body.slice(0, 200) || res.statusText), { status: res.status });
		if (!parsed) throw new Error(`signal: ${method} returned no JSON`);
		return parsed.result as T;
	}

	/** Signal has no silent flag for bots; `silent` is ignored. */
	async send(msg: OutboundMessage): Promise<SendResult> {
		const recipient = normalizeSignalId(msg.conversation);
		if (!isRecipient(recipient)) throw new PermanentSendError(`signal: "${msg.conversation}" is not a phone number or UUID`);
		const buttons = flattenButtons(msg.buttons);
		const params: Record<string, unknown> = { recipient: [recipient], message: renderWithButtons(msg.text || "…", buttons) };
		const quote = msg.replyTo ? parseSignalRef(msg.replyTo) : undefined;
		if (msg.replyTo && quote && quote.conversation === recipient) {
			params.quoteTimestamp = quote.timestamp;
			params.quoteAuthor = this.sent.has(msg.replyTo) ? this.account : recipient;
		}
		let result: { timestamp?: number; results?: SignalSendResultEntry[] } | undefined;
		try {
			result = await this.rpc("send", params);
			checkSendResults(result?.results);
		} catch (err) {
			throw classifySignalError(err);
		}
		if (!result?.timestamp) throw new Error("signal: send returned no timestamp");
		const externalId = `${recipient}:${result.timestamp}`;
		this.sent.add(externalId);
		if (this.sent.size > SENT_LIMIT) {
			const oldest = this.sent.values().next().value;
			if (oldest !== undefined) this.sent.delete(oldest);
		}
		this.buttons.remember(recipient, buttons, externalId, Date.now());
		return { externalId };
	}

	/** Fetch an attachment through signal-cli's getAttachment (base64 over JSON-RPC). */
	async download(attachment: Attachment): Promise<{ data: Buffer; mimeType: string }> {
		const at = attachment.ref.indexOf(":");
		if (at <= 0) throw new Error(`signal: bad attachment ref ${attachment.ref}`);
		const result = await this.rpc<string | { data?: string }>("getAttachment", { id: attachment.ref.slice(at + 1), recipient: attachment.ref.slice(0, at) });
		const b64 = typeof result === "string" ? result : result?.data;
		if (!b64) throw new Error("signal: getAttachment returned no data");
		return { data: Buffer.from(b64, "base64"), mimeType: attachment.mimeType ?? "application/octet-stream" };
	}

	async typing(conversation: string): Promise<void> {
		await this.rpc("sendTyping", { recipient: [normalizeSignalId(conversation)] }).catch(() => {});
	}

	setOwner(senderId: string): void {
		const id = normalizeSignalId(senderId);
		if (!this.owners.includes(id)) this.owners = [...this.owners, id];
	}

	ownerConversation(): string | undefined {
		return this.owners[0];
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.abort?.abort();
		this.wake?.();
		await this.loop?.catch(() => {});
	}
}
