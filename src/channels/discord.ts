// Discord channel: discord.js v14, direct messages with the owner. Messages, button presses and
// reactions come in; text (split at Discord's 2000-char limit) with optional buttons goes out.

import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	type DMChannel,
	Events,
	GatewayIntentBits,
	type Message,
	MessageFlags,
	type MessageReaction,
	type PartialMessageReaction,
	Partials,
	type SendableChannels,
} from "discord.js";
import type { ChannelId } from "../config.ts";
import { split } from "../core/outbox.ts";
import { type Button, type Channel, type InboundMessage, type OutboundMessage, PermanentSendError, type SendResult } from "./types.ts";
import { errorText, type Log, stderrLog, truncate } from "./util.ts";

const ID: ChannelId = "discord";
/** Discord's limit on message content length. */
export const DISCORD_MAX_LENGTH = 2000;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;
const MAX_LABEL = 80;
const MAX_CUSTOM_ID = 100;

/** Discord JSON error codes that retrying never fixes. */
const PERMANENT_CODES = new Set([
	10003, // Unknown Channel
	10008, // Unknown Message
	10013, // Unknown User
	50001, // Missing Access
	50007, // Cannot send messages to this user
	50013, // Missing Permissions
	50035, // Invalid Form Body
	50278, // Cannot send messages: no mutual guilds
]);

export interface DiscordOptions {
	token: string;
	/** The owner's Discord user id. */
	ownerUserId?: string;
	log?: Log;
}

/** Discord DMs via discord.js. Conversations are `dm:<userId>` or a plain channel id. */
export class DiscordChannel implements Channel {
	readonly id = ID;
	private readonly token: string;
	private readonly ownerUserId: string | undefined;
	private readonly log: Log;
	private readonly client: Client;
	private readonly dms = new Map<string, DMChannel>();

	constructor(opts: DiscordOptions) {
		this.token = opts.token;
		this.ownerUserId = opts.ownerUserId;
		this.log = opts.log ?? stderrLog;
		this.client = new Client({
			intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.DirectMessageReactions, GatewayIntentBits.MessageContent],
			partials: [Partials.Channel, Partials.Message, Partials.Reaction],
		});
	}

	async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
		const client = this.client;
		const deliver = (msg: InboundMessage | undefined): void => {
			if (!msg) return;
			onInbound(msg).catch((err: unknown) => this.log(`discord: handling ${msg.externalId} failed: ${errorText(err)}`));
		};

		client.on(Events.MessageCreate, (message) => {
			if (message.author.bot || !message.channel.isDMBased()) return;
			deliver(fromDiscordMessage(message));
		});
		client.on(Events.InteractionCreate, (interaction) => {
			if (!interaction.isButton()) return;
			interaction.deferUpdate().catch((err: unknown) => this.log(`discord: deferUpdate failed: ${errorText(err)}`));
			const dm = interaction.channel?.isDMBased() ?? !interaction.inGuild();
			deliver({
				channel: ID,
				externalId: interaction.id,
				senderId: interaction.user.id,
				senderName: interaction.user.displayName,
				conversation: dm ? `dm:${interaction.user.id}` : interaction.channelId,
				kind: "button",
				text: buttonLabel(interaction.message, interaction.customId) ?? interaction.customId,
				data: interaction.customId,
				replyTo: `${interaction.channelId}:${interaction.message.id}`,
				at: interaction.createdTimestamp,
			});
		});
		client.on(Events.MessageReactionAdd, (reaction, user) => {
			if (user.bot) return;
			this.onReaction(reaction, user.id, user.username ?? undefined)
				.then(deliver)
				.catch((err: unknown) => this.log(`discord: reading reaction failed: ${errorText(err)}`));
		});
		client.on(Events.Error, (err) => this.log(`discord: client error: ${errorText(err)}`));
		client.on(Events.ShardDisconnect, (_e, shard) => this.log(`discord: shard ${shard} disconnected`));

		const ready = new Promise<void>((resolve) => {
			client.once(Events.ClientReady, (c) => {
				this.log(`discord: logged in as ${c.user.tag}`);
				resolve();
			});
		});
		await client.login(this.token);
		await ready;
	}

	private async onReaction(
		reaction: MessageReaction | PartialMessageReaction,
		userId: string,
		userName: string | undefined,
	): Promise<InboundMessage | undefined> {
		const full = reaction.partial ? await reaction.fetch() : reaction;
		const channel = full.message.channel;
		if (!channel.isDMBased()) return undefined;
		const emoji = full.emoji.id ? `<:${full.emoji.name ?? "emoji"}:${full.emoji.id}>` : (full.emoji.name ?? "?");
		const ref = `${full.message.channelId}:${full.message.id}`;
		return {
			channel: ID,
			externalId: `reaction:${ref}:${userId}:${emoji}:${Date.now()}`,
			senderId: userId,
			senderName: userName,
			conversation: `dm:${userId}`,
			kind: "reaction",
			text: emoji,
			data: emoji,
			replyTo: ref,
			at: Date.now(),
		};
	}

	async send(msg: OutboundMessage): Promise<SendResult> {
		try {
			const channel = await this.resolve(msg.conversation);
			const parts = splitForDiscord(msg.text);
			const components = buttonRows(msg.buttons);
			const replyTo = msg.replyTo ? parseDiscordRef(msg.replyTo) : undefined;
			let last: Message | undefined;
			for (const [i, content] of parts.entries()) {
				const isLast = i === parts.length - 1;
				last = await channel.send({
					content,
					components: isLast && components.length > 0 ? components : undefined,
					reply:
						i === 0 && replyTo && replyTo.channelId === channel.id
							? { messageReference: replyTo.messageId, failIfNotExists: false }
							: undefined,
					allowedMentions: { parse: [] },
					flags: msg.silent ? MessageFlags.SuppressNotifications : undefined,
				});
			}
			if (!last) throw new Error("nothing sent");
			return { externalId: `${last.channelId}:${last.id}` };
		} catch (err) {
			throw classifyDiscordError(err);
		}
	}

	private async resolve(conversation: string): Promise<SendableChannels> {
		if (conversation.startsWith("dm:")) {
			const userId = conversation.slice(3);
			const cached = this.dms.get(userId);
			if (cached) return cached;
			const user = await this.client.users.fetch(userId);
			const dm = await user.createDM();
			this.dms.set(userId, dm);
			return dm;
		}
		const channel = await this.client.channels.fetch(conversation);
		if (!channel || !channel.isSendable()) throw new PermanentSendError(`discord channel ${conversation} is not a text channel`);
		return channel;
	}

	ownerConversation(): string | undefined {
		return this.ownerUserId ? `dm:${this.ownerUserId}` : undefined;
	}

	async stop(): Promise<void> {
		await this.client.destroy();
		this.dms.clear();
	}
}

/** Map a DM to an InboundMessage, or undefined when it carries nothing to read. */
export function fromDiscordMessage(message: Message): InboundMessage | undefined {
	const parts: string[] = [];
	if (message.content) parts.push(message.content);
	for (const a of message.attachments.values()) parts.push(`[attachment: ${a.name}]`);
	if (parts.length === 0) return undefined;
	return {
		channel: ID,
		externalId: `${message.channelId}:${message.id}`,
		senderId: message.author.id,
		senderName: message.author.displayName,
		conversation: `dm:${message.author.id}`,
		kind: "message",
		text: parts.join("\n"),
		replyTo: message.reference?.messageId ? `${message.reference.channelId}:${message.reference.messageId}` : undefined,
		at: message.createdTimestamp,
	};
}

function buttonLabel(message: Message, customId: string): string | undefined {
	for (const row of message.components) {
		if (!("components" in row)) continue;
		for (const c of row.components) {
			if ("customId" in c && c.customId === customId && "label" in c && typeof c.label === "string") return c.label;
		}
	}
	return undefined;
}

/** Split text into parts Discord accepts (at most 2000 chars, never empty). */
export function splitForDiscord(text: string, max = DISCORD_MAX_LENGTH): string[] {
	const parts = split(text, max).filter((p) => p.length > 0);
	return parts.length > 0 ? parts : ["…"];
}

/** Lay buttons out as at most 5 rows of at most 5; long rows wrap, extra buttons are dropped. */
export function layoutButtons(buttons: Button[][] | undefined): Button[][] {
	const rows: Button[][] = [];
	for (const row of buttons ?? []) {
		for (let i = 0; i < row.length; i += MAX_BUTTONS_PER_ROW) rows.push(row.slice(i, i + MAX_BUTTONS_PER_ROW));
	}
	return rows.slice(0, MAX_ROWS);
}

function buttonRows(buttons: Button[][] | undefined): ActionRowBuilder<ButtonBuilder>[] {
	return layoutButtons(buttons).map((row) =>
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			row.map((b) => {
				if (b.data.length > MAX_CUSTOM_ID) throw new PermanentSendError(`button data longer than ${MAX_CUSTOM_ID} chars`);
				return new ButtonBuilder()
					.setCustomId(b.data)
					.setLabel(truncate(b.label || "?", MAX_LABEL))
					.setStyle(ButtonStyle.Secondary);
			}),
		),
	);
}

/** Parse an external id `channelId:messageId`. */
export function parseDiscordRef(ref: string): { channelId: string; messageId: string } | undefined {
	const m = /^(\d+):(\d+)$/.exec(ref);
	return m ? { channelId: m[1], messageId: m[2] } : undefined;
}

/**
 * PermanentSendError for failures retrying cannot fix (unknown user or channel, DMs closed,
 * missing access, invalid body); a plain Error for rate limits, 5xx and network failures.
 */
export function classifyDiscordError(err: unknown): Error {
	if (err instanceof PermanentSendError) return err;
	if (typeof err === "object" && err !== null) {
		const { code, status } = err as { code?: unknown; status?: unknown };
		const msg = errorText(err);
		if (typeof code === "number" && PERMANENT_CODES.has(code)) return new PermanentSendError(`discord ${code}: ${msg}`);
		if (status === 429) return new Error(`discord 429: rate limited: ${msg}`);
		if (status === 403 || status === 404) return new PermanentSendError(`discord ${status}: ${msg}`);
	}
	return err instanceof Error ? err : new Error(String(err));
}
