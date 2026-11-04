// Tickets: units of background work. A ticket holds its Mandate (what the owner asked for and
// why vigil may do it), where it came from, its stage, and a queue of inputs for its worker.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChannelId } from "../config.ts";
import type { Db } from "../store/db.ts";
import type { Clock } from "./time.ts";

export type Strength = "explicit" | "inferred";

export interface Mandate {
	/** The owner's request in their own words, or the job/watcher rule that allowed the work. */
	request: string;
	strength: Strength;
	/** What the work may include, in one or two sentences. */
	scope: string;
	/** A job id or watcher id when the work came from a rule rather than a message. */
	rule?: string;
}

export interface Origin {
	channel: ChannelId | "system";
	conversation: string;
	/** The message the ticket answers, for threading replies. */
	externalId?: string;
}

export type ReportKind = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";

export interface Report {
	kind: ReportKind;
	summary: string;
	at: number;
}

/** What a ticket waits for. The first matching stage wins, like dsh-superagent's table. */
export type Stage = "queued" | "working" | "answer" | "review" | "blocked" | "failed" | "idle" | "done" | "stopped";

export interface Ticket {
	id: string;
	short_name: string;
	title: string;
	mandate: Mandate;
	origin: Origin;
	status: "open" | "ended";
	stage: Stage;
	last_report: Report | null;
	dir: string;
	session_file: string | null;
	stopped_by_owner: number;
	created_at: number;
	updated_at: number;
	ended_at: number | null;
}

interface TicketRow extends Omit<Ticket, "mandate" | "origin" | "last_report"> {
	mandate: string;
	origin: string;
	last_report: string | null;
}

export type InputKind = "owner_message" | "answer" | "note" | "resume" | "recovery";

export interface TicketInput {
	id: number;
	ticket_id: string;
	kind: InputKind;
	text: string;
	status: "pending" | "delivered";
	created_at: number;
}

function slug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

function parse(row: TicketRow): Ticket {
	return {
		...row,
		mandate: JSON.parse(row.mandate) as Mandate,
		origin: JSON.parse(row.origin) as Origin,
		last_report: row.last_report ? (JSON.parse(row.last_report) as Report) : null,
	};
}

export class Tickets {
	private readonly db: Db;
	private readonly clock: Clock;
	private readonly workRoot: string;

	constructor(db: Db, clock: Clock, workRoot: string) {
		this.db = db;
		this.clock = clock;
		this.workRoot = workRoot;
	}

	create(input: { title: string; shortName?: string; mandate: Mandate; origin: Origin }): Ticket {
		const now = this.clock.now();
		const id = `tk_${randomUUID().slice(0, 6)}`;
		const short = `${slug(input.shortName ?? input.title)}-${id.slice(3)}`;
		const dir = join(this.workRoot, short);
		mkdirSync(dir, { recursive: true });
		this.db.run(
			`INSERT INTO tickets (id, short_name, title, mandate, origin, status, stage, dir, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'open', 'queued', ?, ?, ?)`,
			id,
			short,
			input.title,
			JSON.stringify(input.mandate),
			JSON.stringify(input.origin),
			dir,
			now,
			now,
		);
		this.db.event("ticket.created", `${id} ${input.title}`, { id, strength: input.mandate.strength });
		return this.get(id)!;
	}

	get(id: string): Ticket | undefined {
		const row = this.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ? OR short_name = ?", id, id);
		return row ? parse(row) : undefined;
	}

	list(filter: "open" | "recent" | "all" = "open"): Ticket[] {
		const rows =
			filter === "open"
				? this.db.all<TicketRow>("SELECT * FROM tickets WHERE status = 'open' ORDER BY created_at")
				: filter === "recent"
					? this.db.all<TicketRow>("SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 20")
					: this.db.all<TicketRow>("SELECT * FROM tickets ORDER BY created_at");
		return rows.map(parse);
	}

	setStage(id: string, stage: Stage): void {
		this.db.run("UPDATE tickets SET stage = ?, updated_at = ? WHERE id = ?", stage, this.clock.now(), id);
	}

	setSessionFile(id: string, file: string): void {
		this.db.run("UPDATE tickets SET session_file = ? WHERE id = ?", file, id);
	}

	/** Record a worker's report and move the ticket to the stage it implies. */
	report(id: string, kind: ReportKind, summary: string): Ticket | undefined {
		const now = this.clock.now();
		const report: Report = { kind, summary, at: now };
		const stage: Stage =
			kind === "ready" ? "review" : kind === "blocked" ? "blocked" : kind === "failed" ? "failed" : kind === "waiting" ? "idle" : kind === "dropped" ? "done" : "working";
		const ends = kind === "ready" || kind === "dropped";
		this.db.run(
			`UPDATE tickets SET last_report = ?, stage = ?, updated_at = ?,
			 status = CASE WHEN ? THEN 'ended' ELSE status END, ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?`,
			JSON.stringify(report),
			ends ? "done" : stage,
			now,
			ends ? 1 : 0,
			ends ? 1 : 0,
			now,
			id,
		);
		this.db.event("ticket.report", `${id} ${kind}: ${summary.slice(0, 200)}`, { id, kind });
		return this.get(id);
	}

	/** The owner said stop. Only the owner's stop withdraws a mandate (dsh-superagent's rule). */
	stop(ref: string): boolean {
		const id = this.get(ref)?.id;
		if (!id) return false;
		const now = this.clock.now();
		const r = this.db.run(
			"UPDATE tickets SET status = 'ended', stage = 'stopped', stopped_by_owner = 1, ended_at = ?, updated_at = ? WHERE id = ? AND stopped_by_owner = 0",
			now,
			now,
			id,
		);
		if (r.changes) this.db.run("UPDATE ticket_inputs SET status = 'delivered', delivered_at = ? WHERE ticket_id = ? AND status = 'pending'", now, id);
		return r.changes === 1;
	}

	/** Queue an input. An ended ticket that the owner did not stop reopens. */
	addInput(ref: string, kind: InputKind, text: string): boolean {
		const t = this.get(ref);
		if (!t || t.stopped_by_owner) return false;
		// Callers may name a ticket by its short name; rows are keyed by the canonical id.
		const id = t.id;
		const now = this.clock.now();
		this.db.tx(() => {
			this.db.run("INSERT INTO ticket_inputs (ticket_id, kind, text, created_at) VALUES (?, ?, ?, ?)", id, kind, text, now);
			if (t.status === "ended") {
				this.db.run("UPDATE tickets SET status = 'open', stage = 'queued', ended_at = NULL, updated_at = ? WHERE id = ?", now, id);
			} else if (t.stage === "blocked" || t.stage === "failed" || t.stage === "idle" || t.stage === "answer" || t.stage === "review") {
				// A person's message releases a blocked or failed ticket to its worker.
				this.db.run("UPDATE tickets SET stage = 'queued', updated_at = ? WHERE id = ?", now, id);
			}
		});
		return true;
	}

	/** Take every pending input of a ticket, oldest first, marking it delivered. */
	takeInputs(id: string): TicketInput[] {
		return this.db.tx(() => {
			const rows = this.db.all<TicketInput>("SELECT * FROM ticket_inputs WHERE ticket_id = ? AND status = 'pending' ORDER BY id", id);
			if (rows.length) this.db.run("UPDATE ticket_inputs SET status = 'delivered', delivered_at = ? WHERE ticket_id = ? AND status = 'pending'", this.clock.now(), id);
			return rows;
		});
	}

	hasPendingInputs(id: string): boolean {
		return (this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ticket_inputs WHERE ticket_id = ? AND status = 'pending'", id)?.n ?? 0) > 0;
	}

	/** Open tickets that have work to do: queued, or with inputs waiting. */
	runnable(): Ticket[] {
		return this.list("open").filter((t) => t.stage === "queued" || (t.stage !== "working" && this.hasPendingInputs(t.id)));
	}
}
