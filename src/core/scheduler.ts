// The scheduler: jobs the owner created (cron, every N minutes, once at a time). Each due slot
// becomes exactly one Trigger (keyed job:slot), a job never overlaps itself, and slots missed
// while vigil was down coalesce into one run.

import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Db } from "../store/db.ts";
import { type Clock, MINUTE } from "./time.ts";

export type JobKind = "cron" | "every" | "at";

/**
 * What a run does:
 * - `remind`: send the prompt text to the owner as is. No model call. The owner asked for it at
 *   this time, so it is a solicited message and does not pass the attention governor.
 * - `agent`: give the prompt to the concierge, which decides what to do and whether to say anything.
 * - `ticket`: open a background ticket with the prompt as its mandate.
 */
export type JobAction = "remind" | "agent" | "ticket";

export interface Job {
	id: string;
	name: string;
	kind: JobKind;
	spec: string;
	prompt: string;
	action: JobAction;
	enabled: number;
	next_run_at: number | null;
	running_since: number | null;
	last_slot: number | null;
	last_status: string | null;
	last_run_at: number | null;
	runs: number;
	created_by: string;
	created_at: number;
}

export interface JobRun {
	job: Job;
	slot: number;
	/** Slots skipped because vigil was down or the previous run was still going. */
	coalesced: number;
	triggerId: number;
}

/** A run that has held its job longer than this is presumed dead (its process is gone). */
export const RUN_LEASE_MS = 6 * 60 * MINUTE;

export function nextRunAt(kind: JobKind, spec: string, after: number, tz: string): number | null {
	switch (kind) {
		case "cron": {
			const next = new Cron(spec, { timezone: tz, paused: true }).nextRun(new Date(after));
			return next ? next.getTime() : null;
		}
		case "every": {
			const minutes = Number(spec);
			if (!Number.isInteger(minutes) || minutes < 1) throw new Error(`"every" needs whole minutes >= 1, got "${spec}"`);
			return after + minutes * MINUTE;
		}
		case "at": {
			const t = Date.parse(spec);
			if (Number.isNaN(t)) throw new Error(`"at" needs an ISO time, got "${spec}"`);
			return t > after ? t : null;
		}
	}
}

/** Count the slots in (from, to) that a coalesced run stands for, capped for cost. */
function countSlots(kind: JobKind, spec: string, from: number, to: number, tz: string): number {
	if (kind === "at") return 0;
	let n = 0;
	let t = from;
	while (n < 1000) {
		const next = nextRunAt(kind, spec, t, tz);
		if (next === null || next >= to) break;
		n++;
		t = next;
	}
	return n;
}

export class Scheduler {
	private readonly db: Db;
	private readonly clock: Clock;
	private readonly tz: () => string;

	constructor(db: Db, clock: Clock, tz: () => string) {
		this.db = db;
		this.clock = clock;
		this.tz = tz;
	}

	create(input: { name: string; kind: JobKind; spec: string; prompt: string; action: JobAction; createdBy: string }): Job {
		const now = this.clock.now();
		const next = nextRunAt(input.kind, input.spec, now, this.tz());
		if (next === null) throw new Error(`job "${input.name}" would never run`);
		const id = `job_${randomUUID().slice(0, 8)}`;
		this.db.run(
			`INSERT INTO jobs (id, name, kind, spec, prompt, action, enabled, next_run_at, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
			id,
			input.name,
			input.kind,
			input.spec,
			input.prompt,
			input.action,
			next,
			input.createdBy,
			now,
		);
		this.db.event("job.created", `${input.name} (${input.kind} ${input.spec}) → ${input.action}`, { id });
		return this.get(id)!;
	}

	/** Upsert a built-in job by name (heartbeat, dream) so restarts do not duplicate it. */
	ensure(input: { name: string; kind: JobKind; spec: string; prompt: string; action: JobAction }): Job {
		const existing = this.db.get<Job>("SELECT * FROM jobs WHERE name = ? AND created_by = 'system'", input.name);
		if (!existing) return this.create({ ...input, createdBy: "system" });
		if (existing.spec !== input.spec || existing.kind !== input.kind || existing.prompt !== input.prompt || existing.action !== input.action) {
			const next = nextRunAt(input.kind, input.spec, this.clock.now(), this.tz());
			this.db.run(
				"UPDATE jobs SET kind = ?, spec = ?, prompt = ?, action = ?, next_run_at = ?, enabled = 1 WHERE id = ?",
				input.kind,
				input.spec,
				input.prompt,
				input.action,
				next,
				existing.id,
			);
		}
		return this.get(existing.id)!;
	}

	/**
	 * Claim every due job: one transaction records the Trigger for the slot, marks the job as
	 * running, and moves its next run past now. The Trigger's unique key makes a replay harmless.
	 */
	claimDue(): JobRun[] {
		const now = this.clock.now();
		const tz = this.tz();
		return this.db.tx(() => {
			const due = this.db.all<Job>(
				`SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
				 AND (running_since IS NULL OR running_since < ?) ORDER BY next_run_at`,
				now,
				now - RUN_LEASE_MS,
			);
			const runs: JobRun[] = [];
			for (const job of due) {
				const slot = job.next_run_at!;
				const next = nextRunAt(job.kind, job.spec, now, tz);
				const coalesced = countSlots(job.kind, job.spec, slot, now, tz);
				const ins = this.db.run(
					`INSERT INTO triggers (source, external_id, kind, strength, payload, created_at)
					 VALUES ('clock', ?, 'job', 'explicit', ?, ?) ON CONFLICT(source, external_id) DO NOTHING`,
					`${job.id}:${slot}`,
					JSON.stringify({ jobId: job.id, slot, coalesced }),
					now,
				);
				const fresh = ins.changes === 1;
				// A slot that already has its trigger (a replay) only moves the schedule on; it starts no run,
				// so it must not mark the job running, or nothing would ever complete it.
				this.db.run(
					`UPDATE jobs SET running_since = CASE WHEN ? THEN ? ELSE running_since END, last_slot = ?, next_run_at = ?,
					 runs = runs + ?, enabled = CASE WHEN ? IS NULL AND kind = 'at' THEN 0 ELSE enabled END WHERE id = ?`,
					fresh ? 1 : 0,
					now,
					slot,
					next,
					fresh ? 1 : 0,
					next,
					job.id,
				);
				if (fresh) runs.push({ job, slot, coalesced, triggerId: ins.lastInsertRowid });
			}
			return runs;
		});
	}

	/** A run finished: free the job for its next slot. */
	complete(jobId: string, status: string): void {
		this.db.run(
			"UPDATE jobs SET running_since = NULL, last_status = ?, last_run_at = ? WHERE id = ?",
			status.slice(0, 500),
			this.clock.now(),
			jobId,
		);
	}

	/** On startup no run is alive: release every job that a dead process held. */
	recover(): number {
		return this.db.run("UPDATE jobs SET running_since = NULL WHERE running_since IS NOT NULL").changes;
	}

	setEnabled(id: string, enabled: boolean): boolean {
		const job = this.get(id);
		if (!job) return false;
		const next = enabled ? nextRunAt(job.kind, job.spec, this.clock.now(), this.tz()) : job.next_run_at;
		return this.db.run("UPDATE jobs SET enabled = ?, next_run_at = ? WHERE id = ?", enabled ? 1 : 0, next, id).changes === 1;
	}

	remove(id: string): boolean {
		return this.db.run("DELETE FROM jobs WHERE id = ? AND created_by != 'system'", id).changes === 1;
	}

	get(id: string): Job | undefined {
		return this.db.get<Job>("SELECT * FROM jobs WHERE id = ?", id);
	}

	list(): Job[] {
		return this.db.all<Job>("SELECT * FROM jobs ORDER BY created_by = 'system', next_run_at");
	}
}
