// Unit and model-based tests for approvals: decide only pending and unexpired, consume only an
// approved call with the same hash and only once, expiry, and wait().

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApprovalStatus, Approvals, callHash, stableStringify } from "../src/core/approvals.ts";
import { MINUTE, ManualClock } from "../src/core/time.ts";
import { Db } from "../src/store/db.ts";

let db: Db;
let clock: ManualClock;
let ap: Approvals;

beforeEach(() => {
	db = new Db(":memory:");
	clock = new ManualClock();
	ap = new Approvals(db, clock);
});

afterEach(() => {
	vi.useRealTimers();
	db.close();
});

const TTL = 30 * MINUTE;
const args = { command: "git push origin main" };
const hash = callHash("bash", args);
const req = (a: unknown = args, ttl = TTL) => ap.request("tk_1", "bash", a, "pushes to a remote", ttl);

describe("callHash / stableStringify", () => {
	it("ignores key order and undefined fields", () => {
		expect(callHash("bash", { a: 1, b: { c: [1, { d: 2, e: 3 }] } })).toBe(callHash("bash", { b: { c: [1, { e: 3, d: 2 }] }, a: 1, z: undefined }));
		expect(stableStringify({ b: 1, a: [true, null, "x"] })).toBe(`{"a":[true,null,"x"],"b":1}`);
	});

	it("differs by tool and by arguments", () => {
		expect(callHash("bash", args)).not.toBe(callHash("write", args));
		expect(callHash("bash", args)).not.toBe(callHash("bash", { command: "git push origin main --force" }));
		// The separator keeps tool and args apart.
		expect(callHash("ab", "c")).not.toBe(callHash("a", "bc"));
	});

	it("property: equal JSON values hash equally regardless of key order", () => {
		fc.assert(
			fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
				const reversed = Object.fromEntries(Object.entries(obj).reverse());
				expect(callHash("t", reversed)).toBe(callHash("t", obj));
			}),
		);
	});
});

describe("request", () => {
	it("stores a pending approval bound to the call", () => {
		const a = req();
		expect(a).toMatchObject({ requester: "tk_1", tool: "bash", hash, status: "pending", created_at: clock.now(), expires_at: clock.now() + TTL });
		expect(a.args).toBe(stableStringify(args));
		expect(ap.get(a.id)).toEqual(a);
		expect(ap.pending().map((x) => x.id)).toEqual([a.id]);
	});
});

describe("decide", () => {
	it("approves a pending, unexpired approval once", () => {
		const a = req();
		const r = ap.decide(a.id, true);
		expect(r.changed).toBe(true);
		expect(r.approval).toMatchObject({ status: "approved", decided_at: clock.now() });
		expect(ap.pending()).toEqual([]);
	});

	it("ignores a second tap, including a contradicting one", () => {
		const a = req();
		ap.decide(a.id, true);
		expect(ap.decide(a.id, false)).toMatchObject({ changed: false, approval: { status: "approved" } });
		expect(ap.decide(a.id, true).changed).toBe(false);
		const b = req();
		ap.decide(b.id, false);
		expect(ap.decide(b.id, true)).toMatchObject({ changed: false, approval: { status: "denied" } });
	});

	it("ignores a decision at or after expiry, even before expire() ran", () => {
		const a = req();
		clock.advance(TTL);
		expect(ap.decide(a.id, true)).toMatchObject({ changed: false, approval: { status: "pending" } });
		expect(ap.consume(a.id, hash)).toBe(false);
	});

	it("ignores unknown ids and consumed approvals", () => {
		expect(ap.decide("ap_nope", true)).toEqual({ changed: false, approval: undefined });
		const a = req();
		ap.decide(a.id, true);
		ap.consume(a.id, hash);
		expect(ap.decide(a.id, true).changed).toBe(false);
	});
});

describe("consume", () => {
	it("is true once for an approved call with the same hash", () => {
		const a = req();
		ap.decide(a.id, true);
		expect(ap.consume(a.id, hash)).toBe(true);
		expect(ap.get(a.id)).toMatchObject({ status: "consumed", consumed_at: clock.now() });
		expect(ap.consume(a.id, hash)).toBe(false);
	});

	it("is false for a different call (hash mismatch), and the approval stays usable", () => {
		const a = req();
		ap.decide(a.id, true);
		expect(ap.consume(a.id, callHash("bash", { command: "git push --force origin main" }))).toBe(false);
		expect(ap.get(a.id)!.status).toBe("approved");
		expect(ap.consume(a.id, hash)).toBe(true);
	});

	it("is false for pending, denied, expired and unknown approvals", () => {
		const pending = req();
		expect(ap.consume(pending.id, hash)).toBe(false);
		const denied = req();
		ap.decide(denied.id, false);
		expect(ap.consume(denied.id, hash)).toBe(false);
		expect(ap.consume("ap_nope", hash)).toBe(false);
	});

	it("is false for an approved call past its expiry, even before expire() ran", () => {
		const a = req();
		ap.decide(a.id, true);
		clock.advance(TTL);
		expect(ap.consume(a.id, hash)).toBe(false);
	});
});

describe("expire", () => {
	it("expires pending and approved-but-unused approvals past their time, nothing else", () => {
		const pending = req(args, MINUTE);
		const approved = req(args, MINUTE);
		ap.decide(approved.id, true);
		const denied = req(args, MINUTE);
		ap.decide(denied.id, false);
		const consumed = req(args, MINUTE);
		ap.decide(consumed.id, true);
		ap.consume(consumed.id, hash);
		const later = req(args, 2 * MINUTE);

		clock.advance(MINUTE - 1);
		expect(ap.expire()).toBe(0);
		clock.advance(1);
		expect(ap.expire()).toBe(2);
		const status = (id: string) => ap.get(id)!.status;
		expect([status(pending.id), status(approved.id), status(denied.id), status(consumed.id), status(later.id)]).toEqual([
			"expired",
			"expired",
			"denied",
			"consumed",
			"pending",
		]);
		expect(ap.expire()).toBe(0);
		expect(ap.decide(pending.id, true).changed).toBe(false);
	});
});

describe("wait", () => {
	it("resolves approved when the owner approves", async () => {
		const a = req();
		const p = ap.wait(a.id);
		ap.decide(a.id, true);
		await expect(p).resolves.toBe("approved");
	});

	it("resolves denied when the owner denies", async () => {
		const a = req();
		const p = ap.wait(a.id);
		ap.decide(a.id, false);
		await expect(p).resolves.toBe("denied");
	});

	it("resolves expired when expire() runs past the deadline", async () => {
		const a = req();
		const p = ap.wait(a.id);
		clock.advance(TTL);
		ap.expire();
		await expect(p).resolves.toBe("expired");
	});

	it("resolves expired by its own timer at the deadline and marks the record", async () => {
		vi.useFakeTimers();
		const a = req(args, 10_000);
		let outcome: string | undefined;
		void ap.wait(a.id).then((o) => {
			outcome = o;
		});
		clock.advance(10_000);
		await vi.advanceTimersByTimeAsync(10_049);
		expect(outcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(outcome).toBe("expired");
		expect(ap.get(a.id)!.status).toBe("expired");
	});

	it("resolves immediately for an already decided or unknown approval", async () => {
		const a = req();
		ap.decide(a.id, true);
		await expect(ap.wait(a.id)).resolves.toBe("approved");
		const d = req();
		ap.decide(d.id, false);
		await expect(ap.wait(d.id)).resolves.toBe("denied");
		await expect(ap.wait("ap_nope")).resolves.toBe("expired");
		const c = req();
		ap.decide(c.id, true);
		ap.consume(c.id, hash);
		await expect(ap.wait(c.id)).resolves.toBe("expired");
	});

	it("resolves expired when the caller aborts", async () => {
		const a = req();
		const ctl = new AbortController();
		const p = ap.wait(a.id, ctl.signal);
		ctl.abort();
		await expect(p).resolves.toBe("expired");
	});

	it("a decision after the waiter resolved does not throw", async () => {
		const a = req();
		const p = ap.wait(a.id);
		ap.decide(a.id, false);
		await p;
		expect(ap.decide(a.id, true).changed).toBe(false);
	});
});

describe("model-based: random interleavings", () => {
	type Cmd =
		| { k: "request"; call: number; ttl: number }
		| { k: "decide"; idx: number; approve: boolean }
		| { k: "consume"; idx: number; call: number }
		| { k: "expire" }
		| { k: "advance"; ms: number };

	const CALLS: [string, Record<string, unknown>][] = [
		["bash", { command: "git push" }],
		["bash", { command: "git push --force" }],
		["write", { path: "/etc/hosts", content: "x" }],
	];

	const cmd: fc.Arbitrary<Cmd> = fc.oneof(
		{ weight: 3, arbitrary: fc.record({ k: fc.constant("request" as const), call: fc.integer({ min: 0, max: 2 }), ttl: fc.integer({ min: 1, max: 10 }).map((m) => m * MINUTE) }) },
		{ weight: 4, arbitrary: fc.record({ k: fc.constant("decide" as const), idx: fc.nat(20), approve: fc.boolean() }) },
		{ weight: 4, arbitrary: fc.record({ k: fc.constant("consume" as const), idx: fc.nat(20), call: fc.integer({ min: 0, max: 2 }) }) },
		{ weight: 1, arbitrary: fc.constant({ k: "expire" as const }) },
		{ weight: 3, arbitrary: fc.record({ k: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 6 * MINUTE }) }) },
	);

	interface ModelApproval {
		id: string;
		call: number;
		hash: string;
		expiresAt: number;
		status: ApprovalStatus;
		everDenied: boolean;
		everApproved: boolean;
		consumedTrue: number;
	}

	it("consume is true at most once per approval and never for denied, expired or mismatched calls", () => {
		const seen = { consumed: 0, refusedMismatch: 0, refusedExpired: 0 };
		fc.assert(
			fc.property(fc.array(cmd, { minLength: 1, maxLength: 60, size: "max" }), (cmds) => {
				const mdb = new Db(":memory:");
				const mclock = new ManualClock();
				const sut = new Approvals(mdb, mclock);
				const model: ModelApproval[] = [];
				try {
					for (const c of cmds) {
						const now = mclock.now();
						switch (c.k) {
							case "request": {
								const [tool, a] = CALLS[c.call];
								const r = sut.request("tk", tool, a, "why", c.ttl);
								model.push({ id: r.id, call: c.call, hash: callHash(tool, a), expiresAt: now + c.ttl, status: "pending", everDenied: false, everApproved: false, consumedTrue: 0 });
								break;
							}
							case "decide": {
								if (!model.length) break;
								const m = model[c.idx % model.length];
								const expect_ = m.status === "pending" && m.expiresAt > now;
								const r = sut.decide(m.id, c.approve);
								expect(r.changed).toBe(expect_);
								if (expect_) {
									m.status = c.approve ? "approved" : "denied";
									if (c.approve) m.everApproved = true;
									else m.everDenied = true;
								}
								break;
							}
							case "consume": {
								if (!model.length) break;
								const m = model[c.idx % model.length];
								const [tool, a] = CALLS[c.call];
								const h = callHash(tool, a);
								const wasExpired = m.expiresAt <= now;
								const predicted = m.status === "approved" && m.hash === h && !wasExpired;
								const ok = sut.consume(m.id, h);
								if (ok) seen.consumed++;
								else if (m.status === "approved" && m.hash !== h) seen.refusedMismatch++;
								else if (m.everApproved && m.consumedTrue === 0 && m.hash === h && wasExpired) seen.refusedExpired++;
								// The model's exact prediction...
								expect(ok).toBe(predicted);
								// ...and the safety properties themselves, stated independently of it.
								if (ok) {
									expect(m.consumedTrue).toBe(0); // at most once
									expect(m.everDenied).toBe(false); // never for a denied approval
									expect(wasExpired).toBe(false); // never past expiry
									expect(m.status).not.toBe("expired");
									expect(c.call).toBe(m.call); // never for another call
									m.consumedTrue++;
									m.status = "consumed";
								}
								break;
							}
							case "expire": {
								let n = 0;
								for (const m of model) {
									if ((m.status === "pending" || m.status === "approved") && m.expiresAt <= now) {
										m.status = "expired";
										n++;
									}
								}
								expect(sut.expire()).toBe(n);
								break;
							}
							case "advance":
								mclock.advance(c.ms);
								break;
						}
						// The stored state always matches the model.
						for (const m of model) expect(sut.get(m.id)!.status).toBe(m.status);
					}
					for (const m of model) expect(m.consumedTrue).toBeLessThanOrEqual(1);
				} finally {
					mdb.close();
				}
			}),
			{
				numRuns: 300,
				// Always include the classic attack sequences besides the random ones: replay, a
				// different call under the same approval, and use after expiry.
				examples: [
					[
						[
							{ k: "request", call: 0, ttl: MINUTE },
							{ k: "decide", idx: 0, approve: true },
							{ k: "consume", idx: 0, call: 1 },
							{ k: "consume", idx: 0, call: 0 },
							{ k: "consume", idx: 0, call: 0 },
							{ k: "request", call: 2, ttl: MINUTE },
							{ k: "decide", idx: 1, approve: true },
							{ k: "advance", ms: MINUTE },
							{ k: "consume", idx: 1, call: 2 },
							{ k: "expire" },
							{ k: "request", call: 0, ttl: MINUTE },
							{ k: "decide", idx: 2, approve: false },
							{ k: "decide", idx: 2, approve: true },
							{ k: "consume", idx: 2, call: 0 },
						],
					],
				],
			},
		);
		// The interesting cases were actually exercised.
		expect(seen.consumed).toBeGreaterThan(0);
		expect(seen.refusedMismatch).toBeGreaterThan(0);
		expect(seen.refusedExpired).toBeGreaterThan(0);
	});
});
