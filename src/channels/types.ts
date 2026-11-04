// The port every chat app implements. A channel turns its own events into InboundMessages and
// sends OutboundMessages; everything else (who is the owner, retries, ordering) lives in the core.

import type { ChannelId } from "../config.ts";

export interface Button {
	/** Opaque data sent back when pressed, e.g. "approve:ap_123". */
	data: string;
	label: string;
}

export interface InboundMessage {
	channel: ChannelId;
	/** Unique per channel: used as the Trigger's idempotency key. */
	externalId: string;
	senderId: string;
	senderName?: string;
	/** Where to reply: a chat id, a DM channel id, a JID. */
	conversation: string;
	kind: "message" | "button" | "reaction";
	text: string;
	/** The external id of the message this one replies to or reacts to, when the app says. */
	replyTo?: string;
	/** Button data for kind=button; the emoji for kind=reaction. */
	data?: string;
	/** Files sent with the message, fetched on demand with Channel.download(). */
	attachments?: Attachment[];
	at: number;
}

export interface Attachment {
	kind: "photo" | "document" | "voice" | "video";
	/** Channel-specific handle for download(). */
	ref: string;
	name?: string;
	mimeType?: string;
}

export interface OutboundMessage {
	conversation: string;
	text: string;
	buttons?: Button[][];
	replyTo?: string;
	/** Deliver without sound or vibration, where the app supports it (quiet hours). */
	silent?: boolean;
}

export interface SendResult {
	/** The channel's id for the sent message, for reply and reaction routing. */
	externalId: string;
}

/** Errors a channel throws that retrying will never fix (chat deleted, bot blocked). */
export class PermanentSendError extends Error {}

export interface Channel {
	readonly id: ChannelId;
	/** Start listening. Resolves once connected. */
	start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void>;
	send(msg: OutboundMessage): Promise<SendResult>;
	/** Fetch an attachment's bytes. */
	download?(attachment: Attachment): Promise<{ data: Buffer; mimeType: string }>;
	/** Show a short-lived "typing…" indicator, where the app has one. */
	typing?(conversation: string): Promise<void>;
	/** The conversation to use for proactive messages to the owner, if known. */
	ownerConversation(): string | undefined;
	stop(): Promise<void>;
}
