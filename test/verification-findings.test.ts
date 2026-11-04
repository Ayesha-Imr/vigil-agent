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
