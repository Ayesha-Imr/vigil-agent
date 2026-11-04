// Unit tests for the WhatsApp channel's pure parts: numbered-button rendering, digit replies,
// JID normalization, message text extraction and error classification. No network.

import { describe, expect, it } from "vitest";
import { PermanentSendError } from "../../src/channels/types.ts";
import {
	BUTTON_REPLY_WINDOW_MS,
	ButtonMemory,
	classifyWhatsAppError,
	messageText,
	normalizeJid,
	renderWithButtons,
} from "../../src/channels/whatsapp.ts";

const approveDeny = [
	{ label: "Approve", data: "approve:ap_1" },
	{ label: "Deny", data: "deny:ap_1" },
];
const jid = "923001234567@s.whatsapp.net";

describe("renderWithButtons", () => {
	it("appends a numbered list", () => {
		expect(renderWithButtons("Run rm -rf build?", approveDeny)).toBe("Run rm -rf build?\n\nReply 1 to Approve, 2 to Deny");
	});
	it("leaves text without buttons alone", () => {
		expect(renderWithButtons("hi", [])).toBe("hi");
	});
});

describe("ButtonMemory", () => {
	it("maps a bare digit to the button and uses it up", () => {
		const mem = new ButtonMemory();
		mem.remember(jid, approveDeny, `${jid}:MSG1`, 1_000);
		expect(mem.match(jid, " 2 ", 2_000)).toEqual({ button: approveDeny[1], messageId: `${jid}:MSG1` });
		expect(mem.match(jid, "2", 3_000)).toBeUndefined();
	});

	it("accepts '1.' and ignores other text", () => {
		const mem = new ButtonMemory();
		mem.remember(jid, approveDeny, "m", 0);
		expect(mem.match(jid, "1 please", 1)).toBeUndefined();
		expect(mem.match(jid, "12", 1)).toBeUndefined();
		expect(mem.match(jid, "0", 1)).toBeUndefined();
		expect(mem.match(jid, "1.", 1)?.button.data).toBe("approve:ap_1");
	});

	it("only applies to the conversation the buttons went to", () => {
		const mem = new ButtonMemory();
		mem.remember(jid, approveDeny, "m", 0);
		expect(mem.match("111@s.whatsapp.net", "1", 1)).toBeUndefined();
	});

	it("expires after the window", () => {
		const mem = new ButtonMemory();
		mem.remember(jid, approveDeny, "m", 0);
		expect(mem.match(jid, "1", BUTTON_REPLY_WINDOW_MS + 1)).toBeUndefined();
		const mem2 = new ButtonMemory();
		mem2.remember(jid, approveDeny, "m", 0);
		expect(mem2.match(jid, "1", BUTTON_REPLY_WINDOW_MS)?.button.label).toBe("Approve");
	});

	it("keeps only the latest buttons per conversation", () => {
		const mem = new ButtonMemory();
		mem.remember(jid, approveDeny, "old", 0);
		mem.remember(jid, [{ label: "Snooze", data: "snooze" }], "new", 10);
		expect(mem.match(jid, "2", 20)).toBeUndefined();
		expect(mem.match(jid, "1", 20)).toEqual({ button: { label: "Snooze", data: "snooze" }, messageId: "new" });
	});

	it("does not remember an empty button list", () => {
		const mem = new ButtonMemory();
		mem.remember(jid, approveDeny, "m", 0);
		mem.remember(jid, [], "plain", 1);
		expect(mem.match(jid, "1", 2)?.messageId).toBe("m");
	});
});

describe("normalizeJid", () => {
	it("turns phone numbers into user JIDs and drops device suffixes", () => {
		expect(normalizeJid("+92 300 1234567")).toBe(jid);
		expect(normalizeJid("923001234567:12@s.whatsapp.net")).toBe(jid);
		expect(normalizeJid(jid)).toBe(jid);
		expect(normalizeJid("12345@lid")).toBe("12345@lid");
	});
});

describe("messageText", () => {
	it("reads plain, extended and media captions", () => {
		expect(messageText({ conversation: "hi" })).toBe("hi");
		expect(messageText({ extendedTextMessage: { text: "quoted reply" } })).toBe("quoted reply");
		expect(messageText({ imageMessage: { caption: "look" } })).toBe("look\n[photo attached]");
		expect(messageText({ documentMessage: { fileName: "a.pdf" } })).toBe("[document attached: a.pdf]");
		expect(messageText({ reactionMessage: { text: "👍" } })).toBeUndefined();
		expect(messageText(undefined)).toBeUndefined();
	});
});

describe("classifyWhatsAppError", () => {
	const boom = (statusCode: number) => Object.assign(new Error(`status ${statusCode}`), { output: { statusCode } });
	it("treats most 4xx as permanent and the rest as retryable", () => {
		expect(classifyWhatsAppError(boom(404))).toBeInstanceOf(PermanentSendError);
		expect(classifyWhatsAppError(boom(429))).not.toBeInstanceOf(PermanentSendError);
		expect(classifyWhatsAppError(boom(408))).not.toBeInstanceOf(PermanentSendError);
		expect(classifyWhatsAppError(boom(500))).not.toBeInstanceOf(PermanentSendError);
		expect(classifyWhatsAppError(new Error("Connection Closed"))).not.toBeInstanceOf(PermanentSendError);
	});
});
