// Tests for mapping Telegram updates to InboundMessages, without talking to Telegram.

import type { CallbackQuery, Message, MessageReactionUpdated } from "grammy/types";
import { describe, expect, it } from "vitest";
import { fromCallback, fromMessage, fromReaction, parseRef } from "../../src/channels/telegram.ts";

const owner = { id: 42, is_bot: false, first_name: "Ada", last_name: "L" };
const chat = { id: 42, type: "private" as const, first_name: "Ada" };

describe("fromMessage", () => {
	it("maps text with a reply", () => {
		const reply = { message_id: 7, date: 1, chat, text: "earlier" } as Message;
		const msg = fromMessage({ message_id: 9, date: 1_700_000_000, chat, from: owner, text: "yes", reply_to_message: reply } as Message);
		expect(msg).toEqual({
			channel: "telegram",
			externalId: "42:9",
			senderId: "42",
			senderName: "Ada L",
			conversation: "42",
			kind: "message",
			text: "yes",
			replyTo: "42:7",
			at: 1_700_000_000_000,
		});
	});

	it("notes photos and documents", () => {
		const photo = fromMessage({ message_id: 1, date: 1, chat, from: owner, caption: "look", photo: [] } as unknown as Message);
		expect(photo?.text).toBe("look\n[photo attached]");
		const doc = fromMessage({ message_id: 2, date: 1, chat, from: owner, document: { file_id: "f", file_unique_id: "u", file_name: "a.pdf" } } as Message);
		expect(doc?.text).toBe("[document attached: a.pdf]");
	});

	it("skips bots and service messages", () => {
		expect(fromMessage({ message_id: 1, date: 1, chat, from: { ...owner, is_bot: true }, text: "x" } as Message)).toBeUndefined();
		expect(fromMessage({ message_id: 1, date: 1, chat, from: owner } as Message)).toBeUndefined();
	});
});

describe("fromCallback", () => {
	it("maps a button press with its label", () => {
		const message = {
			message_id: 5,
			date: 1,
			chat,
			text: "Run it?",
			reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "approve:ap_1" }]] },
		} as Message;
		const q = { id: "cbq1", from: owner, chat_instance: "c", data: "approve:ap_1", message } as CallbackQuery;
		expect(fromCallback(q)).toMatchObject({ kind: "button", externalId: "cbq1", data: "approve:ap_1", text: "Approve", conversation: "42", replyTo: "42:5" });
	});
});

describe("fromReaction", () => {
	const base = { chat, message_id: 5, user: owner, date: 1_700_000_000 };
	it("emits the newly added emoji", () => {
		const r = { ...base, old_reaction: [{ type: "emoji", emoji: "👍" }], new_reaction: [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "👎" }] } as MessageReactionUpdated;
		expect(fromReaction(r)).toMatchObject({ kind: "reaction", data: "👎", replyTo: "42:5", senderId: "42" });
	});
	it("ignores removals", () => {
		const r = { ...base, old_reaction: [{ type: "emoji", emoji: "👍" }], new_reaction: [] } as MessageReactionUpdated;
		expect(fromReaction(r)).toBeUndefined();
	});
});

describe("parseRef", () => {
	it("parses chat:message, including negative group ids", () => {
		expect(parseRef("42:9")).toEqual({ chat: "42", id: 9 });
		expect(parseRef("-1001234:9")).toEqual({ chat: "-1001234", id: 9 });
		expect(parseRef("nope")).toBeUndefined();
	});
});

describe("private chats only", () => {
	it("ignores messages, buttons and reactions in groups", () => {
		const group = { id: -100123, type: "supergroup", title: "team" };
		const user = { id: 42, is_bot: false, first_name: "A" };
		expect(fromMessage({ message_id: 1, date: 1_700_000_000, chat: group, from: user, text: "hi" } as unknown as Message)).toBeUndefined();
		expect(fromCallback({ id: "q", from: user, chat_instance: "c", data: "approve:x", message: { message_id: 2, date: 0, chat: group } } as unknown as Parameters<typeof fromCallback>[0])).toBeUndefined();
		expect(fromReaction({ chat: group, message_id: 3, user, date: 0, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👎" }] } as unknown as Parameters<typeof fromReaction>[0])).toBeUndefined();
	});
});
