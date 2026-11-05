// Unit tests for the outbox with a fake channel: ordering per order key, blocking attempts,
// permanent errors, a missing channel, split() and message refs.

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Channel, InboundMessage, OutboundMessage, SendResult } from "../src/channels/types.ts";
import { PermanentSendError } from "../src/channels/types.ts";
import type { ChannelId } from "../src/config.ts";
import { BLOCKING_ATTEMPTS, Outbox, split } from "../src/core/outbox.ts";
import { ManualClock } from "../src/core/time.ts";
import { Db } from "../src/store/db.ts";

/** A channel whose sends can be scripted to fail per text. */
class FakeChannel implements Channel {
	readonly id: ChannelId;
	sent: (OutboundMessage & { externalId: string })[] = [];
	attempts: string[] = [];
	/** text -> how to fail: a number of transient failures left, or "permanent". */
	failures = new Map<string, number | "permanent">();
	private seq = 0;
	constructor(id: ChannelId = "telegram") {
		this.id = id;
	}
	async start(_on: (m: InboundMessage) => Promise<void>): Promise<void> {}
	async send(msg: OutboundMessage): Promise<SendResult> {
		this.attempts.push(msg.text);
		const f = this.failures.get(msg.text);
		if (f === "permanent") throw new PermanentSendError("chat not found");
		if (typeof f === "number" && f > 0) {
			this.failures.set(msg.text, f - 1);
			throw new Error("ETIMEDOUT");
		}
		const externalId = `${this.id}:${++this.seq}`;
		this.sent.push({ ...msg, externalId });
		return { externalId };
	}
	ownerConversation(): string {
		return "42";
	}
	async stop(): Promise<void> {}
	texts(): string[] {
		return this.sent.map((m) => m.text);
	}
}

let db: Db;
let clock: ManualClock;
let tg: FakeChannel;
let channels: Map<ChannelId, Channel>;
let outbox: Outbox;

beforeEach(() => {
	db = new Db(":memory:");
	clock = new ManualClock();
	tg = new FakeChannel();
	channels = new Map<ChannelId, Channel>([["telegram", tg]]);
	outbox = new Outbox(db, clock, channels);
});

afterEach(() => db.close());

interface Row {
	id: number;
	status: string;
	attempts: number;
	next_attempt_at: number;
	last_error: string | null;
	external_id: string | null;
	sent_at: number | null;
	order_key: string | null;
	text: string;
	buttons: string | null;
	reply_to: string | null;
}
const row = (id: number) => db.get<Row>("SELECT * FROM outbox WHERE id = ?", id)!;
const send = (text: string, orderKey?: string) => outbox.enqueue({ channel: "telegram", conversation: "42", text, orderKey })[0];

/** Advance to the earliest pending retry and deliver. */
async function retry(): Promise<number> {
	const next = db.get<{ t: number | null }>(
		"SELECT MIN(next_attempt_at) AS t FROM outbox WHERE status IN ('pending', 'failing') AND next_attempt_at > ?",
		clock.now(),
	)!.t;
	if (next !== null) clock.t = next;
	return outbox.deliverDue();
}

describe("enqueue and deliver", () => {
	it("stores first, then sends with conversation, buttons and replyTo", async () => {
		const buttons = [[{ data: "approve:ap_1", label: "Approve" }]];
		const [id] = outbox.enqueue({ channel: "telegram", conversation: "42", text: "hi", buttons, replyTo: "42:9", silent: true });
		expect(row(id).status).toBe("pending");
		expect(tg.sent).toEqual([]);
		expect(await outbox.deliverDue()).toBe(1);
		expect(tg.sent).toEqual([{ conversation: "42", text: "hi", buttons, replyTo: "42:9", silent: true, externalId: "telegram:1" }]);
		expect(row(id)).toMatchObject({ status: "sent", attempts: 1, external_id: "telegram:1", sent_at: clock.now() });
		expect(await outbox.deliverDue()).toBe(0);
		expect(tg.sent).toHaveLength(1);
	});

	it("a message with no extras sends without buttons or replyTo, and not silent", async () => {
		send("plain");
		await outbox.deliverDue();
		expect(tg.sent[0]).toEqual({ conversation: "42", text: "plain", buttons: undefined, replyTo: undefined, silent: false, externalId: "telegram:1" });
	});

	it("sends in id order", async () => {
		send("a");
		send("b");
		send("c");
		await outbox.deliverDue();
		expect(tg.texts()).toEqual(["a", "b", "c"]);
	});

	it("does not run two passes at once", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const slow: Channel = { ...tg, id: "telegram", send: async () => (await gate, { externalId: "x" }) } as Channel;
		const ob = new Outbox(db, clock, new Map<ChannelId, Channel>([["telegram", slow]]));
		send("a");
		const first = ob.deliverDue();
		expect(await ob.deliverDue()).toBe(0);
		release();
		expect(await first).toBe(1);
	});
});

describe("retries and ordering", () => {
	it("a transient failure retries with exponential backoff", async () => {
		tg.failures.set("x", 4);
		const id = send("x");
		const t0 = clock.now();
		await outbox.deliverDue();
		expect(row(id)).toMatchObject({ status: "pending", attempts: 1, next_attempt_at: t0 + 5_000, last_error: "ETIMEDOUT" });
		// Not due yet: nothing happens.
		clock.advance(4_999);
		await outbox.deliverDue();
		expect(row(id).attempts).toBe(1);
		clock.advance(1);
		await outbox.deliverDue();
		expect(row(id)).toMatchObject({ attempts: 2, next_attempt_at: clock.now() + 10_000 });
		await retry();
		expect(row(id)).toMatchObject({ status: "failing", attempts: 3, next_attempt_at: clock.now() + 20_000 });
		expect(outbox.problems().map((p) => p.id)).toEqual([id]);
		await retry();
		expect(row(id)).toMatchObject({ status: "failing", attempts: 4, next_attempt_at: clock.now() + 40_000 });
		await retry();
		expect(row(id)).toMatchObject({ status: "sent", attempts: 5 });
		expect(outbox.problems()).toEqual([]);
	});

	it("backoff is capped at 5 minutes", async () => {
		tg.failures.set("x", 100);
		const id = send("x");
		for (let i = 0; i < 12; i++) await retry();
		const r = row(id);
		expect(r.attempts).toBe(12);
		expect(r.next_attempt_at - clock.now()).toBe(300_000);
	});

	it("messages with the same order key keep their order: a failing earlier one holds later ones", async () => {
		tg.failures.set("first", 1);
		send("first", "tk_1:42");
		send("second", "tk_1:42");
		await outbox.deliverDue();
		expect(tg.sent).toEqual([]);
		expect(tg.attempts).toEqual(["first"]);
		await retry();
		expect(tg.texts()).toEqual(["first", "second"]);
	});

	it(`an earlier message stops holding later ones after ${BLOCKING_ATTEMPTS} failed attempts`, async () => {
		tg.failures.set("stuck", 100);
		const stuck = send("stuck", "k");
		const later = send("later", "k");
		for (let i = 1; i < BLOCKING_ATTEMPTS; i++) {
			await retry();
			expect(row(later).status).toBe("pending");
			expect(tg.attempts.filter((t) => t === "later")).toEqual([]);
		}
		// The BLOCKING_ATTEMPTS-th failure releases the later message in the same pass.
		await retry();
		expect(row(stuck)).toMatchObject({ status: "failing", attempts: BLOCKING_ATTEMPTS });
		expect(row(later).status).toBe("sent");
		expect(tg.texts()).toEqual(["later"]);
	});

	it("held messages of a key go out in order once released, including the third", async () => {
		tg.failures.set("a", 1);
		tg.failures.set("b", 1);
		send("a", "k");
		send("b", "k");
		send("c", "k");
		await retry();
		await retry();
		await retry();
		expect(tg.texts()).toEqual(["a", "b", "c"]);
	});

	it("different order keys and keyless messages are independent", async () => {
		tg.failures.set("k1-a", 100);
		send("k1-a", "k1");
		send("k1-b", "k1");
		send("k2-a", "k2");
		send("free");
		await outbox.deliverDue();
		expect(tg.texts()).toEqual(["k2-a", "free"]);
	});

	it("a PermanentSendError drops the message and does not hold later ones", async () => {
		tg.failures.set("doomed", "permanent");
		const doomed = send("doomed", "k");
		send("next", "k");
		await outbox.deliverDue();
		expect(row(doomed)).toMatchObject({ status: "dropped", last_error: "chat not found" });
		expect(tg.texts()).toEqual(["next"]);
		expect(db.all<{ kind: string }>("SELECT kind FROM events WHERE kind = 'outbox.dropped'")).toHaveLength(1);
		// Never retried.
		clock.advance(3_600_000);
		await outbox.deliverDue();
		expect(tg.attempts.filter((t) => t === "doomed")).toHaveLength(1);
	});

	it("a missing channel waits (no attempt counted) and holds later ones of its key", async () => {
		const id = outbox.enqueue({ channel: "discord", conversation: "dm", text: "d1", orderKey: "dk" })[0];
		const id2 = outbox.enqueue({ channel: "discord", conversation: "dm", text: "d2", orderKey: "dk" })[0];
		await outbox.deliverDue();
		expect(row(id)).toMatchObject({ status: "pending", attempts: 0, last_error: "channel not running", next_attempt_at: clock.now() + 60_000 });
		// Even after many waits the message is kept and still holds back its successor.
		for (let i = 0; i < 10; i++) await retry();
		expect(row(id)).toMatchObject({ status: "pending", attempts: 0 });
		expect(row(id2).status).toBe("pending");
		// The channel comes up: both go out in order.
		const dc = new FakeChannel("discord");
		channels.set("discord", dc);
		await retry();
		expect(dc.texts()).toEqual(["d1", "d2"]);
	});
});

describe("split", () => {
	it("leaves short texts alone", () => {
		expect(split("hello", 10)).toEqual(["hello"]);
		expect(split("x".repeat(10), 10)).toEqual(["x".repeat(10)]);
		expect(split("", 10)).toEqual([""]);
	});

	it("prefers paragraph breaks, then line breaks, then spaces, then a hard cut", () => {
		expect(split("aaaaaa\n\nbbbbbb", 10)).toEqual(["aaaaaa", "bbbbbb"]);
		expect(split("aaaaaa\nbbbbbb", 10)).toEqual(["aaaaaa", "bbbbbb"]);
		expect(split("aaaaaa bbbbbb", 10)).toEqual(["aaaaaa", "bbbbbb"]);
		expect(split("abcdefghijklmnop", 10)).toEqual(["abcdefghij", "klmnop"]);
		// A break too early (before max/2) is not used.
		expect(split("ab cdefghijklmnop", 10)).toEqual(["ab cdefghi", "jklmnop"]);
	});

	it("property: parts fit, are non-empty, keep their order and lose only whitespace at cuts", () => {
		const word = fc.string({ unit: fc.constantFrom(..."abcdefghij"), minLength: 1, maxLength: 30 });
		const sep = fc.constantFrom(" ", "\n", "\n\n");
		const text = fc.array(fc.tuple(word, sep), { minLength: 1, maxLength: 200 }).map((ws) => ws.map(([w, s]) => w + s).join(""));
		fc.assert(
			fc.property(text, fc.integer({ min: 4, max: 400 }), (t, max) => {
				const parts = split(t, max);
				for (const p of parts) {
					expect(p.length).toBeLessThanOrEqual(max);
					expect(p.length).toBeGreaterThan(0);
				}
				expect(parts.join("").replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
				if (t.length <= max) expect(parts).toEqual([t]);
			}),
		);
	});

	it("a long text is enqueued as ordered parts: replyTo on the first, buttons on the last", async () => {
		const paras = Array.from({ length: 6 }, (_, i) => `${String(i)}${"y".repeat(1500)}`);
		const buttons = [[{ data: "x", label: "X" }]];
		const ids = outbox.enqueue({ channel: "telegram", conversation: "42", text: paras.join("\n\n"), buttons, replyTo: "42:1" });
		expect(ids.length).toBeGreaterThan(1);
		const rows = ids.map(row);
		expect(new Set(rows.map((r) => r.order_key)).size).toBe(1);
		expect(rows[0].order_key).toMatch(/^split:/);
		expect(rows[0].reply_to).toBe("42:1");
		expect(rows.slice(1).every((r) => r.reply_to === null)).toBe(true);
		expect(rows.at(-1)!.buttons).toBe(JSON.stringify(buttons));
		expect(rows.slice(0, -1).every((r) => r.buttons === null)).toBe(true);

		// The first part fails once: later parts wait for it, so the order is kept.
		tg.failures.set(rows[0].text, 1);
		await outbox.deliverDue();
		expect(tg.sent).toEqual([]);
		await retry();
		expect(tg.texts()).toEqual(rows.map((r) => r.text));
		expect(tg.texts().join("").replace(/\s/g, "")).toBe(paras.join("").replace(/\s/g, ""));
	});

	it("parts of two long texts get different order keys", () => {
		const long = "z ".repeat(4000);
		const a = outbox.enqueue({ channel: "telegram", conversation: "42", text: long });
		const b = outbox.enqueue({ channel: "telegram", conversation: "42", text: long });
		expect(row(a[0]).order_key).not.toBe(row(b[0]).order_key);
	});

	it("an explicit order key is used for split parts", () => {
		const ids = outbox.enqueue({ channel: "telegram", conversation: "42", text: "z ".repeat(4000), orderKey: "tk_9" });
		expect(ids.map((i) => row(i).order_key)).toEqual(ids.map(() => "tk_9"));
	});
});

describe("message refs", () => {
	it("records what a sent message was about, for lookupRef", async () => {
		outbox.enqueue({ channel: "telegram", conversation: "42", text: "Approve?", ref: { kind: "approval", id: "ap_1" } });
		outbox.enqueue({ channel: "telegram", conversation: "42", text: "no ref" });
		await outbox.deliverDue();
		expect(outbox.lookupRef("telegram", "telegram:1")).toEqual({ kind: "approval", id: "ap_1" });
		expect(outbox.lookupRef("telegram", "telegram:2")).toBeUndefined();
		expect(outbox.lookupRef("discord", "telegram:1")).toBeUndefined();
		expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message_refs")!.n).toBe(1);
	});

	it("every part of a split message carries the ref", async () => {
		const ids = outbox.enqueue({ channel: "telegram", conversation: "42", text: "w ".repeat(4000), ref: { kind: "ticket", id: "tk_1" } });
		await outbox.deliverDue();
		for (const m of tg.sent) expect(outbox.lookupRef("telegram", m.externalId)).toEqual({ kind: "ticket", id: "tk_1" });
		expect(tg.sent).toHaveLength(ids.length);
	});

	it("no ref is recorded for a message that was not sent", async () => {
		tg.failures.set("x", "permanent");
		outbox.enqueue({ channel: "telegram", conversation: "42", text: "x", ref: { kind: "notice", id: "n_1" } });
		await outbox.deliverDue();
		expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message_refs")!.n).toBe(0);
	});
});

describe("the daemon lock during a pass", () => {
	it("F2d: losing the lock mid-pass stops the rest of the snapshot", async () => {
		let holds = true;
		outbox.mayDeliver = () => holds;
		const orig = tg.send.bind(tg);
		tg.send = async (m) => {
			const r = await orig(m);
			holds = false; // another daemon took the lock while this send was in flight
			return r;
		};
		outbox.enqueue({ channel: "telegram", conversation: "42", text: "one" });
		outbox.enqueue({ channel: "telegram", conversation: "43", text: "two" });
		await outbox.deliverDue();
		expect(tg.sent.map((m) => m.text)).toEqual(["one"]);
	});
});

describe("retry backoff", () => {
	it("F3: the backoff counts from when a slow send ended, so its retry is not already due", async () => {
		const orig = tg.send.bind(tg);
		tg.send = async (m) => {
			clock.advance(10_000); // the send takes 10 s, longer than the first 5 s backoff
			throw new Error("ETIMEDOUT");
		};
		outbox.enqueue({ channel: "telegram", conversation: "42", text: "one" });
		await outbox.deliverDue();
		tg.send = orig;
		const row = db.get<{ next_attempt_at: number }>("SELECT next_attempt_at FROM outbox")!;
		expect(row.next_attempt_at).toBeGreaterThan(clock.now());
	});
});
