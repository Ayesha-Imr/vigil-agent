// Telegram channel: grammY with long polling (no public URL needed). Text, inline-button presses
// and reactions come in; plain text with optional inline keyboards goes out.

import { Bot, GrammyError, HttpError } from "grammy";
import type { CallbackQuery, InlineKeyboardButton, Message, MessageReactionUpdated, ReactionType } from "grammy/types";
import type { ChannelId } from "../config.ts";
import { type Channel, type InboundMessage, type OutboundMessage, PermanentSendError, type SendResult } from "./types.ts";
import { errorText, type Log, settleWithin, stderrLog, truncate } from "./util.ts";

const ID: ChannelId = "telegram";
/** Telegram rejects callback_data longer than this many bytes. */
const MAX_CALLBACK_BYTES = 64;
const MAX_TEXT = 4096;
/**
 * grammY handles updates one at a time. Wait this long for the core to take an update (so the
 * poll offset usually advances only after it is stored), then move on, so a slow turn cannot
 * hold back the button press that would unblock it.
 */
const HANDLER_WAIT_MS = 5_000;

export interface TelegramOptions {
	token: string;
	/** The owner's Telegram user id; their private chat with the bot has the same id. */
	ownerUserId?: string;
	log?: Log;
}

/** Telegram via grammY long polling. */
export class TelegramChannel implements Channel {
	readonly id = ID;
	private readonly bot: Bot;
	private readonly ownerUserId: string | undefined;
	private readonly log: Log;
	private polling: Promise<void> | undefined;

	constructor(opts: TelegramOptions) {
		this.bot = new Bot(opts.token);
		this.ownerUserId = opts.ownerUserId;
		this.log = opts.log ?? stderrLog;
	}

	async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
		const bot = this.bot;
		const deliver = async (msg: InboundMessage | undefined): Promise<void> => {
			if (!msg) return;
			await settleWithin(onInbound(msg), HANDLER_WAIT_MS, (err) =>
				this.log(`telegram: handling ${msg.externalId} failed: ${errorText(err)}`),
			);
		};
		bot.on("message", (ctx) => deliver(fromMessage(ctx.message)));
		bot.on("callback_query:data", async (ctx) => {
			// Stop the spinner on the owner's phone first; a slow model must not keep it spinning.
			await ctx.answerCallbackQuery().catch((err: unknown) => this.log(`telegram: answerCallbackQuery failed: ${errorText(err)}`));
			await deliver(fromCallback(ctx.callbackQuery));
		});
		bot.on("message_reaction", (ctx) => deliver(fromReaction(ctx.messageReaction)));
		bot.catch((err) => {
			this.log(`telegram: handling update ${err.ctx.update.update_id} failed: ${errorText(err.error)}`);
		});

		// Validates the token before we report the channel as started.
		await bot.init();
		await new Promise<void>((resolve, reject) => {
			this.polling = bot
				.start({
					allowed_updates: ["message", "callback_query", "message_reaction"],
					onStart: (info) => {
						this.log(`telegram: polling as @${info.username}`);
						resolve();
					},
				})
				.catch((err: unknown) => {
					this.log(`telegram: polling stopped: ${errorText(err)}`);
					reject(err);
				});
		});
	}

	/** Telegram shows "typing…" for about five seconds per call. */
	async typing(conversation: string): Promise<void> {
		await this.bot.api.sendChatAction(conversation, "typing").catch(() => {});
	}

	async send(msg: OutboundMessage): Promise<SendResult> {
		const chatId = msg.conversation;
		const keyboard = inlineKeyboard(msg.buttons);
		const reply = msg.replyTo ? parseRef(msg.replyTo) : undefined;
		try {
			const sent = await this.bot.api.sendMessage(chatId, truncate(msg.text || "…", MAX_TEXT), {
				reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
				reply_parameters:
					reply && reply.chat === chatId ? { message_id: reply.id, allow_sending_without_reply: true } : undefined,
				link_preview_options: { is_disabled: true },
				disable_notification: msg.silent || undefined,
			});
			return { externalId: `${sent.chat.id}:${sent.message_id}` };
		} catch (err) {
			throw classifyTelegramError(err);
		}
	}

	ownerConversation(): string | undefined {
		return this.ownerUserId;
	}

	async stop(): Promise<void> {
		if (this.bot.isRunning()) await this.bot.stop();
		await this.polling?.catch(() => {});
	}
}

/** Build an inline keyboard; rejects button data Telegram would refuse. */
export function inlineKeyboard(buttons: OutboundMessage["buttons"]): InlineKeyboardButton[][] | undefined {
	const rows = (buttons ?? []).filter((row) => row.length > 0);
	if (rows.length === 0) return undefined;
	return rows.map((row) =>
		row.map((b) => {
			if (Buffer.byteLength(b.data, "utf8") > MAX_CALLBACK_BYTES) {
				throw new PermanentSendError(`button data longer than ${MAX_CALLBACK_BYTES} bytes: ${b.data.slice(0, 20)}…`);
			}
			return { text: truncate(b.label, 64), callback_data: b.data };
		}),
	);
}

/** Parse an external id `chat:message`. */
export function parseRef(ref: string): { chat: string; id: number } | undefined {
	const at = ref.lastIndexOf(":");
	if (at <= 0) return undefined;
	const id = Number(ref.slice(at + 1));
	return Number.isInteger(id) && id > 0 ? { chat: ref.slice(0, at), id } : undefined;
}

/**
 * Turn a Bot API failure into what the outbox expects: PermanentSendError when retrying cannot
 * help (403 blocked or kicked, any 400 bad request such as "chat not found"), a plain Error
 * otherwise (429 flood control, 5xx, network).
 */
export function classifyTelegramError(err: unknown): Error {
	if (err instanceof PermanentSendError) return err;
	if (err instanceof GrammyError || isApiErrorLike(err)) {
		const { error_code: code, description } = err as { error_code: number; description: string };
		if (code === 403 || code === 400) return new PermanentSendError(`telegram ${code}: ${description}`);
		if (code === 429) {
			const retry = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after;
			return new Error(`telegram 429: rate limited${retry ? `, retry after ${retry} s` : ""}`);
		}
		return new Error(`telegram ${code}: ${description}`);
	}
	if (err instanceof HttpError) return new Error(`telegram network error: ${errorText(err.error)}`);
	return err instanceof Error ? err : new Error(String(err));
}

function isApiErrorLike(err: unknown): boolean {
	return typeof err === "object" && err !== null && typeof (err as { error_code?: unknown }).error_code === "number";
}

/** Map a Telegram message to an InboundMessage, or undefined for service messages. */
export function fromMessage(m: Message): InboundMessage | undefined {
	const from = m.from;
	if (!from || from.is_bot) return undefined;
	const parts: string[] = [];
	const body = m.text ?? m.caption;
	if (body) parts.push(body);
	if (m.photo) parts.push("[photo attached]");
	if (m.document) parts.push(`[document attached: ${m.document.file_name ?? "file"}]`);
	if (m.voice) parts.push("[voice message attached]");
	if (m.video) parts.push("[video attached]");
	if (m.sticker) parts.push(`[sticker ${m.sticker.emoji ?? ""}]`.replace(" ]", "]"));
	if (m.location) parts.push(`[location ${m.location.latitude},${m.location.longitude}]`);
	if (parts.length === 0) return undefined;
	const chat = m.chat.id;
	return {
		channel: ID,
		externalId: `${chat}:${m.message_id}`,
		senderId: String(from.id),
		senderName: displayName(from),
		conversation: String(chat),
		kind: "message",
		text: parts.join("\n"),
		replyTo: m.reply_to_message ? `${chat}:${m.reply_to_message.message_id}` : undefined,
		at: m.date * 1000,
	};
}

/** Map an inline-button press to an InboundMessage. */
export function fromCallback(q: CallbackQuery): InboundMessage | undefined {
	if (q.data === undefined) return undefined;
	const message = q.message;
	const chat = message ? message.chat.id : q.from.id;
	let label: string | undefined;
	if (message && "reply_markup" in message) {
		label = message.reply_markup?.inline_keyboard.flat().find((b) => "callback_data" in b && b.callback_data === q.data)?.text;
	}
	return {
		channel: ID,
		externalId: q.id,
		senderId: String(q.from.id),
		senderName: displayName(q.from),
		conversation: String(chat),
		kind: "button",
		text: label ?? q.data,
		data: q.data,
		replyTo: message ? `${chat}:${message.message_id}` : undefined,
		at: Date.now(),
	};
}

/** Map a reaction change to an InboundMessage for the newly added emoji, if any. */
export function fromReaction(r: MessageReactionUpdated): InboundMessage | undefined {
	if (!r.user || r.user.is_bot) return undefined;
	const old = new Set(r.old_reaction.map(reactionKey));
	const added = r.new_reaction.map(reactionKey).find((k) => !old.has(k));
	if (!added) return undefined;
	const chat = r.chat.id;
	return {
		channel: ID,
		externalId: `reaction:${chat}:${r.message_id}:${r.user.id}:${r.date}:${added}`,
		senderId: String(r.user.id),
		senderName: displayName(r.user),
		conversation: String(chat),
		kind: "reaction",
		text: added,
		data: added,
		replyTo: `${chat}:${r.message_id}`,
		at: r.date * 1000,
	};
}

function reactionKey(r: ReactionType): string {
	if (r.type === "emoji") return r.emoji;
	if (r.type === "custom_emoji") return `custom:${r.custom_emoji_id}`;
	return r.type;
}

function displayName(u: { first_name: string; last_name?: string; username?: string }): string {
	return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "";
}
