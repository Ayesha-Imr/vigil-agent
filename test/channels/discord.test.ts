// Tests for the Discord channel's pure parts: splitting at 2000 chars, button layout and refs.

import { describe, expect, it } from "vitest";
import { DISCORD_MAX_LENGTH, layoutButtons, parseDiscordRef, splitForDiscord } from "../../src/channels/discord.ts";

describe("splitForDiscord", () => {
	it("keeps short text in one part", () => {
		expect(splitForDiscord("hello")).toEqual(["hello"]);
	});

	it("never sends an empty message", () => {
		expect(splitForDiscord("")).toEqual(["…"]);
	});

	it("splits long text into parts within the limit, at line breaks when it can", () => {
		const para = `${"word ".repeat(150).trim()}\n\n`;
		const text = para.repeat(10);
		const parts = splitForDiscord(text);
		expect(parts.length).toBeGreaterThan(1);
		for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH);
		expect(parts.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
		expect(parts[0].endsWith("word")).toBe(true);
	});

	it("hard-cuts text with no spaces", () => {
		const parts = splitForDiscord("x".repeat(4500));
		expect(parts.map((p) => p.length)).toEqual([2000, 2000, 500]);
	});
});

describe("layoutButtons", () => {
	const b = (n: number) => ({ label: `b${n}`, data: `d${n}` });
	it("wraps rows longer than 5 and caps at 5 rows", () => {
		const rows = layoutButtons([Array.from({ length: 7 }, (_, i) => b(i))]);
		expect(rows.map((r) => r.length)).toEqual([5, 2]);
		const many = layoutButtons(Array.from({ length: 8 }, (_, i) => [b(i)]));
		expect(many).toHaveLength(5);
		expect(layoutButtons(undefined)).toEqual([]);
	});
});

describe("parseDiscordRef", () => {
	it("parses channel:message snowflakes", () => {
		expect(parseDiscordRef("123:456")).toEqual({ channelId: "123", messageId: "456" });
		expect(parseDiscordRef("dm:123")).toBeUndefined();
	});
});
