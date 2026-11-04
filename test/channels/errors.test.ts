// Tests that each channel turns its library's failures into what the outbox expects:
// PermanentSendError when retrying cannot help, a plain Error when it can.

import { GrammyError, HttpError } from "grammy";
import { describe, expect, it } from "vitest";
import { classifyDiscordError } from "../../src/channels/discord.ts";
import { classifyNtfyStatus } from "../../src/channels/ntfy.ts";
import { classifyTelegramError, inlineKeyboard } from "../../src/channels/telegram.ts";
import { PermanentSendError } from "../../src/channels/types.ts";

function grammyError(error_code: number, description: string, parameters = {}): GrammyError {
	return new GrammyError(`Call to 'sendMessage' failed! (${error_code}: ${description})`, { ok: false, error_code, description, parameters }, "sendMessage", {});
}

describe("telegram", () => {
	it("bot blocked and chat not found are permanent", () => {
		expect(classifyTelegramError(grammyError(403, "Forbidden: bot was blocked by the user"))).toBeInstanceOf(PermanentSendError);
		expect(classifyTelegramError(grammyError(400, "Bad Request: chat not found"))).toBeInstanceOf(PermanentSendError);
	});

	it("flood control, server errors and network errors are retried", () => {
		const flood = classifyTelegramError(grammyError(429, "Too Many Requests: retry after 7", { retry_after: 7 }));
		expect(flood).not.toBeInstanceOf(PermanentSendError);
		expect(flood.message).toContain("retry after 7 s");
		expect(classifyTelegramError(grammyError(502, "Bad Gateway"))).not.toBeInstanceOf(PermanentSendError);
		expect(classifyTelegramError(new HttpError("Network request failed", new Error("ECONNRESET")))).not.toBeInstanceOf(PermanentSendError);
		expect(classifyTelegramError("weird")).toBeInstanceOf(Error);
	});

	it("refuses button data Telegram would reject", () => {
		expect(() => inlineKeyboard([[{ label: "x", data: "d".repeat(65) }]])).toThrow(PermanentSendError);
		expect(inlineKeyboard([[{ label: "Approve", data: "approve:ap_1" }], []])).toEqual([[{ text: "Approve", callback_data: "approve:ap_1" }]]);
		expect(inlineKeyboard(undefined)).toBeUndefined();
	});
});

describe("discord", () => {
	const apiError = (code: number, status: number) => Object.assign(new Error(`api ${code}`), { code, status });
	it("closed DMs, unknown users and missing access are permanent", () => {
		expect(classifyDiscordError(apiError(50007, 403))).toBeInstanceOf(PermanentSendError);
		expect(classifyDiscordError(apiError(10013, 404))).toBeInstanceOf(PermanentSendError);
		expect(classifyDiscordError(apiError(50001, 403))).toBeInstanceOf(PermanentSendError);
		expect(classifyDiscordError(apiError(0, 404))).toBeInstanceOf(PermanentSendError);
	});
	it("rate limits, server and network errors are retried", () => {
		expect(classifyDiscordError(apiError(0, 429))).not.toBeInstanceOf(PermanentSendError);
		expect(classifyDiscordError(apiError(0, 500))).not.toBeInstanceOf(PermanentSendError);
		expect(classifyDiscordError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).not.toBeInstanceOf(PermanentSendError);
	});
});

describe("ntfy", () => {
	it("bad requests and auth failures are permanent, 429 and 5xx are retried", () => {
		expect(classifyNtfyStatus(400, "bad")).toBeInstanceOf(PermanentSendError);
		expect(classifyNtfyStatus(403, "forbidden")).toBeInstanceOf(PermanentSendError);
		expect(classifyNtfyStatus(429, "slow down")).not.toBeInstanceOf(PermanentSendError);
		expect(classifyNtfyStatus(503, "")).not.toBeInstanceOf(PermanentSendError);
	});
});
