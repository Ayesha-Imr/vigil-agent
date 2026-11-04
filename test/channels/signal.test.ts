// Unit tests for the Signal channel's pure parts: SSE parsing, envelope → InboundMessage mapping,
// numbered buttons, number normalization and error classification. No network, no signal-cli.

import { describe, expect, it } from "vitest";
import {
	checkSendResults,
	classifySignalError,
	fromSignalEnvelope,
	normalizeSignalId,
	parseSignalEvent,
	parseSignalRef,
	type SignalEnvelope,
	SignalRpcError,
	SseParser,
} from "../../src/channels/signal.ts";
import { PermanentSendError } from "../../src/channels/types.ts";
import { ButtonMemory, renderWithButtons } from "../../src/channels/util.ts";

const owner = "+923001234567";
const env = (dataMessage: SignalEnvelope["dataMessage"], over: Partial<SignalEnvelope> = {}): SignalEnvelope => ({
	source: owner,
	sourceNumber: owner,
	sourceUuid: "0b5f1c4e-1111-2222-3333-444455556666",
	sourceName: "Ayesha",
	timestamp: 1730000000123,
	dataMessage,
	...over,
});

describe("SseParser", () => {
	it("parses events split across chunks, multi-line data and comments", () => {
		const p = new SseParser();
		expect(p.push(": keep-alive\n\nevent: rec")).toEqual([]);
		expect(p.push('eive\ndata: {"a":\ndata: 1}\nid: 7\n\n')).toEqual([{ event: "receive", data: '{"a":\n1}', id: "7" }]);
		expect(p.push("data:x\r\n\r\ndata: y\r")).toEqual([{ event: "message", data: "x", id: "7" }]);
		expect(p.push("\n\r\n")).toEqual([{ event: "message", data: "y", id: "7" }]);
	});

	it("ignores events without data", () => {
		const p = new SseParser();
		expect(p.push("event: ping\n\n")).toEqual([]);
		expect(p.push("data: z\n\n")).toEqual([{ event: "message", data: "z", id: undefined }]);
	});
});

describe("parseSignalEvent", () => {
	it("reads signal-cli's receive params and whole JSON-RPC notifications", () => {
		const e = { source: owner, timestamp: 1 };
		expect(parseSignalEvent(JSON.stringify({ envelope: e, account: "+15551234567" }))).toEqual({ envelope: e, account: "+15551234567" });
		expect(parseSignalEvent(JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope: e } }))).toEqual({ envelope: e, account: undefined });
		expect(parseSignalEvent("not json")).toBeUndefined();
		expect(parseSignalEvent('{"foo":1}')).toBeUndefined();
	});
});

describe("fromSignalEnvelope", () => {
	it("maps a direct message keyed source:timestamp", () => {
		expect(fromSignalEnvelope(env({ timestamp: 1730000000123, message: "hi" }))).toEqual({
			channel: "signal",
			externalId: `${owner}:1730000000123`,
			senderId: owner,
			senderName: "Ayesha",
			conversation: owner,
			at: 1730000000123,
			kind: "message",
			text: "hi",
			replyTo: undefined,
			attachments: undefined,
		});
	});

	it("routes a quote reply to the quoted message", () => {
		expect(fromSignalEnvelope(env({ timestamp: 5, message: "yes", quote: { id: 1730000000000, author: "+15551234567" } }))?.replyTo).toBe(`${owner}:1730000000000`);
	});

	it("maps a reaction with replyTo sender:targetSentTimestamp and drops removals", () => {
		const reaction = { emoji: "👎", targetAuthor: "+15551234567", targetSentTimestamp: 1729999999999, isRemove: false };
		expect(fromSignalEnvelope(env({ timestamp: 9, reaction }))).toMatchObject({
			kind: "reaction",
			text: "👎",
			data: "👎",
			replyTo: `${owner}:1729999999999`,
			externalId: `${owner}:9`,
		});
		expect(fromSignalEnvelope(env({ timestamp: 9, reaction: { ...reaction, isRemove: true } }))).toBeUndefined();
	});

	it("lists attachments with a sender:id ref", () => {
		const msg = fromSignalEnvelope(env({ timestamp: 3, message: null, attachments: [{ id: "abc.jpg", contentType: "image/jpeg", filename: null }, { id: "r.pdf", contentType: "application/pdf", filename: "r.pdf" }] }));
		expect(msg?.text).toBe("[photo attached]\n[document attached: r.pdf]");
		expect(msg?.attachments).toEqual([
			{ kind: "photo", ref: `${owner}:abc.jpg`, name: undefined, mimeType: "image/jpeg" },
			{ kind: "document", ref: `${owner}:r.pdf`, name: "r.pdf", mimeType: "application/pdf" },
		]);
	});

	it("drops groups, receipts, typing and empty messages; falls back to the UUID", () => {
		expect(fromSignalEnvelope(env({ timestamp: 1, message: "hi", groupInfo: { groupId: "g" } }))).toBeUndefined();
		expect(fromSignalEnvelope(env({ timestamp: 1, message: "hi", groupV2: { id: "g" } }))).toBeUndefined();
		expect(fromSignalEnvelope(env(null))).toBeUndefined();
		expect(fromSignalEnvelope(env({ timestamp: 1, message: "" }))).toBeUndefined();
		const uuid = fromSignalEnvelope(env({ timestamp: 1, message: "hi" }, { source: null, sourceNumber: null, sourceUuid: "0B5F1C4E-1111-2222-3333-444455556666" }));
		expect(uuid?.senderId).toBe("0b5f1c4e-1111-2222-3333-444455556666");
	});
});

describe("numbered buttons", () => {
	const buttons = [
		{ label: "Approve", data: "answer:at_1:0" },
		{ label: "Deny", data: "answer:at_1:1" },
	];

	it("renders choices and maps a bare digit within the window to the button", () => {
		expect(renderWithButtons("Run it?", buttons)).toBe("Run it?\n\nReply 1 to Approve, 2 to Deny");
		const mem = new ButtonMemory();
		mem.remember(owner, buttons, `${owner}:1730000000000`, 0);
		expect(mem.match(owner, "hello", 1)).toBeUndefined();
		expect(mem.match(owner, "2", 1)).toEqual({ button: buttons[1], messageId: `${owner}:1730000000000` });
		expect(mem.match(owner, "2", 2)).toBeUndefined();
		mem.remember(owner, buttons, "m", 0);
		expect(mem.match(owner, "1", 30 * 60_000 + 1)).toBeUndefined();
	});
});

describe("normalizeSignalId / parseSignalRef", () => {
	it("normalizes numbers to E.164 and UUIDs to lowercase", () => {
		expect(normalizeSignalId("+92 300 123-4567")).toBe(owner);
		expect(normalizeSignalId("923001234567")).toBe(owner);
		expect(normalizeSignalId("0B5F1C4E-1111-2222-3333-444455556666")).toBe("0b5f1c4e-1111-2222-3333-444455556666");
	});

	it("parses conversation:timestamp", () => {
		expect(parseSignalRef(`${owner}:1730000000000`)).toEqual({ conversation: owner, timestamp: 1730000000000 });
		expect(parseSignalRef("nope")).toBeUndefined();
		expect(parseSignalRef(`${owner}:abc`)).toBeUndefined();
	});
});

describe("send errors", () => {
	it("checks per-recipient results", () => {
		expect(() => checkSendResults([{ type: "SUCCESS" }])).not.toThrow();
		expect(() => checkSendResults(undefined)).not.toThrow();
		expect(() => checkSendResults([{ type: "UNREGISTERED_FAILURE" }])).toThrow(PermanentSendError);
		expect(() => checkSendResults([{ type: "IDENTITY_FAILURE" }])).toThrow(PermanentSendError);
		let err: unknown;
		try {
			checkSendResults([{ type: "NETWORK_FAILURE" }]);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(PermanentSendError);
	});

	it("classifies JSON-RPC and HTTP failures", () => {
		expect(classifySignalError(new SignalRpcError(-32602, "Invalid params"))).toBeInstanceOf(PermanentSendError);
		expect(classifySignalError(new SignalRpcError(-1, "Unregistered user \"+1555\""))).toBeInstanceOf(PermanentSendError);
		expect(classifySignalError(new SignalRpcError(-5, "Rate limit exceeded: 413"))).not.toBeInstanceOf(PermanentSendError);
		expect(classifySignalError(new SignalRpcError(-3, "Failed to send message: IOException"))).not.toBeInstanceOf(PermanentSendError);
		expect(classifySignalError(Object.assign(new Error("bad"), { status: 400 }))).toBeInstanceOf(PermanentSendError);
		expect(classifySignalError(Object.assign(new Error("down"), { status: 503 }))).not.toBeInstanceOf(PermanentSendError);
		expect(classifySignalError(new TypeError("fetch failed"))).not.toBeInstanceOf(PermanentSendError);
	});
});
