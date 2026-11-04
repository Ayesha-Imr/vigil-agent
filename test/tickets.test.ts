// Unit tests for tickets: creation, report-driven stage transitions, owner stop semantics,
// reopening on input and the input queue.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Mandate, type Origin, type ReportKind, type Stage, type Ticket, Tickets } from "../src/core/tickets.ts";
import { MINUTE, ManualClock } from "../src/core/time.ts";
import { Db } from "../src/store/db.ts";

let db: Db;
let clock: ManualClock;
let root: string;
let tickets: Tickets;

const mandate: Mandate = { request: "find me a cheaper flight to Lahore", strength: "explicit", scope: "search and compare, no booking" };
const origin: Origin = { channel: "telegram", conversation: "42", externalId: "42:7" };

beforeEach(() => {
	db = new Db(":memory:");
	clock = new ManualClock();
	root = mkdtempSync(join(tmpdir(), "vigil-tk-"));
	tickets = new Tickets(db, clock, root);
});

afterEach(() => {
	db.close();
	rmSync(root, { recursive: true, force: true });
});

function make(title = "Cheaper flight to Lahore!", shortName?: string): Ticket {
	return tickets.create({ title, shortName, mandate, origin });
}

describe("create / get / list", () => {
	it("opens a queued ticket with its mandate, origin and directory", () => {
		const t = make();
		expect(t.id).toMatch(/^tk_[0-9a-f]{6}$/);
		expect(t.short_name).toBe(`cheaper-flight-to-lahore-${t.id.slice(3)}`);
		expect(t).toMatchObject({ status: "open", stage: "queued", mandate, origin, last_report: null, stopped_by_owner: 0, ended_at: null });
		expect(t.dir).toBe(join(root, t.short_name));
		expect(existsSync(t.dir)).toBe(true);
		expect(t.created_at).toBe(clock.now());
	});

	it("uses the short name when given and falls back to 'task' for an unsluggable title", () => {
		expect(make("x", "Flights: LHE").short_name).toMatch(/^flights-lhe-/);
		expect(make("!!!").short_name).toMatch(/^task-/);
		expect(make("a".repeat(100)).short_name.length).toBeLessThanOrEqual(40 + 7);
	});

	it("get finds by id or short name", () => {
		const t = make();
		expect(tickets.get(t.id)?.id).toBe(t.id);
		expect(tickets.get(t.short_name)?.id).toBe(t.id);
		expect(tickets.get("tk_nope")).toBeUndefined();
	});

	it("list filters open, recent and all", () => {
		const a = make("a");
		clock.advance(MINUTE);
		const b = make("b");
		clock.advance(MINUTE);
		tickets.report(a.id, "ready", "done");
		expect(tickets.list("open").map((t) => t.id)).toEqual([b.id]);
		expect(tickets.list("all").map((t) => t.id)).toEqual([a.id, b.id]);
		// Most recently updated first: a was just reported.
		expect(tickets.list("recent").map((t) => t.id)).toEqual([a.id, b.id]);
		expect(tickets.list().map((t) => t.id)).toEqual([b.id]);
	});

	it("records an audit event", () => {
		const t = make();
		expect(db.all<{ kind: string }>("SELECT kind FROM events WHERE kind = 'ticket.created'")).toHaveLength(1);
		expect(db.get<{ data: string }>("SELECT data FROM events WHERE kind = 'ticket.created'")!.data).toContain(t.id);
	});
});

describe("report", () => {
	const cases: [ReportKind, Stage, "open" | "ended"][] = [
		["progress", "working", "open"],
		["waiting", "idle", "open"],
		["blocked", "blocked", "open"],
		["failed", "failed", "open"],
		["ready", "done", "ended"],
		["dropped", "done", "ended"],
	];
	it.each(cases)("%s -> stage %s, status %s", (kind, stage, status) => {
		const t = make();
		clock.advance(MINUTE);
		const after = tickets.report(t.id, kind, `summary ${kind}`)!;
		expect(after.stage).toBe(stage);
		expect(after.status).toBe(status);
		expect(after.last_report).toEqual({ kind, summary: `summary ${kind}`, at: clock.now() });
		expect(after.updated_at).toBe(clock.now());
		expect(after.ended_at).toBe(status === "ended" ? clock.now() : null);
	});

	it("an unknown ticket returns undefined", () => {
		expect(tickets.report("tk_nope", "ready", "x")).toBeUndefined();
	});

	it("setStage and setSessionFile", () => {
		const t = make();
		tickets.setStage(t.id, "working");
		tickets.setSessionFile(t.id, "/s/1.jsonl");
		expect(tickets.get(t.id)).toMatchObject({ stage: "working", session_file: "/s/1.jsonl" });
	});
});

describe("stop", () => {
	it("only the owner's stop withdraws the mandate: ends it, marks it, and withdraws pending inputs", () => {
		const t = make();
		tickets.addInput(t.id, "owner_message", "also check trains");
		clock.advance(MINUTE);
		expect(tickets.stop(t.id)).toBe(true);
		const after = tickets.get(t.id)!;
		expect(after).toMatchObject({ status: "ended", stage: "stopped", stopped_by_owner: 1, ended_at: clock.now() });
		expect(tickets.hasPendingInputs(t.id)).toBe(false);
		expect(tickets.takeInputs(t.id)).toEqual([]);
		expect(tickets.runnable()).toEqual([]);
	});

	it("is idempotent: a second stop changes nothing", () => {
		const t = make();
		expect(tickets.stop(t.id)).toBe(true);
		const at = tickets.get(t.id)!.ended_at;
		clock.advance(MINUTE);
		expect(tickets.stop(t.id)).toBe(false);
		expect(tickets.get(t.id)!.ended_at).toBe(at);
		expect(tickets.stop("tk_nope")).toBe(false);
	});

	it("a stopped ticket rejects every kind of input and does not reopen", () => {
		const t = make();
		tickets.stop(t.id);
		for (const kind of ["owner_message", "answer", "note", "resume", "recovery"] as const) {
			expect(tickets.addInput(t.id, kind, "please continue")).toBe(false);
		}
		expect(tickets.get(t.id)).toMatchObject({ status: "ended", stage: "stopped" });
		expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ticket_inputs")!.n).toBe(0);
	});

	it("a worker's 'dropped' report ends the ticket but does not withdraw it: input reopens it", () => {
		const t = make();
		tickets.report(t.id, "dropped", "nothing to do");
		expect(tickets.get(t.id)!.stopped_by_owner).toBe(0);
		expect(tickets.addInput(t.id, "owner_message", "actually, try again")).toBe(true);
		expect(tickets.get(t.id)).toMatchObject({ status: "open", stage: "queued", ended_at: null });
	});

	it("the owner can stop an ended ticket, after which it can no longer reopen", () => {
		const t = make();
		tickets.report(t.id, "ready", "found one");
		expect(tickets.stop(t.id)).toBe(true);
		expect(tickets.addInput(t.id, "owner_message", "more")).toBe(false);
	});
});

describe("addInput", () => {
	it("an ended (ready) ticket reopens on input", () => {
		const t = make();
		tickets.report(t.id, "ready", "found PKR 80k");
		clock.advance(MINUTE);
		expect(tickets.addInput(t.id, "owner_message", "book the cheapest")).toBe(true);
		const after = tickets.get(t.id)!;
		expect(after).toMatchObject({ status: "open", stage: "queued", ended_at: null, updated_at: clock.now() });
		expect(tickets.runnable().map((x) => x.id)).toEqual([t.id]);
	});

	it.each(["blocked", "failed", "idle", "answer", "review"] as Stage[])("releases a %s ticket to queued", (stage) => {
		const t = make();
		tickets.setStage(t.id, stage);
		tickets.addInput(t.id, "answer", "yes");
		expect(tickets.get(t.id)!.stage).toBe("queued");
	});

	it("a working ticket stays working; the input waits", () => {
		const t = make();
		tickets.setStage(t.id, "working");
		tickets.addInput(t.id, "owner_message", "hurry");
		expect(tickets.get(t.id)!.stage).toBe("working");
		expect(tickets.hasPendingInputs(t.id)).toBe(true);
		// Working tickets are not runnable even with input waiting (the worker takes it next turn).
		expect(tickets.runnable()).toEqual([]);
	});

	it("an unknown ticket rejects input", () => {
		expect(tickets.addInput("tk_nope", "note", "x")).toBe(false);
	});
});

describe("takeInputs", () => {
	it("takes every pending input oldest first and marks them delivered, atomically", () => {
		const t = make();
		tickets.addInput(t.id, "owner_message", "one");
		clock.advance(1);
		tickets.addInput(t.id, "note", "two");
		tickets.addInput(t.id, "answer", "three");
		const other = make("other");
		tickets.addInput(other.id, "note", "not mine");

		const got = tickets.takeInputs(t.id);
		expect(got.map((i) => [i.kind, i.text, i.status])).toEqual([
			["owner_message", "one", "pending"],
			["note", "two", "pending"],
			["answer", "three", "pending"],
		]);
		expect(got[0].id).toBeLessThan(got[1].id);
		expect(tickets.takeInputs(t.id)).toEqual([]);
		expect(tickets.hasPendingInputs(t.id)).toBe(false);
		expect(db.all<{ status: string }>("SELECT status FROM ticket_inputs WHERE ticket_id = ?", t.id).every((r) => r.status === "delivered")).toBe(true);
		// The other ticket's input is untouched.
		expect(tickets.takeInputs(other.id).map((i) => i.text)).toEqual(["not mine"]);
	});

	it("inputs added after a take are taken next time", () => {
		const t = make();
		tickets.addInput(t.id, "note", "a");
		expect(tickets.takeInputs(t.id)).toHaveLength(1);
		tickets.addInput(t.id, "note", "b");
		expect(tickets.takeInputs(t.id).map((i) => i.text)).toEqual(["b"]);
	});

	it("is all-or-nothing: a failure inside the transaction leaves every input pending", () => {
		const t = make();
		tickets.addInput(t.id, "note", "a");
		// The UPDATE runs and then the transaction fails: it must roll back, not half-deliver.
		const orig = db.run.bind(db);
		db.run = ((sql: string, ...p: never[]) => {
			if (sql.startsWith("UPDATE ticket_inputs")) {
				orig(sql, ...p);
				throw new Error("disk I/O error");
			}
			return orig(sql, ...p);
		}) as typeof db.run;
		expect(() => tickets.takeInputs(t.id)).toThrow("disk I/O error");
		db.run = orig;
		expect(tickets.hasPendingInputs(t.id)).toBe(true);
		expect(tickets.takeInputs(t.id).map((i) => i.text)).toEqual(["a"]);
	});
});

describe("runnable", () => {
	it("lists open tickets that are queued or have inputs waiting", () => {
		const queued = make("queued");
		const idleWithInput = make("idle");
		tickets.report(idleWithInput.id, "waiting", "waiting for owner");
		// Insert input without moving the stage, as a worker-internal note would.
		db.run("INSERT INTO ticket_inputs (ticket_id, kind, text, created_at) VALUES (?, 'note', 'x', 0)", idleWithInput.id);
		const idle = make("idle-empty");
		tickets.report(idle.id, "waiting", "nothing");
		const ended = make("ended");
		tickets.report(ended.id, "ready", "done");
		expect(tickets.runnable().map((t) => t.id).sort()).toEqual([queued.id, idleWithInput.id].sort());
	});
});
