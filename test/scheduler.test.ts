// Unit tests for the scheduler: every/cron/at kinds, one Trigger per slot, no overlap,
// coalescing after downtime, the run lease, recover() and ensure().

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Job, nextRunAt, RUN_LEASE_MS, Scheduler } from "../src/core/scheduler.ts";
import { DAY, HOUR, MINUTE, ManualClock } from "../src/core/time.ts";
import { Db } from "../src/store/db.ts";

let db: Db;
let clock: ManualClock;
let tz: string;
let s: Scheduler;

beforeEach(() => {
	db = new Db(":memory:");
	// 2026-01-05 12:00:00 UTC (a Monday).
	clock = new ManualClock();
	tz = "UTC";
	s = new Scheduler(db, clock, () => tz);
});

afterEach(() => db.close());

function triggers(): { external_id: string; payload: string; kind: string; strength: string; source: string }[] {
	return db.all("SELECT * FROM triggers ORDER BY id");
}

function every(minutes: number, name = "tick"): Job {
	return s.create({ name, kind: "every", spec: String(minutes), prompt: "do it", action: "agent", createdBy: "owner" });
}

describe("nextRunAt", () => {
	it("every adds whole minutes", () => {
		expect(nextRunAt("every", "15", 1000, "UTC")).toBe(1000 + 15 * MINUTE);
	});

	it.each(["0", "-5", "abc", "", "0.5"])("every rejects %j", (spec) => {
		expect(() => nextRunAt("every", spec, 0, "UTC")).toThrow();
	});

	it("at returns the time only while it is in the future", () => {
		const t = Date.UTC(2026, 0, 6, 9, 0);
		expect(nextRunAt("at", new Date(t).toISOString(), t - 1, "UTC")).toBe(t);
		expect(nextRunAt("at", new Date(t).toISOString(), t, "UTC")).toBeNull();
		expect(nextRunAt("at", new Date(t).toISOString(), t + 1, "UTC")).toBeNull();
	});

	it("at rejects garbage", () => {
		expect(() => nextRunAt("at", "next tuesday-ish", 0, "UTC")).toThrow();
	});

	it("cron honours the time zone (Asia/Karachi is UTC+5, no DST)", () => {
		const after = Date.UTC(2026, 0, 5, 12, 0); // 17:00 in Karachi
		expect(nextRunAt("cron", "0 9 * * *", after, "Asia/Karachi")).toBe(Date.UTC(2026, 0, 6, 4, 0));
		expect(nextRunAt("cron", "0 9 * * *", after, "UTC")).toBe(Date.UTC(2026, 0, 6, 9, 0));
		// Before 09:00 Karachi on the same day.
		expect(nextRunAt("cron", "0 9 * * *", Date.UTC(2026, 0, 5, 3, 0), "Asia/Karachi")).toBe(Date.UTC(2026, 0, 5, 4, 0));
	});

	it("cron is strictly after the given instant (a slot never repeats itself)", () => {
		const slot = Date.UTC(2026, 0, 6, 4, 0);
		expect(nextRunAt("cron", "0 9 * * *", slot, "Asia/Karachi")).toBe(slot + DAY);
	});

	it("cron follows DST in America/New_York", () => {
		// 2026-03-08 is the spring-forward day in the US: 09:00 EDT is 13:00 UTC, the day before 14:00 UTC.
		expect(nextRunAt("cron", "0 9 * * *", Date.UTC(2026, 2, 7, 0, 0), "America/New_York")).toBe(Date.UTC(2026, 2, 7, 14, 0));
		expect(nextRunAt("cron", "0 9 * * *", Date.UTC(2026, 2, 8, 0, 0), "America/New_York")).toBe(Date.UTC(2026, 2, 8, 13, 0));
	});
});

describe("create", () => {
	it("stores the job with its first run", () => {
		const j = every(10);
		expect(j.id).toMatch(/^job_/);
		expect(j.enabled).toBe(1);
		expect(j.next_run_at).toBe(clock.now() + 10 * MINUTE);
		expect(j.running_since).toBeNull();
		expect(j.runs).toBe(0);
		expect(s.list().map((x) => x.id)).toEqual([j.id]);
	});

	it("refuses a job that would never run", () => {
		expect(() =>
			s.create({ name: "past", kind: "at", spec: new Date(clock.now() - 1).toISOString(), prompt: "x", action: "remind", createdBy: "owner" }),
		).toThrow(/never run/);
		expect(s.list()).toEqual([]);
	});

	it("cron next run uses the configured time zone", () => {
		tz = "Asia/Karachi";
		const j = s.create({ name: "morning", kind: "cron", spec: "0 9 * * *", prompt: "x", action: "remind", createdBy: "owner" });
		expect(j.next_run_at).toBe(Date.UTC(2026, 0, 6, 4, 0));
	});
});

describe("claimDue", () => {
	it("claims nothing before the slot", () => {
		every(10);
		clock.advance(10 * MINUTE - 1);
		expect(s.claimDue()).toEqual([]);
		expect(triggers()).toEqual([]);
	});

	it("an every job produces one explicit clock Trigger per slot", () => {
		const j = every(10);
		clock.advance(10 * MINUTE);
		const runs = s.claimDue();
		expect(runs).toHaveLength(1);
		const slot = j.next_run_at!;
		expect(runs[0]).toMatchObject({ slot, coalesced: 0 });
		expect(runs[0].job.id).toBe(j.id);
		const t = triggers();
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ source: "clock", kind: "job", strength: "explicit", external_id: `${j.id}:${slot}` });
		expect(JSON.parse(t[0].payload)).toEqual({ jobId: j.id, slot, coalesced: 0 });
		expect(runs[0].triggerId).toBe((db.get<{ id: number }>("SELECT id FROM triggers")!).id);

		const after = s.get(j.id)!;
		expect(after.running_since).toBe(clock.now());
		expect(after.last_slot).toBe(slot);
		expect(after.runs).toBe(1);
		expect(after.next_run_at).toBe(clock.now() + 10 * MINUTE);
	});

	it("calling claimDue twice for the same slot creates exactly one Trigger", () => {
		every(10);
		clock.advance(10 * MINUTE);
		expect(s.claimDue()).toHaveLength(1);
		expect(s.claimDue()).toEqual([]);
		expect(triggers()).toHaveLength(1);
	});

	it("still one Trigger per slot after complete() and a re-claim at the same instant", () => {
		const j = every(10);
		clock.advance(10 * MINUTE);
		s.claimDue();
		s.complete(j.id, "ok");
		expect(s.claimDue()).toEqual([]);
		expect(triggers()).toHaveLength(1);
	});

	it("a running job is not claimed again until complete() (no overlap)", () => {
		const j = every(10);
		clock.advance(10 * MINUTE);
		expect(s.claimDue()).toHaveLength(1);
		// The run takes 35 minutes; three more slots pass meanwhile.
		for (let i = 0; i < 7; i++) {
			clock.advance(5 * MINUTE);
			expect(s.claimDue()).toEqual([]);
		}
		s.complete(j.id, "done");
		const done = s.get(j.id)!;
		expect(done.running_since).toBeNull();
		expect(done.last_status).toBe("done");
		expect(done.last_run_at).toBe(clock.now());

		const runs = s.claimDue();
		expect(runs).toHaveLength(1);
		// Slot was t0+20; slots t0+30 and t0+40 were skipped while it ran (now = t0+45).
		expect(runs[0].slot).toBe(Date.UTC(2026, 0, 5, 12, 20));
		expect(runs[0].coalesced).toBe(2);
		expect(triggers()).toHaveLength(2);
	});

	it("after a long downtime missed slots coalesce into ONE run with a count", () => {
		const j = every(10);
		const firstSlot = j.next_run_at!;
		clock.advance(10 * MINUTE + 3 * HOUR + 5 * MINUTE); // down for ~3 h
		const runs = s.claimDue();
		expect(runs).toHaveLength(1);
		expect(runs[0].slot).toBe(firstSlot);
		// Slots strictly between the claimed slot and now: every 10 minutes for 3 h 5 m -> 18.
		expect(runs[0].coalesced).toBe(18);
		expect(triggers()).toHaveLength(1);
		expect(JSON.parse(triggers()[0].payload).coalesced).toBe(18);
		// Next run is in the future, so nothing replays.
		expect(s.get(j.id)!.next_run_at).toBeGreaterThan(clock.now());
		s.complete(j.id, "ok");
		expect(s.claimDue()).toEqual([]);
	});

	it("coalesced count is capped", () => {
		every(1);
		clock.advance(10 * DAY);
		const [run] = s.claimDue();
		expect(run.coalesced).toBe(1000);
	});

	it("a cron job in Asia/Karachi coalesces missed days into one run", () => {
		tz = "Asia/Karachi";
		const j = s.create({ name: "morning", kind: "cron", spec: "0 9 * * *", prompt: "x", action: "remind", createdBy: "owner" });
		expect(j.next_run_at).toBe(Date.UTC(2026, 0, 6, 4, 0));
		// Down until 2026-01-09 06:00 UTC (11:00 Karachi): slots on 6, 7, 8, 9 Jan.
		clock.t = Date.UTC(2026, 0, 9, 6, 0);
		const runs = s.claimDue();
		expect(runs).toHaveLength(1);
		expect(runs[0].slot).toBe(Date.UTC(2026, 0, 6, 4, 0));
		expect(runs[0].coalesced).toBe(3);
		expect(s.get(j.id)!.next_run_at).toBe(Date.UTC(2026, 0, 10, 4, 0));
	});

	it("a cron job claimed exactly at its slot moves to the next day", () => {
		tz = "Asia/Karachi";
		const j = s.create({ name: "morning", kind: "cron", spec: "0 9 * * *", prompt: "x", action: "remind", createdBy: "owner" });
		clock.t = j.next_run_at!;
		expect(s.claimDue()).toHaveLength(1);
		expect(s.get(j.id)!.next_run_at).toBe(j.next_run_at! + DAY);
	});

	it("an at job fires once and then disables itself", () => {
		const at = clock.now() + 2 * HOUR;
		const j = s.create({ name: "dentist", kind: "at", spec: new Date(at).toISOString(), prompt: "go", action: "remind", createdBy: "owner" });
		expect(j.next_run_at).toBe(at);
		clock.advance(2 * HOUR + 30 * MINUTE);
		const runs = s.claimDue();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ slot: at, coalesced: 0 });
		const after = s.get(j.id)!;
		expect(after.enabled).toBe(0);
		expect(after.next_run_at).toBeNull();
		s.complete(j.id, "sent");
		clock.advance(DAY);
		expect(s.claimDue()).toEqual([]);
		expect(triggers()).toHaveLength(1);
	});

	it("does not claim disabled jobs", () => {
		const j = every(10);
		expect(s.setEnabled(j.id, false)).toBe(true);
		clock.advance(HOUR);
		expect(s.claimDue()).toEqual([]);
		expect(s.setEnabled(j.id, true)).toBe(true);
		expect(s.get(j.id)!.next_run_at).toBe(clock.now() + 10 * MINUTE);
		expect(s.setEnabled("job_nope", true)).toBe(false);
	});

	it("claims several due jobs in next_run_at order, each with its own Trigger", () => {
		const b = every(20, "b");
		const a = every(10, "a");
		clock.advance(25 * MINUTE);
		const runs = s.claimDue();
		expect(runs.map((r) => r.job.id)).toEqual([a.id, b.id]);
		expect(new Set(runs.map((r) => r.triggerId)).size).toBe(2);
	});

	it("RUN_LEASE_MS lets a dead run be reclaimed", () => {
		const j = every(10);
		clock.advance(10 * MINUTE);
		expect(s.claimDue()).toHaveLength(1);
		const claimedAt = clock.now();
		// Still within the lease: held.
		clock.t = claimedAt + RUN_LEASE_MS;
		expect(s.claimDue()).toEqual([]);
		// Past the lease: the run is presumed dead.
		clock.t = claimedAt + RUN_LEASE_MS + 1;
		const runs = s.claimDue();
		expect(runs).toHaveLength(1);
		expect(runs[0].slot).toBe(claimedAt + 10 * MINUTE);
		expect(s.get(j.id)!.running_since).toBe(clock.now());
		expect(triggers()).toHaveLength(2);
	});

	it("recover() releases every job a dead process held", () => {
		const a = every(10, "a");
		const b = every(10, "b");
		every(60, "c");
		clock.advance(10 * MINUTE);
		expect(s.claimDue()).toHaveLength(2);
		expect(s.recover()).toBe(2);
		expect(s.get(a.id)!.running_since).toBeNull();
		expect(s.get(b.id)!.running_since).toBeNull();
		expect(s.recover()).toBe(0);
		clock.advance(10 * MINUTE);
		expect(s.claimDue()).toHaveLength(2);
	});

	// Regression test (fixed bug): claimDue() runs the UPDATE (running_since = now, runs + 1) even when the Trigger INSERT
	// was a no-op because the slot already had a Trigger. No JobRun is returned, so nobody calls
	// complete(): the job is held as "running" by a run that does not exist until RUN_LEASE_MS
	// (6 h) passes, and `runs` counts a run that never happened. Reachable when next_run_at lands
	// on an already-triggered slot (e.g. setEnabled/ensure recompute after the clock steps back).
	// Fix: only mark the job running (and bump runs) when ins.changes === 1; otherwise just move
	// next_run_at forward.
	it("a slot whose Trigger already exists does not leave the job held as running", () => {
		tz = "Asia/Karachi";
		const j = s.create({ name: "morning", kind: "cron", spec: "0 9 * * *", prompt: "x", action: "remind", createdBy: "owner" });
		const slot = j.next_run_at!;
		clock.t = slot;
		expect(s.claimDue()).toHaveLength(1);
		s.complete(j.id, "ok");
		// The clock steps back (NTP) and the job is re-enabled: next_run_at is the same slot again.
		clock.t = slot - HOUR;
		s.setEnabled(j.id, true);
		expect(s.get(j.id)!.next_run_at).toBe(slot);
		clock.t = slot;
		expect(s.claimDue()).toEqual([]); // the Trigger already exists: no second run (correct)
		const after = s.get(j.id)!;
		expect(after.runs).toBe(1);
		expect(after.running_since).toBeNull();
	});
});

describe("ensure", () => {
	const heartbeat = { name: "heartbeat", kind: "every" as const, spec: "60", prompt: "built in", action: "agent" as const };

	it("creates a system job once and is idempotent", () => {
		const a = s.ensure(heartbeat);
		expect(a.created_by).toBe("system");
		clock.advance(5 * MINUTE);
		const b = s.ensure(heartbeat);
		expect(b.id).toBe(a.id);
		// Unchanged spec: next run is not pushed back by the restart.
		expect(b.next_run_at).toBe(a.next_run_at);
		expect(s.list()).toHaveLength(1);
	});

	it("updates the spec and next run when the spec changes", () => {
		const a = s.ensure(heartbeat);
		clock.advance(5 * MINUTE);
		const b = s.ensure({ ...heartbeat, spec: "30" });
		expect(b.id).toBe(a.id);
		expect(b.spec).toBe("30");
		expect(b.next_run_at).toBe(clock.now() + 30 * MINUTE);
		expect(s.list()).toHaveLength(1);
	});

	it("updates kind and re-enables a changed job", () => {
		const a = s.ensure(heartbeat);
		s.setEnabled(a.id, false);
		tz = "Asia/Karachi";
		const b = s.ensure({ ...heartbeat, name: "heartbeat", kind: "cron", spec: "0 4 * * *" });
		expect(b.kind).toBe("cron");
		expect(b.enabled).toBe(1);
		expect(b.next_run_at).toBe(Date.UTC(2026, 0, 5, 23, 0));
	});

	it("does not touch an owner job with the same name", () => {
		const owner = s.create({ ...heartbeat, createdBy: "owner" });
		const sys = s.ensure(heartbeat);
		expect(sys.id).not.toBe(owner.id);
		expect(s.list()).toHaveLength(2);
	});

	// Regression test (fixed bug): ensure() is documented as an upsert, and its UPDATE writes `action`, but the change
	// check (scheduler.ts:120) compares only spec, kind and prompt. A built-in job whose action
	// changes alone keeps the old action forever.
	// Fix: add `|| existing.action !== input.action` to the condition.
	it("updates the action when only the action changes", () => {
		s.ensure(heartbeat);
		const b = s.ensure({ ...heartbeat, action: "ticket" });
		expect(b.action).toBe("ticket");
	});
});

describe("remove", () => {
	it("removes owner jobs but never system jobs", () => {
		const own = every(10);
		const sys = s.ensure({ name: "heartbeat", kind: "every", spec: "60", prompt: "x", action: "agent" });
		expect(s.remove(sys.id)).toBe(false);
		expect(s.remove(own.id)).toBe(true);
		expect(s.remove(own.id)).toBe(false);
		expect(s.list().map((j) => j.id)).toEqual([sys.id]);
	});
});
