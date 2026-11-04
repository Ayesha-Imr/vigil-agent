// Tests for the terminal channel: lines become messages, buttons print as [n] and /n presses one.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliChannel, renderCliButtons } from "../../src/channels/cli.ts";
import type { InboundMessage } from "../../src/channels/types.ts";

describe("CliChannel", () => {
	it("reads lines, prints buttons and maps /1 to a press", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let printed = "";
		output.on("data", (d: Buffer) => {
			printed += d.toString();
		});
		const ch = new CliChannel({ input, output });
		const got: InboundMessage[] = [];
		await ch.start(async (m) => {
			got.push(m);
		});
		input.write("hello\n");
		await new Promise((r) => setImmediate(r));
		const sent = await ch.send({ conversation: "cli", text: "Delete it?", buttons: [[{ label: "Approve", data: "a" }, { label: "Deny", data: "d" }]] });
		expect(printed).toContain("Delete it?\n[1] Approve [2] Deny");
		input.write("/2\n/9\n");
		await new Promise((r) => setImmediate(r));
		expect(got.map((m) => [m.kind, m.text, m.data])).toEqual([
			["message", "hello", undefined],
			["button", "Deny", "d"],
		]);
		expect(got[1].replyTo).toBe(sent.externalId);
		expect(printed).toContain("(no such button)");
		expect(new Set(got.map((m) => m.externalId)).size).toBe(2);
		await ch.stop();
	});

	it("renders buttons", () => {
		expect(renderCliButtons([{ label: "Approve", data: "a" }, { label: "Deny", data: "d" }])).toBe("[1] Approve [2] Deny");
	});
});
