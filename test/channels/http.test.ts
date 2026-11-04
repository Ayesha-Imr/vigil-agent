// Tests for the HTTP channel on a real ephemeral port: token auth, message/reply correlation
// (including split replies and timeouts), signed button presses and extra routes.

import { afterEach, describe, expect, it } from "vitest";
import { HttpChannel, safeEqual, signButton } from "../../src/channels/http.ts";
import type { InboundMessage } from "../../src/channels/types.ts";

const TOKEN = "s3cret-token";
const open: HttpChannel[] = [];

afterEach(async () => {
	await Promise.all(open.splice(0).map((c) => c.stop()));
});

async function startChannel(
	onInbound: (msg: InboundMessage, ch: HttpChannel) => Promise<void> = async () => {},
	opts: { token?: string; replyTimeoutMs?: number } = { token: TOKEN },
): Promise<{ ch: HttpChannel; base: string; inbound: InboundMessage[] }> {
	const inbound: InboundMessage[] = [];
	const ch = new HttpChannel({
		port: 0,
		token: opts.token,
		replyTimeoutMs: opts.replyTimeoutMs,
		log: () => {},
		handlers: { "GET /panel": () => ({ body: "<h1>panel</h1>", headers: { "content-type": "text/html" } }) },
	});
	open.push(ch);
	await ch.start(async (msg) => {
		inbound.push(msg);
		await onInbound(msg, ch);
	});
	return { ch, base: `http://127.0.0.1:${ch.port()}`, inbound };
}

function post(url: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});
}

describe("auth", () => {
	it("rejects missing and wrong tokens", async () => {
		const { base, inbound } = await startChannel();
		expect((await post(`${base}/api/message`, { text: "hi" }, null)).status).toBe(401);
		expect((await post(`${base}/api/message`, { text: "hi" }, "wrong")).status).toBe(401);
		expect((await post(`${base}/api/message`, { text: "hi" }, `${TOKEN}x`)).status).toBe(401);
		expect(inbound).toHaveLength(0);
	});

	it("refuses everything when no token is configured", async () => {
		const { base } = await startChannel(async () => {}, { token: undefined });
		expect((await post(`${base}/api/message`, { text: "hi" }, "")).status).toBe(503);
		expect((await fetch(`${base}/panel?token=`)).status).toBe(503);
	});

	it("accepts ?token= and serves extra routes", async () => {
		const { base } = await startChannel();
		const res = await fetch(`${base}/panel?token=${TOKEN}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html");
		expect(await res.text()).toBe("<h1>panel</h1>");
		expect((await fetch(`${base}/nope?token=${TOKEN}`)).status).toBe(404);
		expect((await fetch(`${base}/api/message?token=${TOKEN}`)).status).toBe(405);
	});

	it("binds to localhost only by default", async () => {
		const { ch } = await startChannel();
		const addr = (ch.server as unknown as { server: { address(): { address: string } } }).server.address();
		expect(addr.address).toBe("127.0.0.1");
	});

	it("compares tokens exactly", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("ab", "abc")).toBe(false);
	});
});

describe("POST /api/message", () => {
	it("emits a message and answers with the reply sent to it", async () => {
		const { base, inbound } = await startChannel(async (msg, ch) => {
			// The core replies a bit later, asynchronously, as the outbox would.
			setTimeout(() => {
				void ch.send({ conversation: "http", text: "unrelated", replyTo: "http:someone-else" });
				void ch.send({ conversation: "http", text: `you said: ${msg.text}`, replyTo: msg.externalId });
			}, 20);
		});
		const res = await post(`${base}/api/message`, { text: "hello" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { reply: string; id: string };
		expect(body.reply).toBe("you said: hello");
		expect(inbound).toHaveLength(1);
		expect(inbound[0]).toMatchObject({ channel: "http", kind: "message", senderId: "owner", conversation: "http", text: "hello" });
		expect(body.id).toBe(inbound[0].externalId);
	});

	it("keeps concurrent requests apart", async () => {
		const { base } = await startChannel(async (msg, ch) => {
			const delay = msg.text === "first" ? 60 : 10;
			setTimeout(() => void ch.send({ conversation: "http", text: `re ${msg.text}`, replyTo: msg.externalId }), delay);
		});
		const [a, b] = await Promise.all([post(`${base}/api/message`, { text: "first" }), post(`${base}/api/message`, { text: "second" })]);
		expect(((await a.json()) as { reply: string }).reply).toBe("re first");
		expect(((await b.json()) as { reply: string }).reply).toBe("re second");
	});

	it("joins the parts of a split reply and returns buttons", async () => {
		const { base } = await startChannel(async (msg, ch) => {
			setTimeout(async () => {
				await ch.send({ conversation: "http", text: "part one", replyTo: msg.externalId });
				// The outbox keeps replyTo on every part of an HTTP reply.
				await ch.send({ conversation: "http", text: "part two", buttons: [[{ label: "OK", data: "ok" }]], replyTo: msg.externalId });
			}, 10);
		});
		const body = (await (await post(`${base}/api/message`, { text: "long please" })).json()) as { reply: string; buttons: unknown };
		expect(body.reply).toBe("part one\n\npart two");
		expect(body.buttons).toEqual([[{ label: "OK", data: "ok" }]]);
	});

	it("times out with 504 when no reply comes", async () => {
		const { base } = await startChannel(async () => {}, { token: TOKEN, replyTimeoutMs: 50 });
		const res = await post(`${base}/api/message`, { text: "anyone?" });
		expect(res.status).toBe(504);
	});

	it("returns 202 at once with wait=false, and 400 without text", async () => {
		const { base, inbound } = await startChannel();
		const res = await post(`${base}/api/message`, { text: "fire and forget", wait: false });
		expect(res.status).toBe(202);
		expect(inbound).toHaveLength(1);
		expect((await post(`${base}/api/message`, {})).status).toBe(400);
		const bad = await fetch(`${base}/api/message`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: "{not json",
		});
		expect(bad.status).toBe(400);
	});

	it("answers 500 when the core fails to take the message", async () => {
		const { base } = await startChannel(async () => {
			throw new Error("db locked");
		});
		expect((await post(`${base}/api/message`, { text: "x" })).status).toBe(500);
	});
});

describe("POST /api/button", () => {
	it("emits a button press with the token", async () => {
		const { base, inbound } = await startChannel();
		const res = await post(`${base}/api/button`, { data: "approve:ap_1" });
		expect(res.status).toBe(202);
		expect(inbound[0]).toMatchObject({ kind: "button", data: "approve:ap_1", conversation: "http" });
	});

	it("accepts a per-button signature instead of the token, for that button only", async () => {
		const { base, inbound } = await startChannel();
		const sig = signButton(TOKEN, "approve:ap_1");
		const ok = await fetch(`${base}/api/button?data=${encodeURIComponent("approve:ap_1")}&sig=${sig}`, { method: "POST" });
		expect(ok.status).toBe(202);
		const other = await fetch(`${base}/api/button?data=${encodeURIComponent("approve:ap_2")}&sig=${sig}`, { method: "POST" });
		expect(other.status).toBe(401);
		// A signature does not open other routes.
		const msg = await fetch(`${base}/api/message?data=${encodeURIComponent("approve:ap_1")}&sig=${sig}&text=hi`, { method: "POST" });
		expect(msg.status).toBe(401);
		expect(inbound.map((m) => m.data)).toEqual(["approve:ap_1"]);
	});
});
