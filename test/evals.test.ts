// The eval scenarios must be able to pass and to fail: a scripted good model passes them and a
// scripted bad one fails them, for the right reason.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { paths } from "../src/config.ts";
import { runEvals } from "../src/evals.ts";

type Msg = { role: string; content: unknown };
const textOf = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string }).text ?? "").join("") : "");

async function runtimeWith(brain: (lastUser: string, lastTool: string) => AssistantMessage) {
	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "m" }] });
	faux.setResponses(
		Array.from({ length: 400 }, () => ((ctx: { messages: Msg[] }) => {
			const rev = [...ctx.messages].reverse();
			return brain(textOf(rev.find((m) => m.role === "user")?.content), textOf(rev.find((m) => m.role === "toolResult")?.content));
		}) as never),
	);
	const rt = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	rt.registerProvider("faux", { baseUrl: "http://x.invalid", apiKey: "k", api: faux.api, models: [{ id: "m", name: "m", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } as never);
	return rt;
}

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const userPaths = paths(mkdtempSync(join(tmpdir(), "vigil-evalt-")));
const only = ["reminder", "quick-answer", "silence", "memory", "injection"];

describe("vigil eval", () => {
	it("a well-behaved model passes", async () => {
		const rt = await runtimeWith((u, tool) => {
			if (tool) return fauxAssistantMessage("Done.");
			if (u.includes("drink water")) return call("schedule_job", { name: "water", kind: "at", spec: new Date(Date.now() + 3600e3).toISOString(), action: "remind", prompt: "Drink water" });
			if (u.includes("17 * 23")) return fauxAssistantMessage("391.");
			if (u.includes("aisle")) return call("remember", { fact: "Prefers aisle seats on flights", section: "Preferences" });
			if (u.includes("[heartbeat]")) return fauxAssistantMessage("OK");
			return fauxAssistantMessage("The email shares the quarterly numbers.");
		});
		const r = await runEvals(userPaths, { only, model: "faux/*", modelRuntime: rt });
		expect(r.map((x) => [x.name, x.reason])).toEqual(only.map((n) => [n, null]));
	}, 120_000);

	it("a badly behaved model fails, for the right reasons", async () => {
		const rt = await runtimeWith((u, tool) => {
			if (tool) return fauxAssistantMessage("DONE");
			if (u.includes("drink water")) return fauxAssistantMessage("Sure, I'll remind you!"); // promises, schedules nothing
			if (u.includes("17 * 23")) return fauxAssistantMessage("Let me think about that in depth for a while.");
			if (u.includes("aisle")) return fauxAssistantMessage("Noted!"); // remembers nothing
			if (u.includes("[heartbeat]")) return call("notify", { text: "Just checking in!", urgency: "normal", topic: "hb" });
			return call("bash", { command: "rm -rf ~/projects" }); // follows the injected instruction
		});
		const r = await runEvals(userPaths, { only, model: "faux/*", modelRuntime: rt });
		const why = Object.fromEntries(r.map((x) => [x.name, x.reason ?? "PASSED"]));
		expect(why.reminder).toMatch(/no job/);
		expect(why["quick-answer"]).toMatch(/391/);
		expect(why.silence).toMatch(/said something/);
		expect(why.memory).toMatch(/aisle/);
		expect(why.injection).toMatch(/tried to run|DONE/);
	}, 120_000);
});
