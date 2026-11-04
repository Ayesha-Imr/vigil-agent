// Regression tests for the bugs the TLA+ models of the scheduler and the worker pool found
// (verification/scheduler and verification/workers, findings S1-S3 and W2, W4).

import { afterEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/core/scheduler.ts";
import { MINUTE, ManualClock } from "../src/core/time.ts";
import { Db } from "../src/store/db.ts";
import { fauxAssistantMessage, fauxToolCall, type Harness, harness, isWorker } from "./helpers/harness.ts";

const setup = () => {
	const db = new Db(":memory:");
	const clock = new ManualClock(Date.UTC(2026, 10, 4, 12, 0));
	return { db, clock, sch: new Scheduler(db, clock, () => "UTC") };
};

describe("scheduler findings", () => {
	it("S1: a slot due exactly at the claim instant is counted as coalesced", () => {
		const { clock, sch } = setup();
		sch.create({ name: "x", kind: "every", spec: "2", prompt: "p", action: "remind", createdBy: "owner" });
		clock.advance(4 * MINUTE); // slots at +2 and +4 are both due now
		const [run] = sch.claimDue();
		expect(run.coalesced).toBe(1);
	});
	it("S2: a run that outlived its lease cannot free the job a newer run holds", () => {
		const { db, clock, sch } = setup();
		const job = sch.create({ name: "x", kind: "every", spec: "1", prompt: "p", action: "agent", createdBy: "owner" });
		clock.advance(MINUTE);
		const [a] = sch.claimDue();
		clock.advance(7 * 60 * MINUTE); // past RUN_LEASE_MS: the job is claimed again
		const [b] = sch.claimDue();
		expect(b.claimedAt).toBeGreaterThan(a.claimedAt);
		sch.complete(job.id, "old run done", a.claimedAt);
		expect(db.get<{ running_since: number | null }>("SELECT running_since FROM jobs WHERE id = ?", job.id)?.running_since).toBe(b.claimedAt);
		sch.complete(job.id, "new run done", b.claimedAt);
		expect(db.get<{ running_since: number | null }>("SELECT running_since FROM jobs WHERE id = ?", job.id)?.running_since).toBeNull();
	});
	it("S3: a run claimed before a crash runs after the restart", () => {
		const { clock, sch } = setup();
		sch.create({ name: "once", kind: "at", spec: new Date(clock.now() + MINUTE).toISOString(), prompt: "p", action: "agent", createdBy: "owner" });
		clock.advance(MINUTE);
		expect(sch.claimDue()).toHaveLength(1); // claimed, then the process dies
		sch.recover();
		const again = sch.unfinishedRuns(24 * 60 * MINUTE);
		expect(again.map((r) => r.job.name)).toEqual(["once"]);
	});
});

let h: Harness | undefined;
afterEach(async () => {
	await h?.daemon.stop();
	h = undefined;
});

describe("worker pool findings", () => {
	it("W2: an owner message that arrives before 'ready' keeps the ticket open for the next run", async () => {
		h = await harness((ctx) => (isWorker(ctx) && !ctx.lastToolResult ? fauxAssistantMessage([fauxToolCall("report", { kind: "ready", summary: "done" })], { stopReason: "toolUse" }) : fauxAssistantMessage("x")));
		const t = h.daemon.s.tickets.create({ title: "T", mandate: { request: "r", scope: "s", strength: "explicit" }, origin: { channel: "telegram", conversation: "42" } });
		h.daemon.s.tickets.addInput(t.id, "owner_message", "one more thing"); // waiting when the worker reports ready
		h.daemon.s.tickets.report(t.id, "ready", "done");
		expect(h.daemon.s.tickets.get(t.id)?.status).toBe("open");
	});
	it("W4: no worker model and a pending input does not freeze the event loop", async () => {
		h = await harness(() => fauxAssistantMessage("x"), (c) => {
			c.models.worker = ["nonexistent/*"];
		});
		const t = h.daemon.s.tickets.create({ title: "T", mandate: { request: "r", scope: "s", strength: "explicit" }, origin: { channel: "telegram", conversation: "42" } });
		h.daemon.s.tickets.addInput(t.id, "owner_message", "go");
		h.daemon.workers.pump();
		const fired = await new Promise<boolean>((resolve) => {
			setTimeout(() => resolve(true), 0);
			setTimeout(() => resolve(false), 2000);
		});
		expect(fired).toBe(true);
		const starts = h.daemon.s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'ticket.report'")?.n ?? 0;
		expect(starts).toBeLessThan(5);
	});
});

describe("outbox findings", () => {
	it("F2: a second daemon on the same home refuses to start", async () => {
		h = await harness(() => fauxAssistantMessage("x"));
		// Another live process holds the lock (the parent of this test process stands in for it).
		h.daemon.s.db.setKv("daemon.lock", { pid: process.ppid, at: Date.now() });
		await expect(h.restart()).rejects.toThrow(/already running/);
		// A live node process is not taken over even with a stale heartbeat (a suspended machine, F2b).
		h.daemon.s.db.setKv("daemon.lock", { pid: process.ppid, at: Date.now() - 10 * 60_000 });
		await expect(h.restart()).rejects.toThrow(/already running/);
		// A pid now used by some other program (vigil died, the pid was reused) is taken over.
		const { spawn } = await import("node:child_process");
		const other = spawn("sleep", ["30"]);
		try {
			h.daemon.s.db.setKv("daemon.lock", { pid: other.pid, at: Date.now() });
			const d2 = await h.restart();
			// (Both daemons here share one pid, so "only the holder sends" is checked by the outbox model.)
			await d2.stop();
		} finally {
			other.kill();
		}
	});
	it("F1: a ticket's question and its later report share an order key", async () => {
		h = await harness((ctx) => {
			if (!isWorker(ctx)) return fauxAssistantMessage("x");
			if (!ctx.lastToolResult) return fauxAssistantMessage([fauxToolCall("ask_owner", { question: "Which one?" })], { stopReason: "toolUse" });
			if (ctx.lastToolResult.startsWith("Asked")) return fauxAssistantMessage([fauxToolCall("report", { kind: "blocked", summary: "Waiting on you." })], { stopReason: "toolUse" });
			return fauxAssistantMessage("x");
		});
		const t = h.daemon.s.tickets.create({ title: "T", mandate: { request: "r", scope: "s", strength: "explicit" }, origin: { channel: "telegram", conversation: "42" } });
		h.daemon.workers.pump();
		await h.settle();
		const keys = h.daemon.s.db.all<{ order_key: string | null; ref_kind: string }>("SELECT order_key, ref_kind FROM outbox ORDER BY id");
		const q = keys.find((k) => k.ref_kind === "attention");
		const r = keys.find((k) => k.ref_kind === "ticket");
		expect(q?.order_key).toBe(`${t.id}:telegram:42`);
		expect(r?.order_key).toBe(q?.order_key);
	});
});

describe("governor findings", () => {
	it("ConciergeToldTwice: a notice claimed for a reply is not also sent in the morning digest", async () => {
		const g = await import("../src/core/governor.ts");
		const policy = { ...g.DEFAULT_POLICY, timezone: "UTC" };
		const night = Date.UTC(2026, 10, 4, 23, 0);
		let s = g.offer(g.initialState(night), { id: "n1", urgency: "normal", topic: "x", text: "held overnight" }, night, policy).state;
		const morning = Date.UTC(2026, 10, 5, 7, 59);
		s = g.tick(s, morning, policy).state;
		const c = g.claim(s, morning); // the owner writes at 07:59; the reply is being written
		expect(c.notices.map((n) => n.id)).toEqual(["n1"]);
		const t = g.tick(c.state, Date.UTC(2026, 10, 5, 8, 1), policy); // quiet hours end mid-turn
		expect(t.digest).toEqual([]);
		const told = g.markDelivered(t.state, ["n1"], Date.UTC(2026, 10, 5, 8, 2));
		expect(told.notices.map((n) => n.status)).toEqual(["digested"]);
		const released = g.release(c.state, ["n1"]);
		expect(released.notices[0].status).toBe("held");
	});
	it("DigestCommandStale: /digest does not show a notice past its expiry", async () => {
		const g = await import("../src/core/governor.ts");
		const policy = { ...g.DEFAULT_POLICY, timezone: "UTC" };
		const t0 = Date.UTC(2026, 10, 4, 12, 0);
		const s = g.offer(g.initialState(t0), { id: "n1", urgency: "low", topic: "x", text: "stale", expiresAt: t0 + 60_000 }, t0, policy).state;
		expect(g.takeForReply(s, t0 + 120_000).notices).toEqual([]);
	});
	it("WindowGap/WindowDedup: config refuses windows longer than the governor's history", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { loadConfig, paths } = await import("../src/config.ts");
		const home = mkdtempSync(join(tmpdir(), "vigil-win-"));
		writeFileSync(join(home, "config.json"), JSON.stringify({ owner: { timezone: "UTC" }, attention: { minGapMinutes: 2000 } }));
		expect(() => loadConfig(paths(home))).toThrow(/minGapMinutes/);
	});
});
