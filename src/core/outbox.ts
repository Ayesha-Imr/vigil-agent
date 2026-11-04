// The outbox: every outbound message is stored first and sent afterwards, with retries.
// Messages that share an order key (one ticket, one conversation) go out in the order queued.

import type { Button, Channel } from "../channels/types.ts";
import { PermanentSendError } from "../channels/types.ts";
import type { ChannelId } from "../config.ts";
import type { Db } from "../store/db.ts";
import type { Clock } from "./time.ts";

export interface OutboxItem {
	channel: ChannelId;
	conversation: string;
	text: string;
	buttons?: Button[][];
	replyTo?: string;
	/** What this message is about, so replies and reactions to it can be routed back. */
	ref?: { kind: "ticket" | "notice" | "attention" | "approval" | "digest" | "reply"; id: string };
	/** Messages with the same key keep their order. */
	orderKey?: string;
	/** Deliver without sound where the app supports it. */
	silent?: boolean;
}

interface OutboxRow {
	id: number;
	channel: ChannelId;
	conversation: string;
	text: string;
	buttons: string | null;
	reply_to: string | null;
	ref_kind: string | null;
	ref_id: string | null;
	order_key: string | null;
	status: string;
	attempts: number;
	silent: number;
}

/** After this many failed attempts a message stops holding back later ones with its order key. */
export const BLOCKING_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 300_000;
const MAX_LENGTH = 3800;

export class Outbox {
	private readonly db: Db;
	private readonly clock: Clock;
	private readonly channels: Map<ChannelId, Channel>;
	private running = false;

	constructor(db: Db, clock: Clock, channels: Map<ChannelId, Channel>) {
		this.db = db;
		this.clock = clock;
		this.channels = channels;
	}

	/** Store a message for sending. Long texts are split into ordered parts. */
	enqueue(item: OutboxItem): number[] {
		const now = this.clock.now();
		const parts = split(item.text, MAX_LENGTH);
		const orderKey = item.orderKey ?? (parts.length > 1 ? `split:${now}:${Math.random()}` : null);
		return this.db.tx(() =>
			parts.map((text, i) => {
				const last = i === parts.length - 1;
				return this.db.run(
					`INSERT INTO outbox (channel, conversation, text, buttons, reply_to, ref_kind, ref_id, order_key, next_attempt_at, created_at, silent)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					item.channel,
					item.conversation,
					text,
					last && item.buttons ? JSON.stringify(item.buttons) : null,
					i === 0 ? (item.replyTo ?? null) : null,
					item.ref?.kind ?? null,
					item.ref?.id ?? null,
					orderKey,
					now,
					now,
					item.silent ? 1 : 0,
				).lastInsertRowid;
			}),
		);
	}

	/** Send every message that is due. Runs one pass at a time, so nothing is sent twice by us. */
	async deliverDue(): Promise<number> {
		if (this.running) return 0;
		this.running = true;
		let sent = 0;
		try {
			const due = this.db.all<OutboxRow>(
				"SELECT * FROM outbox WHERE status IN ('pending', 'failing') AND next_attempt_at <= ? ORDER BY id",
				this.clock.now(),
			);
			for (const row of due) {
				if (this.heldBack(row)) continue;
				if (await this.sendOne(row)) sent++;
			}
		} finally {
			this.running = false;
		}
		return sent;
	}

	private heldBack(row: OutboxRow): boolean {
		if (!row.order_key) return false;
		const earlier = this.db.get<{ n: number }>(
			`SELECT COUNT(*) AS n FROM outbox WHERE order_key = ? AND id < ? AND status IN ('pending', 'failing') AND attempts < ?`,
			row.order_key,
			row.id,
			BLOCKING_ATTEMPTS,
		);
		return (earlier?.n ?? 0) > 0;
	}

	private async sendOne(row: OutboxRow): Promise<boolean> {
		const channel = this.channels.get(row.channel);
		const now = this.clock.now();
		if (!channel) {
			// The channel is off: wait, as dsh-superagent does, rather than drop.
			this.db.run("UPDATE outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?", now + 60_000, "channel not running", row.id);
			return false;
		}
		try {
			const res = await channel.send({
				conversation: row.conversation,
				text: row.text,
				buttons: row.buttons ? (JSON.parse(row.buttons) as Button[][]) : undefined,
				replyTo: row.reply_to ?? undefined,
				silent: row.silent === 1,
			});
			const at = this.clock.now();
			this.db.tx(() => {
				this.db.run("UPDATE outbox SET status = 'sent', sent_at = ?, external_id = ?, attempts = attempts + 1 WHERE id = ?", at, res.externalId, row.id);
				if (row.ref_kind && row.ref_id) {
					this.db.run(
						"INSERT OR REPLACE INTO message_refs (channel, external_id, ref_kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)",
						row.channel,
						res.externalId,
						row.ref_kind,
						row.ref_id,
						at,
					);
				}
			});
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (err instanceof PermanentSendError) {
				this.db.run("UPDATE outbox SET status = 'dropped', last_error = ? WHERE id = ?", message, row.id);
				this.db.event("outbox.dropped", `dropped message to ${row.channel}: ${message}`, { id: row.id });
				return false;
			}
			const attempts = row.attempts + 1;
			const backoff = Math.min(5_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
			this.db.run(
				"UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
				attempts >= BLOCKING_ATTEMPTS ? "failing" : "pending",
				attempts,
				now + backoff,
				message,
				row.id,
			);
			return false;
		}
	}

	/** Find what a sent message was about, for routing a reply or reaction to it. */
	lookupRef(channel: ChannelId, externalId: string): { kind: string; id: string } | undefined {
		const row = this.db.get<{ ref_kind: string; ref_id: string }>(
			"SELECT ref_kind, ref_id FROM message_refs WHERE channel = ? AND external_id = ?",
			channel,
			externalId,
		);
		return row ? { kind: row.ref_kind, id: row.ref_id } : undefined;
	}

	problems(): { id: number; channel: string; attempts: number; last_error: string | null; text: string }[] {
		return this.db.all("SELECT id, channel, attempts, last_error, text FROM outbox WHERE status = 'failing' ORDER BY id");
	}
}

/** Split text into parts of at most `max` chars, preferring paragraph and line breaks. */
export function split(text: string, max: number): string[] {
	if (text.length <= max) return [text];
	const parts: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n\n", max);
		if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
		if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
		if (cut < max / 2) cut = max;
		parts.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) parts.push(rest);
	return parts;
}
