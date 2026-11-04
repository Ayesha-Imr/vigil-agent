// WhatsApp channel via Baileys, as a linked device paired by QR code.
//
// WARNING: Baileys is an unofficial, reverse-engineered WhatsApp Web client. WhatsApp may break
// it at any time, rate-limit it, or ban the number it runs on. Use a secondary number. This
// channel is opt-in: it only runs when cfg.channels.whatsapp.enabled is true.
//
// WhatsApp has no buttons for unofficial clients, so buttons are rendered as a numbered list and
// a bare digit from the owner shortly afterwards counts as pressing that button.

import { join } from "node:path";
import type { WAMessage, WAMessageContent, WASocket } from "baileys";
import qrcode from "qrcode-terminal";
import type { ChannelId } from "../config.ts";
import { type Button, type Channel, type InboundMessage, type OutboundMessage, PermanentSendError, type SendResult } from "./types.ts";
import { errorText, flattenButtons, type Log, stderrLog } from "./util.ts";

const ID: ChannelId = "whatsapp";
/** How long a bare-digit reply still counts as pressing one of the last buttons sent. */
export const BUTTON_REPLY_WINDOW_MS = 30 * 60_000;
const RECENT_LIMIT = 500;
const MAX_BACKOFF_MS = 60_000;

type Baileys = typeof import("baileys");

export interface WhatsAppOptions {
	/** vigil's home; auth state lives in `${home}/whatsapp-auth`. */
	home: string;
	/** Owner JIDs, e.g. `923001234567@s.whatsapp.net`. The first one is the notify target. */
	ownerJids?: string[];
	log?: Log;
	/** Show a pairing QR code. Defaults to printing it on stderr. */
	showQr?: (qr: string) => void;
}

/** The text for a message with buttons: the numbered choices appended. */
export function renderWithButtons(text: string, buttons: Button[]): string {
	if (buttons.length === 0) return text;
	const choices = buttons.map((b, i) => `${i + 1} to ${b.label}`).join(", ");
	return `${text}\n\nReply ${choices}`;
}

interface Remembered {
	buttons: Button[];
	at: number;
	/** The external id of the message that carried the buttons. */
	messageId: string;
}

/** Remembers the last buttons sent per conversation and maps a bare-digit reply to one. */
export class ButtonMemory {
	private readonly last = new Map<string, Remembered>();
	private readonly windowMs: number;

	constructor(windowMs = BUTTON_REPLY_WINDOW_MS) {
		this.windowMs = windowMs;
	}

	remember(conversation: string, buttons: Button[], messageId: string, now: number): void {
		if (buttons.length === 0) return;
		this.last.set(conversation, { buttons, at: now, messageId });
	}

	/**
	 * The button a reply presses, if `text` is just a number for one of the last buttons sent to
	 * this conversation within the window. A match is used up, so a later "2" is plain text.
	 */
	match(conversation: string, text: string, now: number): { button: Button; messageId: string } | undefined {
		const entry = this.last.get(conversation);
		if (!entry) return undefined;
		if (now - entry.at > this.windowMs) {
			this.last.delete(conversation);
			return undefined;
		}
		const m = /^\s*(\d{1,2})\s*\.?\s*$/.exec(text);
		if (!m) return undefined;
		const button = entry.buttons[Number(m[1]) - 1];
		if (!button) return undefined;
		this.last.delete(conversation);
		return { button, messageId: entry.messageId };
	}
}

/** The readable text of a message's content, with notes for media; undefined when there is none. */
export function messageText(content: WAMessageContent | undefined): string | undefined {
	if (!content) return undefined;
	const parts: string[] = [];
	const body =
		content.conversation ??
		content.extendedTextMessage?.text ??
		content.imageMessage?.caption ??
		content.videoMessage?.caption ??
		content.documentMessage?.caption;
	if (body) parts.push(body);
	if (content.imageMessage) parts.push("[photo attached]");
	if (content.videoMessage) parts.push("[video attached]");
	if (content.audioMessage) parts.push("[voice message attached]");
	if (content.documentMessage) parts.push(`[document attached: ${content.documentMessage.fileName ?? "file"}]`);
	if (content.locationMessage) {
		parts.push(`[location ${content.locationMessage.degreesLatitude},${content.locationMessage.degreesLongitude}]`);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** WhatsApp via Baileys (unofficial). Conversations are user JIDs. */
export class WhatsAppChannel implements Channel {
	readonly id = ID;
	private readonly authDir: string;
	private owners: string[];
	private readonly log: Log;
	private readonly showQr: (qr: string) => void;
	private readonly buttons = new ButtonMemory();
	/** Recent messages by external id, for quoting and for Baileys' resend requests. */
	private readonly recent = new Map<string, WAMessage>();
	private lib: Baileys | undefined;
	private sock: WASocket | undefined;
	private onInbound: ((msg: InboundMessage) => Promise<void>) | undefined;
	private stopped = false;
	private backoff = 2_000;
	private reconnectTimer: NodeJS.Timeout | undefined;
	/** The pending start() call, settled by whichever connection opens, shows a QR or is logged out. */
	private starting: { resolve: () => void; reject: (err: Error) => void } | undefined;

	constructor(opts: WhatsAppOptions) {
		this.authDir = join(opts.home, "whatsapp-auth");
		this.log = opts.log ?? stderrLog;
		this.showQr = opts.showQr ?? printQr;
		this.owners = (opts.ownerJids ?? []).map(normalizeJid);
	}

	/**
	 * Connect. Resolves when the connection opens, or as soon as a pairing QR code is shown (so
	 * an unpaired device does not hold up the daemon). Rejects if WhatsApp says it is logged out.
	 */
	async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
		this.onInbound = onInbound;
		this.stopped = false;
		this.lib = await import("baileys");
		await new Promise<void>((resolve, reject) => {
			this.starting = { resolve, reject };
			this.connect().catch((err: unknown) => this.settleStart(err instanceof Error ? err : new Error(String(err))));
		});
	}

	private settleStart(err?: Error): void {
		const starting = this.starting;
		this.starting = undefined;
		if (!starting) return;
		if (err) starting.reject(err);
		else starting.resolve();
	}

	private async connect(): Promise<void> {
		const lib = this.lib;
		if (!lib || this.stopped) return;
		const { state, saveCreds } = await lib.useMultiFileAuthState(this.authDir);
		const sock = lib.makeWASocket({
			auth: state,
			browser: lib.Browsers.ubuntu("vigil"),
			logger: quietLogger(this.log),
			markOnlineOnConnect: false,
			syncFullHistory: false,
			shouldSyncHistoryMessage: () => false,
			getMessage: async (key) => {
				for (const m of this.recent.values()) if (m.key.id === key.id) return m.message ?? undefined;
				return undefined;
			},
		});
		this.sock = sock;

		sock.ev.on("creds.update", () => {
			saveCreds().catch((err: unknown) => this.log(`whatsapp: saving credentials failed: ${errorText(err)}`));
		});
		sock.ev.on("connection.update", (update) => {
			if (update.qr) {
				this.log("whatsapp: not paired. Scan this QR code in WhatsApp > Linked devices > Link a device");
				this.showQr(update.qr);
				this.settleStart();
			}
			if (update.connection === "open") {
				this.backoff = 2_000;
				this.log(`whatsapp: connected as ${sock.user?.id ?? "?"}`);
				this.settleStart();
			}
			if (update.connection === "close") {
				if (this.sock === sock) this.sock = undefined;
				const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
				if (code === lib.DisconnectReason.loggedOut) {
					this.log(`whatsapp: logged out. Delete ${this.authDir} and restart vigil to pair again`);
					this.settleStart(new Error("whatsapp: logged out"));
					return;
				}
				if (this.stopped) return;
				const delay = code === lib.DisconnectReason.restartRequired ? 0 : this.backoff;
				this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
				this.log(`whatsapp: connection closed (${code ?? errorText(update.lastDisconnect?.error)}), reconnecting in ${delay / 1000} s`);
				this.reconnectTimer = setTimeout(() => {
					this.connect().catch((err: unknown) => this.log(`whatsapp: reconnect failed: ${errorText(err)}`));
				}, delay);
			}
		});
		sock.ev.on("messages.upsert", ({ messages, type }) => {
			if (type !== "notify") return;
			for (const m of messages) {
				this.handle(m).catch((err: unknown) => this.log(`whatsapp: handling message failed: ${errorText(err)}`));
			}
		});
	}

	private async handle(m: WAMessage): Promise<void> {
		const lib = this.lib;
		const onInbound = this.onInbound;
		const remote = m.key.remoteJid;
		if (!lib || !onInbound || !remote || m.key.fromMe || !m.message || !m.key.id) return;
		// Direct chats only: no groups, broadcasts, status updates or channels.
		if (!lib.isPnUser(remote) && !lib.isLidUser(remote)) return;
		const conversation = await this.canonical(remote, m.key.remoteJidAlt);
		const content = lib.normalizeMessageContent(m.message);
		const at = Number(m.messageTimestamp ?? 0) * 1000 || Date.now();
		const base = { channel: ID, senderId: conversation, senderName: m.pushName ?? undefined, conversation, at };

		const reaction = content?.reactionMessage;
		if (reaction) {
			if (!reaction.text || !reaction.key?.id) return; // an empty text removes a reaction
			await onInbound({
				...base,
				externalId: `${conversation}:${m.key.id}`,
				kind: "reaction",
				text: reaction.text,
				data: reaction.text,
				replyTo: `${conversation}:${reaction.key.id}`,
			});
			return;
		}

		const text = messageText(content);
		if (text === undefined) return;
		const externalId = `${conversation}:${m.key.id}`;
		this.keep(externalId, m);
		const pressed = this.isOwner(conversation) ? this.buttons.match(conversation, text, Date.now()) : undefined;
		if (pressed) {
			await onInbound({
				...base,
				externalId,
				kind: "button",
				text: pressed.button.label,
				data: pressed.button.data,
				replyTo: pressed.messageId,
			});
			return;
		}
		const quoted = content?.extendedTextMessage?.contextInfo?.stanzaId;
		await onInbound({ ...base, externalId, kind: "message", text, replyTo: quoted ? `${conversation}:${quoted}` : undefined });
	}

	/** Prefer the phone-number JID over a LID, so owner ids and conversations stay stable. */
	private async canonical(jid: string, alt: string | undefined): Promise<string> {
		const lib = this.lib;
		if (!lib) return normalizeJid(jid);
		if (lib.isLidUser(jid)) {
			const pn = alt ?? (await this.sock?.signalRepository.lidMapping.getPNForLID(jid).catch(() => null)) ?? undefined;
			if (pn) return lib.jidNormalizedUser(pn);
		}
		return lib.jidNormalizedUser(jid);
	}

	private isOwner(jid: string): boolean {
		return this.owners.includes(jid);
	}

	private keep(externalId: string, m: WAMessage): void {
		this.recent.set(externalId, m);
		if (this.recent.size > RECENT_LIMIT) {
			const oldest = this.recent.keys().next().value;
			if (oldest !== undefined) this.recent.delete(oldest);
		}
	}

	async send(msg: OutboundMessage): Promise<SendResult> {
		const sock = this.sock;
		if (!sock) throw new Error("whatsapp: not connected");
		const jid = normalizeJid(msg.conversation);
		if (!jid.includes("@")) throw new PermanentSendError(`whatsapp: "${msg.conversation}" is not a JID`);
		const buttons = flattenButtons(msg.buttons);
		const quoted = msg.replyTo ? this.quoted(msg.replyTo) : undefined;
		let sent: WAMessage | undefined;
		try {
			sent = await sock.sendMessage(jid, { text: renderWithButtons(msg.text, buttons) }, quoted ? { quoted } : undefined);
		} catch (err) {
			throw classifyWhatsAppError(err);
		}
		const id = sent?.key.id;
		if (!sent || !id) throw new Error("whatsapp: send returned no message id");
		const externalId = `${jid}:${id}`;
		this.keep(externalId, sent);
		this.buttons.remember(jid, buttons, externalId, Date.now());
		return { externalId };
	}

	private quoted(ref: string): WAMessage | undefined {
		const known = this.recent.get(ref);
		if (known) return known;
		const at = ref.lastIndexOf(":");
		if (at <= 0) return undefined;
		return { key: { remoteJid: ref.slice(0, at), id: ref.slice(at + 1), fromMe: false }, message: { conversation: "" } };
	}

	setOwner(senderId: string): void {
		const jid = normalizeJid(senderId);
		if (!this.owners.includes(jid)) this.owners = [...this.owners, jid];
	}

	ownerConversation(): string | undefined {
		return this.owners[0];
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.reconnectTimer);
		const sock = this.sock;
		this.sock = undefined;
		// end() closes the socket without logging the device out.
		sock?.end(undefined);
	}
}

/** `+92 300 1234567`, `923001234567` or a JID with a device suffix → `923001234567@s.whatsapp.net`. */
export function normalizeJid(id: string): string {
	const trimmed = id.trim();
	if (!trimmed.includes("@")) {
		const digits = trimmed.replace(/[^\d]/g, "");
		return digits ? `${digits}@s.whatsapp.net` : trimmed;
	}
	const [user, server] = trimmed.split("@");
	return `${user.split(":")[0]}@${server}`;
}

/** Baileys errors are Boom errors; 4xx other than 408/429 will not get better by retrying. */
export function classifyWhatsAppError(err: unknown): Error {
	if (err instanceof PermanentSendError) return err;
	const status = (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
	const msg = errorText(err);
	if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429 && status !== 401) {
		return new PermanentSendError(`whatsapp ${status}: ${msg}`);
	}
	return err instanceof Error ? err : new Error(msg);
}

function printQr(qr: string): void {
	qrcode.generate(qr, { small: true }, (art) => process.stderr.write(`${art}\n`));
}

type BaileysLogger = NonNullable<Parameters<Baileys["makeWASocket"]>[0]["logger"]>;

/** Baileys logs a lot; keep only errors, one line each. */
function quietLogger(log: Log): BaileysLogger {
	const logger: BaileysLogger = {
		level: "error",
		child: () => logger,
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: (obj: unknown, msg?: string) => {
			log(`whatsapp: ${(msg ?? describe(obj)).slice(0, 300)}`);
		},
	};
	return logger;
}

function describe(obj: unknown): string {
	if (obj instanceof Error) return obj.message;
	if (typeof obj === "string") return obj;
	try {
		return JSON.stringify(obj);
	} catch {
		return String(obj);
	}
}
