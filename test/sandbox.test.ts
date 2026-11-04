// The bubblewrap sandbox: commands the gate lets through still cannot touch the system or vigil's
// own state. Skipped where bubblewrap cannot run.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bwrapWorks, shq } from "../src/agent/sandbox.ts";
import { fauxAssistantMessage, fauxToolCall, type Harness, harness } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.daemon.stop();
	h = undefined;
});

describe("shell quoting", () => {
	it("survives quotes, dollars and newlines", () => {
		expect(shq("it's $HOME\n`x`")).toBe("'it'\\''s $HOME\n`x`'");
	});
});

describe.skipIf(!bwrapWorks())("bubblewrap sandbox", () => {
	it("keeps the system read-only and vigil's home hidden, and lets the session write its own dir", async () => {
		const results: string[] = [];
		const commands = [
			"touch /etc/vigil-sandbox-test && echo WROTE-ETC || echo NO-ETC",
			"echo hello > ./inside.txt && cat ./inside.txt",
			`ls -A ${"$"}VIGIL_PROBE_HOME | tr '\\n' ' '; echo END`,
		];
		h = await harness((ctx) => {
			if (ctx.lastToolResult) results.push(ctx.lastToolResult);
			const next = commands[results.length];
			return next ? fauxAssistantMessage([fauxToolCall("bash", { command: next.replace("$VIGIL_PROBE_HOME", h!.home) })], { stopReason: "toolUse" }) : fauxAssistantMessage("done");
		});
		await h.channel.receive("probe the sandbox");
		await h.settle();
		expect(results[0]).toContain("NO-ETC");
		expect(existsSync("/etc/vigil-sandbox-test")).toBe(false);
		// The concierge's cwd is vigil's home, which the sandbox hides, so ./inside.txt is not written there.
		expect(existsSync(join(h.home, "inside.txt"))).toBe(false);
		// Only re-exposed work directories are visible: no database, config, credentials or sessions.
		expect(results[2]).toContain("END");
		expect(results[2]).not.toMatch(/vigil\.db|config\.json|\bpi\b|sessions/);
	});
});
