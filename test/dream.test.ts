// Memory consolidation ("dreaming"): the schedule grammar, owner controls, the window since the
// last run, and the guards that run after every consolidation.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lastDream } from "../src/memory/dream.ts";
import { parseDreamSchedule } from "../src/memory/schedule.ts";
import { fauxAssistantMessage, fauxToolCall, harness } from "./helpers/harness.ts";

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
	await h?.daemon.stop().catch(() => {});
	h = undefined;
});

const say = (t: string) => fauxAssistantMessage(t);
const call = (name: string, args: object) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const isDream = (ctx: { system: string }) => ctx.system.includes("[memory consolidation]");
const command = (d: H["daemon"], text: string, n: number) =>
	d.onInbound({ channel: "telegram", externalId: `42:c${n}`, senderId: "42", conversation: "42", kind: "message", text, at: Date.now() });

describe("dream schedule grammar", () => {
	it("reads the forms the owner is told about", () => {
		expect(parseDreamSchedule("04:00")).toMatchObject({ kind: "cron", spec: "0 4 * * *" });
		expect(parseDreamSchedule("nightly 3am")).toMatchObject({ kind: "cron", spec: "0 3 * * *" });
		expect(parseDreamSchedule("daily 10:30pm")).toMatchObject({ kind: "cron", spec: "30 22 * * *" });
		expect(parseDreamSchedule("every 12h")).toMatchObject({ kind: "every", spec: "720" });
		expect(parseDreamSchedule("every 90 minutes")).toMatchObject({ kind: "every", spec: "90" });
		expect(parseDreamSchedule("weekly sun 03:00")).toMatchObject({ kind: "cron", spec: "0 3 * * 0" });
		expect(parseDreamSchedule("weekly mon,thu 22:15")).toMatchObject({ kind: "cron", spec: "15 22 * * 1,4" });
		expect(parseDreamSchedule("0 2 * * 1-5")).toMatchObject({ kind: "cron", spec: "0 2 * * 1-5" });
		expect(parseDreamSchedule("off")).toBeNull();
		expect(parseDreamSchedule(null)).toBeNull();
	});
	it("refuses nonsense and schedules more often than hourly", () => {
		expect(() => parseDreamSchedule("whenever")).toThrow(/could not read/);
		expect(() => parseDreamSchedule("every 10m")).toThrow(/more often/);
		expect(() => parseDreamSchedule("*/5 * * * *")).toThrow(/more often/);
		expect(() => parseDreamSchedule("25:00")).toThrow();
		expect(() => parseDreamSchedule("weekly funday 03:00")).toThrow(/weekly sun/);
	});
});

describe("dream controls", () => {
	it("/dream shows, changes and turns off the schedule, and saves it", async () => {
		h = await harness(() => say("ok"));
		await command(h.daemon, "/dream every 6h", 1);
		const job = () => h!.daemon.s.scheduler.list().find((j) => j.created_by === "system" && j.name === "dream");
		expect(job()).toMatchObject({ kind: "every", spec: "360", enabled: 1 });
		expect(JSON.parse(readFileSync(h.daemon.s.paths.config, "utf8")).proactive.dreamAt).toBe("every 6h");
		await command(h.daemon, "/dream weekly sun 03:00", 2);
		expect(job()).toMatchObject({ kind: "cron", spec: "0 3 * * 0", enabled: 1 });
		await command(h.daemon, "/dream off", 3);
		expect(job()?.enabled).toBe(0);
		await command(h.daemon, "/dream every 5m", 4);
		await command(h.daemon, "/dream", 5);
		await h.daemon.s.outbox.deliverDue();
		const said = h.channel.sent.map((m) => m.text).join("\n");
		expect(said).toMatch(/now runs every 6 hours/);
		expect(said).toMatch(/weekly on sun at 03:00/);
		expect(said).toMatch(/more often than every 60 minutes/);
		expect(said).toMatch(/Memory consolidation is off\./);
	});

	it("background work cannot change the schedule through the tool", async () => {
		let result = "";
		h = await harness((ctx) => {
			if (ctx.lastToolResult) {
				result = ctx.lastToolResult;
				return say("ok");
			}
			return call("memory_consolidation", { action: "set", schedule: "every 1h" });
		});
		h.daemon.concierge.enqueue({ kind: "system", tag: "heartbeat", text: "look around" });
		await h.settle();
		expect(result).toMatch(/Only the owner/);
		expect(h.daemon.s.scheduler.list().find((j) => j.name === "dream")?.enabled ?? 0).toBe(0);
	});
});

describe("a consolidation", () => {
	it("covers only what is new since the last one, and skips when nothing is", async () => {
		const seen: string[] = [];
		h = await harness((ctx) => {
			if (!isDream(ctx)) return say("?");
			if (!ctx.lastToolResult) seen.push(ctx.system);
			return say('SUMMARY: nothing to change.\nREPORT: {"added": 0}');
		});
		const d = h.daemon;
		d.s.memory.journal("owner", "first thing");
		await d.s.dream!.now();
		expect(lastDream(d.s)?.status).toBe("done");
		expect(await d.s.dream!.now()).toMatch(/skipped/);
		h.clock.advance(10 * 60_000);
		d.s.memory.journal("owner", "second thing");
		await d.s.dream!.now();
		expect(seen).toHaveLength(2);
		expect(seen[0]).toContain("first thing");
		expect(seen[1]).toContain("second thing");
		expect(seen[1]).not.toContain("first thing");
	});

	it("is undone when it would throw away most of memory", async () => {
		h = await harness((ctx) => {
			if (!isDream(ctx)) return say("?");
			if (ctx.lastToolResult) return say("SUMMARY: tidied.");
			return call("write", { path: h!.daemon.s.memory.memoryPath, content: "# Memory\n\n## Facts\n- one fact\n" });
		});
		const d = h.daemon;
		const big = `${readFileSync(d.s.memory.memoryPath, "utf8")}\n${Array.from({ length: 80 }, (_, i) => `- Fact number ${i}: the owner cares about item ${i}.`).join("\n")}\n`;
		writeFileSync(d.s.memory.memoryPath, big);
		d.s.memory.journal("owner", "hello");
		await d.s.dream!.now();
		expect(lastDream(d.s)?.status).toBe("reverted");
		expect(readFileSync(d.s.memory.memoryPath, "utf8")).toBe(big);
		expect(d.s.notifier.waiting().some((n) => n.topic === "vigil:memory")).toBe(true);
	});

	it("removes secrets the model wrote, and can be undone by the owner", async () => {
		h = await harness((ctx) => {
			if (!isDream(ctx)) return say("?");
			if (ctx.lastToolResult?.includes("notes")) return say('SUMMARY: added a note.\nREPORT: {"added": 2}');
			if (ctx.lastToolResult) return call("write", { path: join(h!.daemon.s.memory.dir, "notes", "deploys.md"), content: "---\nname: deploys\ndescription: how the owner deploys\n---\nDeploys run from main.\n" });
			return call("write", { path: h!.daemon.s.memory.memoryPath, content: `${before}\n- API key: sk-abcdefghijklmnopqrstuvwx (2026-11-07)\n- [[deploys]] — how the owner deploys\n` });
		});
		const d = h.daemon;
		const before = readFileSync(d.s.memory.memoryPath, "utf8");
		d.s.memory.journal("owner", "my key is sk-abcdefghijklmnopqrstuvwx and deploys run from main");
		await d.s.dream!.now();
		const after = readFileSync(d.s.memory.memoryPath, "utf8");
		expect(after).not.toContain("sk-abcdefghijklmnopqrstuvwx");
		expect(after).toContain("[[deploys]]");
		expect(lastDream(d.s)).toMatchObject({ status: "done", redacted: 1, counts: { added: 2 } });
		expect(d.s.dream!.status()).toMatch(/1 notes/);
		expect(await d.s.dream!.undo()).toMatch(/Undone/);
		expect(readFileSync(d.s.memory.memoryPath, "utf8")).toBe(before);
		expect(existsSync(join(d.s.memory.dir, "notes", "deploys.md"))).toBe(false);
		expect(await d.s.dream!.undo()).toMatch(/nothing to undo/);
	});

	it("the journal holds both sides of a conversation", async () => {
		h = await harness(() => say("Noted, aisle seats from now on."));
		await h.channel.receive("I prefer aisle seats");
		await h.settle();
		const lines = h.daemon.s.memory.journalSince(0);
		expect(lines.some((l) => l.includes("[owner] I prefer aisle seats"))).toBe(true);
		expect(lines.some((l) => l.includes("[vigil] Noted, aisle seats"))).toBe(true);
	});
});
