// The SQLite database: schema, migrations and the small typed helpers the core uses.
// node:sqlite needs no native build, which keeps `npm i` working on any small server.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS: string[] = [
	`
	CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);

	CREATE TABLE triggers (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		source TEXT NOT NULL,
		external_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		strength TEXT NOT NULL,
		payload TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'received',
		note TEXT,
		created_at INTEGER NOT NULL,
		processed_at INTEGER,
		UNIQUE (source, external_id)
	);
	CREATE INDEX triggers_status ON triggers (status, id);

	CREATE TABLE tickets (
		id TEXT PRIMARY KEY,
		short_name TEXT NOT NULL,
		title TEXT NOT NULL,
		mandate TEXT NOT NULL,
		origin TEXT NOT NULL,
		status TEXT NOT NULL,
		stage TEXT NOT NULL,
		last_report TEXT,
		dir TEXT NOT NULL,
		session_file TEXT,
		stopped_by_owner INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		ended_at INTEGER
	);

	CREATE TABLE ticket_inputs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ticket_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		text TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		created_at INTEGER NOT NULL,
		delivered_at INTEGER
	);
	CREATE INDEX ticket_inputs_pending ON ticket_inputs (ticket_id, status, id);

	CREATE TABLE attentions (
		id TEXT PRIMARY KEY,
		ticket_id TEXT,
		question TEXT NOT NULL,
		choices TEXT NOT NULL,
		status TEXT NOT NULL,
		answer TEXT,
		created_at INTEGER NOT NULL,
		answered_at INTEGER
	);

	CREATE TABLE approvals (
		id TEXT PRIMARY KEY,
		requester TEXT NOT NULL,
		tool TEXT NOT NULL,
		args TEXT NOT NULL,
		hash TEXT NOT NULL,
		reason TEXT NOT NULL,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		decided_at INTEGER,
		consumed_at INTEGER
	);

	CREATE TABLE outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		channel TEXT NOT NULL,
		conversation TEXT NOT NULL,
		text TEXT NOT NULL,
		buttons TEXT,
		reply_to TEXT,
		ref_kind TEXT,
		ref_id TEXT,
		order_key TEXT,
		status TEXT NOT NULL DEFAULT 'pending',
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL,
		last_error TEXT,
		external_id TEXT,
		created_at INTEGER NOT NULL,
		sent_at INTEGER
	);
	CREATE INDEX outbox_pending ON outbox (status, next_attempt_at);

	CREATE TABLE jobs (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		kind TEXT NOT NULL,
		spec TEXT NOT NULL,
		prompt TEXT NOT NULL,
		action TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		next_run_at INTEGER,
		running_since INTEGER,
		last_slot INTEGER,
		last_status TEXT,
		last_run_at INTEGER,
		runs INTEGER NOT NULL DEFAULT 0,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE watchers (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		kind TEXT NOT NULL,
		target TEXT NOT NULL,
		every_minutes INTEGER NOT NULL,
		instruction TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		last_value TEXT,
		last_checked_at INTEGER,
		last_error TEXT,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE notices (
		id TEXT PRIMARY KEY,
		urgency TEXT NOT NULL,
		effective TEXT NOT NULL,
		topic TEXT NOT NULL,
		text TEXT NOT NULL,
		decision TEXT NOT NULL,
		status TEXT NOT NULL,
		ticket_id TEXT,
		created_at INTEGER NOT NULL,
		resolved_at INTEGER
	);

	CREATE TABLE message_refs (
		channel TEXT NOT NULL,
		external_id TEXT NOT NULL,
		ref_kind TEXT NOT NULL,
		ref_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (channel, external_id)
	);

	CREATE TABLE events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		kind TEXT NOT NULL,
		text TEXT NOT NULL,
		data TEXT
	);
	`,
	`ALTER TABLE outbox ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;`,
];

export type Row = Record<string, SQLInputValue>;

const SECRET_PATTERNS = [
	/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
	/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, // Telegram bot tokens
	/\b(bearer|token|api[_-]?key|password|secret)(\s*[:=]\s*|\s+)["']?[A-Za-z0-9._~+/=-]{12,}/gi,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

/** Mask strings that look like credentials before they are logged or shown. */
export function scrubSecrets(text: string): string {
	let out = text;
	for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => `${m.slice(0, 4)}…[redacted]`);
	return out;
}

export class Db {
	readonly raw: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.raw = new DatabaseSync(path);
		this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		this.migrate();
	}

	private migrate(): void {
		this.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
		const row = this.raw.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
		let version = row?.version ?? 0;
		if (!row) this.raw.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
		while (version < MIGRATIONS.length) {
			this.tx(() => {
				this.raw.exec(MIGRATIONS[version]);
				this.raw.prepare("UPDATE schema_version SET version = ?").run(version + 1);
			});
			version++;
		}
	}

	/** Run `fn` in one transaction; nested calls join the outer one. */
	tx<T>(fn: () => T): T {
		if (this.depth > 0) {
			this.depth++;
			try {
				return fn();
			} finally {
				this.depth--;
			}
		}
		this.raw.exec("BEGIN IMMEDIATE");
		this.depth = 1;
		try {
			const out = fn();
			this.raw.exec("COMMIT");
			return out;
		} catch (err) {
			this.raw.exec("ROLLBACK");
			throw err;
		} finally {
			this.depth = 0;
		}
	}
	private depth = 0;

	run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
		const r = this.raw.prepare(sql).run(...params);
		return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
	}

	get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
		return this.raw.prepare(sql).get(...params) as T | undefined;
	}

	all<T>(sql: string, ...params: SQLInputValue[]): T[] {
		return this.raw.prepare(sql).all(...params) as T[];
	}

	getKv<T>(key: string): T | undefined {
		const row = this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
		return row ? (JSON.parse(row.value) as T) : undefined;
	}

	setKv(key: string, value: unknown, now = Date.now()): void {
		this.run(
			"INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
			key,
			JSON.stringify(value),
			now,
		);
	}

	/** Append to the audit log the panel and `vigil status` show. Token-looking strings are masked. */
	event(kind: string, text: string, data?: unknown, now = Date.now()): void {
		this.run(
			"INSERT INTO events (at, kind, text, data) VALUES (?, ?, ?, ?)",
			now,
			kind,
			scrubSecrets(text),
			data === undefined ? null : JSON.stringify(data),
		);
	}

	close(): void {
		this.raw.close();
	}
}
