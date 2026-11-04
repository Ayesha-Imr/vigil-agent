// Slack channel: Bolt in Socket Mode (an outbound WebSocket, so no public URL), direct messages
// with the owner. Messages, Block Kit button presses and reactions come in; text with optional
// buttons goes out, threaded when it replies to a message.
//
// The Slack app needs Socket Mode on (an xapp- app token with connections:write), the bot scopes
// chat:write, im:history, im:read, im:write, reactions:read, files:read and users:read, the bot
// events message.im and reaction_added, and Interactivity on. Only DMs (channel type "im") are
// read; the core drops senders that are not the owner.

import type { App, Logger, LogLevel, types as slackTypes, webApi } from "@slack/bolt";
import type { ChannelId } from "../config.ts";
import { split } from "../core/outbox.ts";
import { type Attachment, type Button, type Channel, type InboundMessage, type OutboundMessage, PermanentSendError, type SendResult } from "./types.ts";
import { errorText, type Log, stderrLog, truncate } from "./util.ts";

const ID: ChannelId = "slack";
/** Slack truncates message text beyond this many characters. */
const MAX_TEXT = 40_000;
/** A section block's text holds at most 3000 characters. */
const MAX_SECTION = 3000;
const MAX_BLOCKS = 50;
const MAX_BUTTONS_PER_BLOCK = 5;
const MAX_LABEL = 75;
const MAX_ACTION_ID = 255;
const MAX_VALUE = 2000;
/** How many thread mappings and user names to keep in memory. */
const CACHE_LIMIT = 500;

/** Slack API errors that retrying never fixes. */
const PERMANENT_ERRORS = new Set([
	"not_in_channel",
	"channel_not_found",
	"is_archived",
	"account_inactive",
	"user_not_found",
	"users_not_found",
	"user_disabled",
	"cannot_dm_bot",
	"invalid_blocks",
	"invalid_blocks_format",
	"msg_too_long",
	"no_text",
	"restricted_action",
]);

export interface SlackOptions {
	/** The bot token, xoxb-…. */
	botToken: string;
	/** The app-level token for Socket Mode, xapp-…. */
	appToken: string;
	/** The owner's Slack user id (U…). */
	ownerUserId?: string;
	log?: Log;
}

/** A Block Kit block as sent to chat.postMessage. */
export type SlackBlock = slackTypes.KnownBlock;

/** The parts of a Slack file object vigil reads. */
export interface SlackFile {
	id?: string;
	name?: string | null;
	title?: string;
	mimetype?: string;
	url_private?: string;
	url_private_download?: string;
}

/** The parts of a `message` event vigil reads. */
export interface SlackMessageEvent {
	type: "message";
	subtype?: string;
	channel: string;
	channel_type?: string;
	user?: string;
	bot_id?: string;
	text?: string;
	ts: string;
	thread_ts?: string;
	files?: SlackFile[];
}

/** The parts of a `reaction_added` event vigil reads. */
export interface SlackReactionEvent {
	type: "reaction_added";
	user: string;
	reaction: string;
	item: { type: string; channel?: string; ts?: string };
	event_ts: string;
}

/** The parts of a `block_actions` interaction vigil reads. */
export interface SlackBlockActionBody {
	type: string;
	user: { id: string; name?: string; username?: string };
	channel?: { id: string };
	container?: { channel_id?: string; message_ts?: string };
	message?: { ts: string; thread_ts?: string };
	actions: { type: string; action_id: string; value?: string; text?: { text: string }; action_ts?: string }[];
}

/** Message subtypes that carry something the owner wrote. */
const READABLE_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);

/** Slack via Bolt in Socket Mode. Conversations are DM channel ids (D…); a user id (U…) works too. */
export class SlackChannel implements Channel {
	readonly id = ID;
	private readonly botToken: string;
	private readonly appToken: string;
	private ownerUserId: string | undefined;
	private readonly log: Log;
	private app: App | undefined;
	private client: webApi.WebClient | undefined;
	/** DM channel id per user id. */
	private readonly dms = new Map<string, string>();
	private readonly names = new Map<string, string>();
	/** Thread root ts for messages known to sit in a thread, by external id. */
	private readonly threadRoots = new Map<string, string>();
	/** The last message vigil sent into a thread, by the thread's `channel:root_ts`. */
	private readonly lastInThread = new Map<string, string>();

	constructor(opts: SlackOptions) {
		this.botToken = opts.botToken;
		this.appToken = opts.appToken;
		this.ownerUserId = opts.ownerUserId;
		this.log = opts.log ?? stderrLog;
	}

	async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
		const lib = await import("@slack/bolt");
		const logger = quietLogger(this.log, lib.LogLevel.WARN);
		// The outbox retries with its own backoff; do not sit in the client's 30-minute retry loop.
		const clientOptions = { logger, rejectRateLimitedCalls: true, retryConfig: { retries: 2 } };
		// Check the bot token here, so a bad one rejects start(). Passing the bot's ids on also
		// stops Bolt from running its own auth.test, whose failure would be an unhandled rejection.
		const auth = await new lib.webApi.WebClient(this.botToken, clientOptions).auth.test();
		const app = new lib.App({
			token: this.botToken,
			appToken: this.appToken,
			botId: auth.bot_id,
			botUserId: auth.user_id,
			socketMode: true,
			logger,
			clientOptions,
		});
		this.app = app;
		this.client = app.client;
		const deliver = (msg: InboundMessage | undefined): void => {
			if (!msg) return;
			onInbound(msg).catch((err: unknown) => this.log(`slack: handling ${msg.externalId} failed: ${errorText(err)}`));
		};

		app.event("message", async ({ event }) => {
			const e = event as unknown as SlackMessageEvent;
			const msg = fromSlackMessage(e);
			if (!msg) return;
			this.dms.set(msg.senderId, msg.conversation);
			if (e.thread_ts && e.thread_ts !== e.ts) {
				this.remember(this.threadRoots, msg.externalId, e.thread_ts);
				// A reply in a thread most likely answers vigil's latest message there.
				const last = this.lastInThread.get(`${e.channel}:${e.thread_ts}`);
				if (last) msg.replyTo = last;
			}
			msg.senderName = await this.userName(msg.senderId);
			deliver(msg);
		});
		app.event("reaction_added", async ({ event }) => {
			deliver(fromSlackReaction(event as unknown as SlackReactionEvent));
		});
		app.action(/.*/, async ({ ack, body }) => {
			// Acknowledge within Slack's 3 seconds, before the core does anything slow.
			await ack();
			deliver(fromSlackAction(body as unknown as SlackBlockActionBody));
		});
		app.error(async (err) => {
			this.log(`slack: ${errorText(err)}`);
		});

		await app.start();
		this.log(`slack: connected in Socket Mode as @${auth.user ?? "?"}${auth.team ? ` (${auth.team})` : ""}`);
		const owner = this.ownerUserId;
		if (owner) await this.openDm(owner).catch((err: unknown) => this.log(`slack: opening the DM with ${owner} failed: ${errorText(err)}`));
	}

	/** Download a file the owner sent (only https://files.slack.com, with the bot token). */
	async download(attachment: Attachment): Promise<{ data: Buffer; mimeType: string }> {
		const url = new URL(attachment.ref);
		if (url.protocol !== "https:" || url.hostname !== "files.slack.com") throw new Error(`refusing to fetch ${url.hostname}`);
		const res = await fetch(url, { headers: { authorization: `Bearer ${this.botToken}` }, signal: AbortSignal.timeout(60_000) });
		if (!res.ok) throw new Error(`slack file download: HTTP ${res.status}`);
		const type = res.headers.get("content-type") ?? "";
		// Without files:read Slack answers with its sign-in page instead of the file.
		if (type.startsWith("text/html") && !attachment.mimeType?.startsWith("text/html")) {
			throw new Error("slack file download returned a web page; does the app have the files:read scope?");
		}
		return { data: Buffer.from(await res.arrayBuffer()), mimeType: attachment.mimeType ?? (type || "application/octet-stream") };
	}

	/** Slack has no typing indicator for bots outside the legacy RTM API. */
	async typing(_conversation: string): Promise<void> {}

	/** Slack has no silent flag; `silent` is ignored. */
	async send(msg: OutboundMessage): Promise<SendResult> {
		const client = this.client;
		if (!client) throw new Error("slack: not connected");
		try {
			const channel = await this.resolve(msg.conversation);
			const ref = msg.replyTo ? parseSlackRef(msg.replyTo) : undefined;
			const threadTs = ref && msg.replyTo && ref.channel === channel ? (this.threadRoots.get(msg.replyTo) ?? ref.ts) : undefined;
			const blocks = slackBlocks(msg.text, msg.buttons);
			const res = await client.chat.postMessage({
				channel,
				text: escapeSlack(truncate(msg.text || "…", MAX_TEXT)),
				blocks,
				thread_ts: threadTs,
				unfurl_links: false,
				unfurl_media: false,
			});
			if (!res.ts) throw new Error("slack: chat.postMessage returned no ts");
			const externalId = `${res.channel ?? channel}:${res.ts}`;
			if (threadTs) {
				this.remember(this.threadRoots, externalId, threadTs);
				this.remember(this.lastInThread, `${res.channel ?? channel}:${threadTs}`, externalId);
			}
			return { externalId };
		} catch (err) {
			throw classifySlackError(err);
		}
	}

	/** A DM channel id for `conversation`: user ids (U…/W…) are opened with conversations.open. */
	private async resolve(conversation: string): Promise<string> {
		if (/^[UW][A-Z0-9]+$/.test(conversation)) return await this.openDm(conversation);
		return conversation;
	}

	private async openDm(userId: string): Promise<string> {
		const cached = this.dms.get(userId);
		if (cached) return cached;
		const client = this.client;
		if (!client) throw new Error("slack: not connected");
		const res = await client.conversations.open({ users: userId });
		const id = res.channel?.id;
		if (!id) throw new Error(`slack: conversations.open returned no channel for ${userId}`);
		this.dms.set(userId, id);
		return id;
	}

	private async userName(userId: string): Promise<string | undefined> {
		const known = this.names.get(userId);
		if (known !== undefined) return known || undefined;
		const res = await this.client?.users.info({ user: userId }).catch(() => undefined);
		const user = res?.user;
		const name = user?.profile?.display_name || user?.real_name || user?.name || "";
		this.remember(this.names, userId, name);
		return name || undefined;
	}

	private remember(map: Map<string, string>, key: string, value: string): void {
		map.set(key, value);
		if (map.size > CACHE_LIMIT) {
			const oldest = map.keys().next().value;
			if (oldest !== undefined) map.delete(oldest);
		}
	}

	setOwner(senderId: string): void {
		this.ownerUserId = senderId;
		if (this.client) this.openDm(senderId).catch((err: unknown) => this.log(`slack: opening the DM with ${senderId} failed: ${errorText(err)}`));
	}

	/** The owner's DM channel once known; until then their user id, which send() resolves. */
	ownerConversation(): string | undefined {
		const owner = this.ownerUserId;
		return owner ? (this.dms.get(owner) ?? owner) : undefined;
	}

	async stop(): Promise<void> {
		const app = this.app;
		this.app = undefined;
		this.client = undefined;
		await app?.stop().catch((err: unknown) => this.log(`slack: stopping failed: ${errorText(err)}`));
	}
}

/** Map a DM `message` event to an InboundMessage, or undefined for edits, bots, channels and empties. */
export function fromSlackMessage(e: SlackMessageEvent): InboundMessage | undefined {
	if (e.type !== "message" || e.channel_type !== "im") return undefined;
	if (!READABLE_SUBTYPES.has(e.subtype) || !e.user || e.bot_id) return undefined;
	const parts: string[] = [];
	const body = slackToPlain(e.text ?? "");
	if (body) parts.push(body);
	const attachments: Attachment[] = [];
	for (const f of e.files ?? []) {
		const kind = fileKind(f.mimetype);
		const name = f.name ?? f.title ?? "file";
		parts.push(kind === "photo" ? "[photo attached]" : kind === "voice" ? "[voice message attached]" : kind === "video" ? "[video attached]" : `[document attached: ${name}]`);
		const ref = f.url_private_download ?? f.url_private;
		if (ref) attachments.push({ kind, ref, name, mimeType: f.mimetype });
	}
	if (parts.length === 0) return undefined;
	return {
		channel: ID,
		externalId: `${e.channel}:${e.ts}`,
		senderId: e.user,
		conversation: e.channel,
		kind: "message",
		text: parts.join("\n"),
		replyTo: e.thread_ts && e.thread_ts !== e.ts ? `${e.channel}:${e.thread_ts}` : undefined,
		attachments: attachments.length ? attachments : undefined,
		at: slackTime(e.ts),
	};
}

/** Map a Block Kit button press to an InboundMessage. */
export function fromSlackAction(body: SlackBlockActionBody): InboundMessage | undefined {
	if (body.type !== "block_actions") return undefined;
	const action = body.actions?.[0];
	if (!action || action.type !== "button") return undefined;
	const channel = body.channel?.id ?? body.container?.channel_id;
	if (!channel) return undefined;
	const messageTs = body.message?.ts ?? body.container?.message_ts;
	const data = action.value ?? action.action_id;
	return {
		channel: ID,
		externalId: `action:${channel}:${messageTs ?? "?"}:${body.user.id}:${action.action_ts ?? Date.now()}`,
		senderId: body.user.id,
		senderName: body.user.name ?? body.user.username,
		conversation: channel,
		kind: "button",
		text: action.text?.text ?? data,
		data,
		replyTo: messageTs ? `${channel}:${messageTs}` : undefined,
		at: action.action_ts ? slackTime(action.action_ts) : Date.now(),
	};
}

/** Map a reaction on a message in a DM to an InboundMessage. */
export function fromSlackReaction(e: SlackReactionEvent): InboundMessage | undefined {
	const { channel, ts } = e.item;
	if (e.item.type !== "message" || !channel || !ts || !channel.startsWith("D")) return undefined;
	const emoji = slackEmoji(e.reaction);
	return {
		channel: ID,
		externalId: `reaction:${channel}:${ts}:${e.user}:${e.reaction}:${e.event_ts}`,
		senderId: e.user,
		conversation: channel,
		kind: "reaction",
		text: emoji,
		data: emoji,
		replyTo: `${channel}:${ts}`,
		at: slackTime(e.event_ts),
	};
}

/** Slack emoji names the core understands, as the emoji themselves. */
const EMOJI: Record<string, string> = {
	"+1": "👍",
	thumbsup: "👍",
	"-1": "👎",
	thumbsdown: "👎",
	unamused: "😒",
	face_with_rolling_eyes: "🙄",
	roll_eyes: "🙄",
	hankey: "💩",
	poop: "💩",
	shit: "💩",
	no_bell: "🔕",
	mute: "🔇",
	shushing_face: "🤫",
	speak_no_evil: "🙊",
	heart: "❤️",
	white_check_mark: "✅",
	heavy_check_mark: "✔️",
	x: "❌",
	eyes: "👀",
	tada: "🎉",
	pray: "🙏",
	ok_hand: "👌",
	fire: "🔥",
};

/** A reaction name (`thumbsdown`, `+1::skin-tone-3`) as an emoji, or `:name:` when unknown. */
export function slackEmoji(name: string): string {
	const base = name.split("::")[0];
	return EMOJI[base] ?? `:${base}:`;
}

/** Slack's message markup to plain text: links, mentions and the three escaped characters. */
export function slackToPlain(text: string): string {
	return text
		.replace(/<([^<>|]+)\|([^<>]+)>/g, (_m, target: string, label: string) => (target.startsWith("@") || target.startsWith("#") || target.startsWith("!") ? label : `${label} (${target})`))
		.replace(/<([@#!][^<>]+)>/g, "$1")
		.replace(/<((?:https?|mailto):[^<>]+)>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.trim();
}

/** Escape the three characters Slack treats as markup. */
export function escapeSlack(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Blocks for a message with buttons: the text as section blocks, then each row of buttons as
 * actions blocks of at most 5. Undefined when there are no buttons (plain text is enough).
 * The action_id is the button data (made unique within the message), and so is the value.
 */
export function slackBlocks(text: string, buttons: Button[][] | undefined): SlackBlock[] | undefined {
	const rows = (buttons ?? []).filter((row) => row.length > 0);
	if (rows.length === 0) return undefined;
	const blocks: SlackBlock[] = split(text || "…", MAX_SECTION)
		.filter((p) => p.length > 0)
		.map((part) => ({ type: "section", text: { type: "mrkdwn", text: truncate(escapeSlack(part), MAX_SECTION) } }));
	if (blocks.length === 0) blocks.push({ type: "section", text: { type: "mrkdwn", text: "…" } });
	const used = new Set<string>();
	for (const row of rows) {
		for (let i = 0; i < row.length; i += MAX_BUTTONS_PER_BLOCK) {
			if (blocks.length >= MAX_BLOCKS) return blocks;
			blocks.push({ type: "actions", elements: row.slice(i, i + MAX_BUTTONS_PER_BLOCK).map((b) => slackButton(b, used)) });
		}
	}
	return blocks;
}

function slackButton(b: Button, used: Set<string>): slackTypes.Button {
	if (Buffer.byteLength(b.data, "utf8") > MAX_ACTION_ID || b.data.length > MAX_VALUE) {
		throw new PermanentSendError(`button data longer than ${MAX_ACTION_ID} bytes: ${b.data.slice(0, 20)}…`);
	}
	if (!b.data) throw new PermanentSendError("button without data");
	let actionId = b.data;
	for (let n = 2; used.has(actionId); n++) actionId = `${b.data.slice(0, MAX_ACTION_ID - 4)}#${n}`;
	used.add(actionId);
	return { type: "button", text: { type: "plain_text", text: truncate(b.label || "?", MAX_LABEL), emoji: true }, action_id: actionId, value: b.data };
}

/** Parse an external id `channel:ts`. */
export function parseSlackRef(ref: string): { channel: string; ts: string } | undefined {
	const m = /^([A-Z0-9]+):(\d+\.\d+)$/.exec(ref);
	return m ? { channel: m[1], ts: m[2] } : undefined;
}

/**
 * PermanentSendError for failures retrying cannot fix (channel gone or archived, user
 * deactivated, rejected blocks); a plain Error for rate limits, auth, 5xx and network failures.
 */
export function classifySlackError(err: unknown): Error {
	if (err instanceof PermanentSendError) return err;
	if (typeof err === "object" && err !== null) {
		const e = err as { code?: unknown; data?: { error?: unknown }; retryAfter?: unknown; statusCode?: unknown };
		const apiError = typeof e.data?.error === "string" ? e.data.error : undefined;
		if (apiError && PERMANENT_ERRORS.has(apiError)) return new PermanentSendError(`slack: ${apiError}`);
		if (apiError === "ratelimited" || e.code === "slack_webapi_rate_limited_error" || e.statusCode === 429) {
			return new Error(`slack: rate limited${typeof e.retryAfter === "number" ? `, retry after ${e.retryAfter} s` : ""}`);
		}
		if (apiError) return new Error(`slack: ${apiError}`);
	}
	return err instanceof Error ? err : new Error(String(err));
}

function fileKind(mimeType: string | undefined): Attachment["kind"] {
	if (mimeType?.startsWith("image/")) return "photo";
	if (mimeType?.startsWith("audio/")) return "voice";
	if (mimeType?.startsWith("video/")) return "video";
	return "document";
}

/** Slack timestamps are `seconds.micros` strings. */
function slackTime(ts: string): number {
	const ms = Math.round(Number(ts) * 1000);
	return Number.isFinite(ms) && ms > 0 ? ms : Date.now();
}

/** Bolt and the Socket Mode client log a lot; keep warnings and errors, one line each. */
function quietLogger(log: Log, level: LogLevel): Logger {
	const line = (msg: unknown[]): string => msg.map((m) => (m instanceof Error ? m.message : typeof m === "string" ? m : safeJson(m))).join(" ").slice(0, 300);
	return {
		debug: () => {},
		info: () => {},
		warn: (...msg: unknown[]) => log(`slack: ${line(msg)}`),
		error: (...msg: unknown[]) => log(`slack: ${line(msg)}`),
		setLevel: () => {},
		getLevel: () => level,
		setName: () => {},
	};
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
