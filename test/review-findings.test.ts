// Regressions for the third code review (commits after 71ad4cc): each test failed on the code
// before its fix.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, harness, isConcierge, isWorker } from "./helpers/harness.ts";

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
	await h?.daemon.stop().catch(() => {});
	h = undefined;
});

const say = (t: string) => fauxAssistantMessage(t);
const call = (name: string, args: object) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

describe("review findings", () => {
	it("a typed /approve over HTTP is refused like the button", async () => {
		h = await harness(() => say("ok"));
		const a = h.daemon.s.approvals.request("ticket tk_1", "bash", { command: "git push" }, "push", 600_000);
		const base = { channel: "http" as const, senderId: "owner", conversation: "http", at: Date.now() };
		await h.daemon.onInbound({ ...base, externalId: "http:1", kind: "message", text: `/approve ${a.id}` });
		expect(h.daemon.s.approvals.get(a.id)?.status).toBe("pending");
		await h.daemon.onInbound({ ...base, externalId: "http:2", kind: "message", text: `/deny ${a.id}` });
		expect(h.daemon.s.approvals.get(a.id)?.status).toBe("pending");
	});

	it("a shutdown during a worker turn leaves the ticket for recovery, without a false failure", async () => {
		let workerCalls = 0;
		h = await harness((ctx) => {
			if (isConcierge(ctx)) return ctx.lastToolResult.startsWith("Started") ? say("On it.") : call("spawn_ticket", { title: "Long job", request: "do a long job", scope: "x" });
			if (isWorker(ctx)) return ++workerCalls === 1 ? call("bash", { command: "sleep 3" }) : say("still working");
			return say("?");
		});
		await h.channel.receive("do a long job");
		for (let i = 0; i < 150 && workerCalls < 1; i++) await new Promise((r) => setTimeout(r, 20));
		await new Promise((r) => setTimeout(r, 200));
		const t = h.daemon.s.tickets.list("all")[0];
		await h.daemon.stop(); // a clean shutdown (restart() alone simulates a crash)
		const d2 = await h.restart();
		expect(d2.s.tickets.get(t.id)?.stage).not.toBe("failed");
		expect(d2.s.db.all<{ text: string }>("SELECT text FROM outbox").some((r) => r.text.includes("the model failed"))).toBe(false);
		expect(d2.s.db.all<{ kind: string }>("SELECT kind FROM ticket_inputs WHERE ticket_id = ?", t.id).some((r) => r.kind === "recovery")).toBe(true);
		await d2.stop();
	});

	it("saveConfig never writes BRAVE_API_KEY from the environment", async () => {
		const { loadConfig, paths, saveConfig } = await import("../src/config.ts");
		const home = mkdtempSync(join(tmpdir(), "vigil-cfg-"));
		const prev = process.env.BRAVE_API_KEY;
		process.env.BRAVE_API_KEY = "brave-secret-123";
		try {
			const p = paths(home);
			saveConfig(loadConfig(p), p);
			expect(existsSync(p.config)).toBe(true);
			expect(readFileSync(p.config, "utf8")).not.toContain("brave-secret-123");
		} finally {
			if (prev === undefined) delete process.env.BRAVE_API_KEY;
			else process.env.BRAVE_API_KEY = prev;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("a claim released after its topic was muted is recorded as dropped", async () => {
		h = await harness(() => say("ok"));
		const n = h.daemon.s.notifier;
		const notice = n.notify({ urgency: "low", topic: "t", text: "low thing" });
		n.claimForReply();
		n.mute("t", 3_600_000);
		n.releaseClaim([notice.id]);
		const row = h.daemon.s.db.get<{ status: string; decision: string }>("SELECT status, decision FROM notices WHERE id = ?", notice.id);
		expect(row).toEqual({ status: "dropped", decision: "drop:muted" });
	});
});
