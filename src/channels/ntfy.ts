// ntfy channel: outbound-only push notifications to an ntfy topic, for owners who do not want a
// chat bot. Buttons become ntfy "http" actions that call back into vigil's HTTP API, signed per
// button, when that API has a public URL.

import type { ChannelId } from "../config.ts";
import { signButton } from "./http.ts";
import { type Button, type Channel, type InboundMessage, type OutboundMessage, PermanentSendError, type SendResult } from "./types.ts";
import { errorText, flattenButtons } from "./util.ts";

const ID: ChannelId = "ntfy";
/** ntfy shows at most three actions per notification. */
const MAX_ACTIONS = 3;

export interface NtfyOptions {
	server: string;
	topic: string;
	/** ntfy access token, if the topic is protected. */
	token?: string;
	/** Where the phone can reach vigil's HTTP API, and its token; both needed for action buttons. */
	callback?: { publicUrl: string; token: string };
	title?: string;
	fetch?: typeof fetch;
}

/** Push-only channel to an ntfy server. Never emits inbound messages. */
export class NtfyChannel implements Channel {
	readonly id = ID;
	private readonly opts: NtfyOptions;
	private readonly fetch: typeof fetch;

	constructor(opts: NtfyOptions) {
		this.opts = opts;
		this.fetch = opts.fetch ?? fetch;
	}

	async start(_onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {}

	async send(msg: OutboundMessage): Promise<SendResult> {
		const topic = msg.conversation || this.opts.topic;
		const url = `${this.opts.server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
		const headers = ntfyHeaders(msg, this.opts);
		let res: Response;
		try {
			res = await this.fetch(url, { method: "POST", headers, body: msg.text, signal: AbortSignal.timeout(30_000) });
		} catch (err) {
			throw new Error(`ntfy: ${errorText(err)}`);
		}
		const body = await res.text().catch(() => "");
		if (!res.ok) throw classifyNtfyStatus(res.status, body);
		let id: string | undefined;
		try {
			id = (JSON.parse(body) as { id?: string }).id;
		} catch {
			// Older servers may not answer with JSON; the message still went out.
		}
		return { externalId: `${topic}:${id ?? Date.now()}` };
	}

	ownerConversation(): string | undefined {
		return this.opts.topic;
	}

	async stop(): Promise<void> {}
}

/** The request headers for one notification. */
export function ntfyHeaders(msg: OutboundMessage, opts: Pick<NtfyOptions, "token" | "callback" | "title">): Record<string, string> {
	const urgent = msg.text.trimStart().startsWith("🚨");
	const headers: Record<string, string> = {
		Title: headerValue(opts.title ?? "vigil"),
		Priority: urgent ? "5" : "3",
		Tags: urgent ? "rotating_light" : "speech_balloon",
	};
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	const actions = opts.callback ? ntfyActions(flattenButtons(msg.buttons), opts.callback) : undefined;
	if (actions) headers.Actions = actions;
	return headers;
}

/**
 * The `Actions` header for up to three buttons: http POSTs to `/api/button?data=…&sig=…`, where
 * the signature authorizes that one button, so the API token never goes to the ntfy server.
 */
export function ntfyActions(buttons: Button[], callback: { publicUrl: string; token: string }): string | undefined {
	const base = callback.publicUrl.replace(/\/+$/, "");
	const parts = buttons.slice(0, MAX_ACTIONS).map((b) => {
		const url = `${base}/api/button?data=${encodeURIComponent(b.data)}&sig=${signButton(callback.token, b.data)}`;
		// Keep labels plain ASCII without the header's separators; emoji are dropped.
		const label = b.label.replace(/[^\x20-\x7e]|["',;=]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "?";
		return `http, "${label}", ${url}, method=POST, clear=true`;
	});
	return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Header values must be Latin-1; ntfy decodes RFC 2047 encoded words for anything else. */
function headerValue(value: string): string {
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** 429 and 5xx are worth retrying; other 4xx (bad token, forbidden topic, too large) are not. */
export function classifyNtfyStatus(status: number, body: string): Error {
	const detail = `ntfy ${status}: ${body.slice(0, 200)}`;
	if (status === 429 || status >= 500 || status === 408) return new Error(detail);
	return new PermanentSendError(detail);
}
