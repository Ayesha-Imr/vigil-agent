// Approvals: a risky tool call waits here until the owner says yes. An approval is bound to the
// exact call (a hash of tool and arguments), can be used once, and expires. The state machine
// is model-checked in verification/approvals/Approvals.tla.

import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../store/db.ts";
import type { Clock } from "./time.ts";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface Approval {
	id: string;
	requester: string;
	tool: string;
	args: string;
	hash: string;
	reason: string;
	status: ApprovalStatus;
	created_at: number;
	expires_at: number;
	decided_at: number | null;
	consumed_at: number | null;
}

/** The identity of a call: same tool and same arguments give the same hash. */
export function callHash(tool: string, args: unknown): string {
	return createHash("sha256").update(tool).update("\0").update(stableStringify(args)).digest("hex");
}

export function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const entries = Object.entries(v as Record<string, unknown>)
		.filter(([, x]) => x !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(",")}}`;
}

export type Outcome = "approved" | "denied" | "expired";

export class Approvals {
	private readonly db: Db;
	private readonly clock: Clock;
	private readonly waiters = new Map<string, (o: Outcome) => void>();
	private disposed = false;

	constructor(db: Db, clock: Clock) {
		this.db = db;
		this.clock = clock;
	}

	/** Record a request. The caller sends it to the owner and then waits with wait(). */
	request(requester: string, tool: string, args: unknown, reason: string, ttlMs: number): Approval {
		const now = this.clock.now();
		const a: Approval = {
			id: `ap_${randomUUID().slice(0, 8)}`,
			requester,
			tool,
			args: stableStringify(args),
			hash: callHash(tool, args),
			reason,
			status: "pending",
			created_at: now,
			expires_at: now + ttlMs,
			decided_at: null,
			consumed_at: null,
		};
		this.db.run(
			`INSERT INTO approvals (id, requester, tool, args, hash, reason, status, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			a.id,
			a.requester,
			a.tool,
			a.args,
			a.hash,
			a.reason,
			a.status,
			a.created_at,
			a.expires_at,
		);
		this.db.event("approval.requested", `${requester} asks to run ${tool}: ${reason}`, { id: a.id });
		return a;
	}

	/** Wait for the owner's decision or the expiry, whichever comes first. */
	wait(id: string, signal?: AbortSignal): Promise<Outcome> {
		const a = this.get(id);
		if (!a) return Promise.resolve("expired");
		if (a.status === "approved") return Promise.resolve("approved");
		if (a.status !== "pending") return Promise.resolve(a.status === "denied" ? "denied" : "expired");
		if (this.disposed) return Promise.resolve("expired");
		return new Promise((resolve) => {
			const done = (o: Outcome) => {
				clearTimeout(timer);
				this.waiters.delete(id);
				resolve(o);
			};
			const timer = setTimeout(() => {
				if (this.disposed) return done("expired");
				this.expire();
				done(this.get(id)?.status === "approved" ? "approved" : "expired");
			}, Math.max(0, a.expires_at - this.clock.now()) + 50);
			this.waiters.set(id, done);
			// Nobody will run the call any more: expire the request so a late tap cannot approve it.
			signal?.addEventListener(
				"abort",
				() => {
					this.db.run("UPDATE approvals SET status = 'expired' WHERE id = ? AND status IN ('pending', 'approved')", id);
					done("expired");
				},
				{ once: true },
			);
		});
	}

	/**
	 * The owner decided. Only a pending, unexpired approval changes; anything else (a second tap, a
	 * stale button, a decision after expiry) is ignored and reported as such.
	 */
	decide(id: string, approve: boolean): { changed: boolean; approval?: Approval } {
		const now = this.clock.now();
		const r = this.db.run(
			"UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
			approve ? "approved" : "denied",
			now,
			id,
			now,
		);
		const approval = this.get(id);
		if (r.changes === 1) {
			this.db.event("approval.decided", `${approve ? "approved" : "denied"} ${approval?.tool}`, { id });
			this.waiters.get(id)?.(approve ? "approved" : "denied");
		}
		return { changed: r.changes === 1, approval };
	}

	/**
	 * Use an approval to run exactly the call it was granted for. True at most once per approval,
	 * and only for the same hash, before expiry.
	 */
	consume(id: string, hash: string): boolean {
		const now = this.clock.now();
		const r = this.db.run(
			"UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved' AND hash = ? AND expires_at > ?",
			now,
			id,
			hash,
			now,
		);
		return r.changes === 1;
	}

	/** Expire every pending or approved-but-unused approval past its time. */
	expire(): number {
		const now = this.clock.now();
		const ids = this.db.all<{ id: string }>(
			"SELECT id FROM approvals WHERE status IN ('pending', 'approved') AND expires_at <= ?",
			now,
		);
		this.db.run("UPDATE approvals SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= ?", now);
		for (const { id } of ids) this.waiters.get(id)?.("expired");
		return ids.length;
	}

	/** Shutdown: every waiting call is refused and no timer outlives the database. */
	dispose(): void {
		this.disposed = true;
		for (const done of [...this.waiters.values()]) done("expired");
		this.waiters.clear();
	}

	get(id: string): Approval | undefined {
		return this.db.get<Approval>("SELECT * FROM approvals WHERE id = ?", id);
	}

	pending(): Approval[] {
		return this.db.all<Approval>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at");
	}
}
