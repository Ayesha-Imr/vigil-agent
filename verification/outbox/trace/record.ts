// Trace recorder for trace validation of the outbox against verification/outbox/Outbox.tla.
//
// Drives a real `Outbox` (src/core/outbox.ts) on a real in-memory `Db` (src/store/db.ts) with a
// ManualClock and a scripted channel whose every send() the recorder answers by hand: success,
// a try-later error, PermanentSendError, no answer until the 90 s timer fires (the timer is the
// real `withTimeout`'s, run on a fake setTimeout), or never (a crash). Between those it calls
// enqueue and deliverDue (also while a pass is in flight: the overlapping call), moves the clock,
// lets abandoned sends land or fail, and crashes and restarts the process (a new Outbox on the
// same Db, with or without the channel). src/ is not edited: the recorder wraps the Db instance's
// run/tx/all and the channel to see where the code is.
//
// Each run is one NDJSON file: line 1 is the header (the scenario, i.e. Outbox.tla's Items, and
// the initial state); every later line is one step of the model: the action, its arguments, the
// deliveries the owner received in that step, and the state after it, read from the DB and from
// the recorder's view of the passes, mapped to Outbox.tla's variables. OutboxTrace.tla checks
// that the file is a behavior of the model.
//
// Where a line is cut (the code's steps are the model's steps; see the README, "Trace validation
// of the outbox"):
//   enqueue       outbox.enqueue() returns (one Db.tx)
//   pass-start    deliverDue() ran from its start to its first await: channel.send called
//                 (pass "sending"), or the no-channel UPDATE written (pass "returned"), or the
//                 pass ended (no due row, or every due row held back)
//   deliver-noop  deliverDue() returned at once (`this.running`): a stutter of the model
//   continue      deliverDue resumed after `await this.sendOne(row)` and ran to its next await
//   succeed/fail/drop/timeout   the first durable write of sendOne after its await settled
//   backoff       a row's next_attempt_at is no longer after now (the clock moved, or a retry's
//                 backoff was already over when it was written: then the fail/timeout line does
//                 not check that row's `due`, and the backoff line follows at once)
//   orphan-lands/orphan-fails   a send the timeout gave up on settles after all
//   crash/restart the process dies (in-flight copies may have reached the owner) / Daemon.start
//
//   node --experimental-strip-types verification/outbox/trace/record.ts --out DIR [--count 60]
//        [--seed 1] [--group-size 20]
//        [--outbox PATH]          a copy of outbox.ts to drive instead (check.sh's mutants)
//        [--drop-enqueue-line]    instrumentation mutant: the second enqueue runs but is not logged

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Channel, InboundMessage, OutboundMessage, SendResult } from "../../../src/channels/types.ts";
import { PermanentSendError } from "../../../src/channels/types.ts";
import type { ChannelId } from "../../../src/config.ts";
import type * as O from "../../../src/core/outbox.ts";
import { ManualClock } from "../../../src/core/time.ts";
import { Db } from "../../../src/store/db.ts";

// ---- arguments ---------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name: string, def?: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : def;
};
const outDir = resolve(opt("out") ?? "verification/out/outbox-trace/traces");
const count = Number(opt("count", "60"));
const seed0 = Number(opt("seed", "1"));
const groupSize = Number(opt("group-size", "20"));
const dropEnqueueLine = argv.includes("--drop-enqueue-line");
const outboxPath = opt("outbox");
const ob: typeof O = await import(
	outboxPath ? pathToFileURL(resolve(outboxPath)).href : new URL("../../../src/core/outbox.ts", import.meta.url).href
);

// ---- constants shared with OutboxTrace.cfg -----------------------------------------------------
const BLOCKING = 3; // OutboxTrace.cfg BLOCKING_ATTEMPTS
const SLOTS = 2; // OutboxTrace.cfg MaxPasses: the guard keeps the code in slot 1; slot 2 shows a second pass
const SEND_TIMEOUT_MS = 90_000; // outbox.ts SEND_TIMEOUT_MS
const CHANNEL: ChannelId = "telegram";
const CONV = "42";
if (ob.BLOCKING_ATTEMPTS !== BLOCKING) throw new Error(`BLOCKING_ATTEMPTS is ${ob.BLOCKING_ATTEMPTS}: update OutboxTrace.cfg and record.ts`);

// ---- random numbers (mulberry32: a seed gives the same trace on every machine) ------------------
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
	return { next, int, pick };
}
type Rng = ReturnType<typeof rng>;

// ---- scenarios: Outbox.tla's Items (one per batch of traces) -----------------------------------
// kind is ref.kind ("none" = no ref), ticket the ticket it belongs to, parts what split() makes.
interface Item {
	name: string;
	kind: string;
	ticket: string;
	parts: number;
}
function scenario(r: Rng): Item[] {
	// Always a ticket's question and report and a long reply; then up to four more, shuffled.
	const base = [
		{ kind: "attention", ticket: "T", parts: 1 },
		{ kind: "ticket", ticket: "T", parts: 1 },
		{ kind: "reply", ticket: "none", parts: 2 },
	];
	const pool = [
		{ kind: "approval", ticket: "T", parts: 1 },
		{ kind: "ticket", ticket: "U", parts: 1 },
		{ kind: "attention", ticket: "U", parts: 1 },
		{ kind: "notice", ticket: "none", parts: 1 },
		{ kind: "none", ticket: "none", parts: 3 },
		{ kind: "ticket", ticket: "T", parts: 2 },
		{ kind: "none", ticket: "none", parts: 1 },
	];
	const all = [...base];
	for (let k = r.int(1, 4); k > 0; k--) all.push(r.pick(pool));
	for (let i = all.length - 1; i > 0; i--) {
		const j = r.int(0, i);
		[all[i], all[j]] = [all[j], all[i]];
	}
	return all.map((x, i) => ({ name: `m${i + 1}`, ...x }));
}

// The glue the callers put around enqueue: services.ts sendSolicited (ticket results; ask_owner
// passes ticketId), sessions.ts (a worker's approval ask), notifier.ts and replies (no key).
function outboxItem(it: Item): O.OutboxItem {
	const texts = Array.from({ length: it.parts }, (_, k) => `${it.name}#${k + 1}${it.parts > 1 ? ` ${"x".repeat(3000)}` : ""}`);
	const keyed = it.kind === "ticket" || it.kind === "attention" || it.kind === "approval";
	return {
		channel: CHANNEL,
		conversation: CONV,
		text: texts.join("\n\n"),
		ref: it.kind === "none" ? undefined : { kind: it.kind as "ticket", id: it.kind === "ticket" ? it.ticket : `${it.kind}-${it.name}` },
		orderKey: keyed ? `${it.ticket}:${CHANNEL}:${CONV}` : undefined,
	};
}

// ---- fake timers: the real withTimeout's setTimeout, fired by the recorder ----------------------
interface FakeTimer {
	fake: true;
	fn: () => void;
	ms: number;
	cleared: boolean;
	unref(): FakeTimer;
	ref(): FakeTimer;
	hasRef(): boolean;
}
interface Send {
	row: number;
	resolve: (v: SendResult) => void;
	reject: (e: unknown) => void;
	timer?: FakeTimer;
}
let awaitingTimer: Send | undefined; // the send whose withTimeout is about to start its timer
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
	if (!awaitingTimer) return realSetTimeout(fn, ms, ...rest);
	const t: FakeTimer = {
		fake: true,
		fn,
		ms: ms ?? 0,
		cleared: false,
		unref: () => t,
		ref: () => t,
		hasRef: () => false,
	};
	awaitingTimer.timer = t;
	awaitingTimer = undefined;
	return t;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((t: unknown) => {
	if (t && (t as FakeTimer).fake) {
		(t as FakeTimer).cleared = true;
		return;
	}
	realClearTimeout(t as Parameters<typeof clearTimeout>[0]);
}) as typeof clearTimeout;

// Every promise continuation the last call started has run once a macrotask turn has passed
// (node:sqlite is synchronous, the channel and the timers are the recorder's).
const drain = () => new Promise<void>((res) => setImmediate(res));

// ---- one run -----------------------------------------------------------------------------------
type Ph = "idle" | "sending" | "returned";
interface TodoEntry {
	row: number;
	att: number;
}
interface PassView {
	ph: Ph;
	cur: number;
	att: number;
	todo: TodoEntry[];
}
interface Delivery {
	row: number;
	how: "recorded" | "crash" | "timeout";
}
interface Line {
	action: string;
	args: Record<string, unknown>;
	sent: Delivery[];
	state: unknown;
}
interface OutboxDbRow {
	id: number;
	status: string;
	attempts: number;
	order_key: string | null;
	external_id: string | null;
	next_attempt_at: number;
}

const coverage = new Map<string, number>();
const bump = (k: string) => coverage.set(k, (coverage.get(k) ?? 0) + 1);

async function record(seed: number, group: number, items: Item[]): Promise<string> {
	const r = rng(seed);
	const nrows = items.reduce((a, it) => a + it.parts, 0);
	const db = new Db(":memory:");
	const clock = new ManualClock(Date.UTC(2026, 10, 2, 9, 0, 0));
	const lines: Line[] = [];

	// What the recorder knows of the process: the passes (one deliverDue call each), their
	// in-flight sends, the sends the timeout gave up on, and what the owner received.
	const idle = (): PassView => ({ ph: "idle", cur: 0, att: 0, todo: [] });
	let passes: PassView[] = Array.from({ length: SLOTS }, idle);
	let snaps: (TodoEntry[] | undefined)[] = []; // the `due` array each pass's SELECT returned
	let pos: number[] = []; // per pass: index in its snapshot of the last row it sent or wrote
	let inflight: (Send | undefined)[] = [];
	let orphans: Send[] = [];
	const received: Delivery[] = [];
	let up = true;
	let chanUp = r.next() < 0.8;
	let enq = 0;
	let enqueuing = false;
	const splitName = new Map<string, string>(); // the code's split:<now>:<random> key -> item name

	const channel: Channel = {
		id: CHANNEL,
		async start(_on: (m: InboundMessage) => Promise<void>) {},
		send(msg: OutboundMessage): Promise<SendResult> {
			const id = db.raw.prepare("SELECT id FROM outbox WHERE text = ?").get(msg.text) as { id: number } | undefined;
			let s!: Send;
			const p = new Promise<SendResult>((resolve, reject) => {
				s = { row: id ? Number(id.id) : 0, resolve, reject };
			});
			awaitingTimer = s;
			onSend(s);
			return p;
		},
		ownerConversation: () => CONV,
		async stop() {},
	};
	const channelsFor = (on: boolean) => new Map<ChannelId, Channel>(on ? [[CHANNEL, channel]] : []);
	let outbox = new ob.Outbox(db, clock, channelsFor(chanUp));

	// ---- the abstraction function: the code's state -> Outbox.tla's variables ----
	const modelKey = (k: string | null): string => {
		if (k === null) return "none";
		const t = /^([A-Z]+):telegram:42$/.exec(k);
		if (t) return t[1];
		if (splitName.has(k)) return `split:${splitName.get(k)}`;
		return `?${k}`;
	};
	const dbRows = () =>
		db.raw.prepare("SELECT id, status, attempts, order_key, external_id, next_attempt_at FROM outbox ORDER BY id").all() as unknown as OutboxDbRow[];
	const abs = (dueAny: number[]) => {
		const rows = dbRows();
		const n = Math.max(nrows, rows.length ? Number(rows[rows.length - 1].id) : 0);
		const status = Array<string>(n).fill("none");
		const attempts = Array<number>(n).fill(0);
		const due = Array<boolean>(n).fill(false);
		const okey = Array<string>(n).fill("none");
		const ext = Array<number>(n).fill(0);
		for (const x of rows) {
			const i = Number(x.id) - 1;
			status[i] = x.status;
			attempts[i] = Number(x.attempts);
			due[i] = Number(x.next_attempt_at) <= clock.now();
			okey[i] = modelKey(x.order_key);
			ext[i] = x.external_id === null ? 0 : Number(x.external_id);
		}
		const refs = (db.raw.prepare("SELECT external_id FROM message_refs").all() as { external_id: string }[])
			.map((x) => Number(x.external_id))
			.sort((a, b) => a - b);
		return {
			enq,
			status,
			attempts,
			due,
			dueAny,
			okey,
			ext,
			refs,
			up,
			chanUp,
			pass: passes.map((p) => ({ ...p, todo: p.todo.map((e) => ({ ...e })) })),
			orphans: orphans.map((o) => o.row),
		};
	};
	const emit = (action: string, args: Record<string, unknown>, sent: Delivery[] = [], dueAny: number[] = []) => {
		lines.push({ action, args, sent, state: abs(dueAny) });
		bump(`${action}${action === "pass-start" || action === "continue" ? ` -> ${passes[(args.p as number) - 1]?.ph}` : ""}`);
	};
	const rowNow = (id: number) => dbRows().find((x) => Number(x.id) === id);
	const isDue = (id: number) => {
		const x = rowNow(id);
		return !!x && Number(x.next_attempt_at) <= clock.now();
	};

	// ---- where the code is: the chain of synchronous code one recorder call started ----
	// mode "start": deliverDue's first stretch; "settle": sendOne after its await; "continue":
	// deliverDue after `await this.sendOne`; "done": the chain reached an await the recorder answers.
	interface Chain {
		slot: number;
		mode: "start" | "settle" | "continue" | "done";
		act?: string;
		row?: number;
		sent?: Delivery[];
	}
	let chain: Chain | undefined;

	const segmentEnd = (ph: Ph, row?: number) => {
		const c = chain as Chain;
		const snap = snaps[c.slot] ?? [];
		const i = row === undefined ? -1 : snap.findIndex((e) => e.row === row);
		const skipped = (ph === "idle" ? snap.length : i) - (pos[c.slot] ?? -1) - 1;
		if (skipped > 0) bump("(held back: rows skipped by a pass)");
		if (ph === "sending" && (snap[i]?.att ?? 0) >= BLOCKING) bump("(a failing row is sent again)");
		pos[c.slot] = i;
		passes[c.slot] = {
			ph,
			cur: ph === "sending" ? (row ?? 0) : 0,
			att: ph === "sending" ? (snap[i]?.att ?? -1) : 0,
			todo: ph === "idle" ? [] : snap.slice(i + 1),
		};
		const action = c.mode === "start" ? "pass-start" : "continue";
		c.mode = ph === "returned" ? "continue" : "done";
		if (ph === "idle") snaps[c.slot] = undefined;
		emit(action, { p: c.slot + 1 });
	};
	const settleLine = () => {
		const c = chain as Chain;
		passes[c.slot] = { ph: "returned", cur: 0, att: 0, todo: passes[c.slot].todo };
		c.mode = "continue";
		// A retry whose backoff is over already when written (sendOne took `now` before its await):
		// RetryLater and BackoffElapses at one instant, two model steps.
		const late = (c.act === "fail" || c.act === "timeout") && c.row !== undefined && isDue(c.row);
		emit(c.act as string, { p: c.slot + 1 }, c.sent ?? [], late ? [c.row as number] : []);
		if (late) emit("backoff", { r: c.row }), bump(`(${c.act}: backoff already over when written)`);
	};
	function onSend(s: Send) {
		if (!chain || chain.mode === "done") return emit("unexplained-send", { row: s.row });
		if (chain.mode === "settle") settleLine();
		inflight[chain.slot] = s;
		segmentEnd("sending", s.row);
	}
	function onWrite(sql: string, params: unknown[]) {
		if (enqueuing) return;
		if (sql !== "tx" && !/\b(outbox|message_refs)\b/.test(sql)) return; // the events audit log
		if (!chain || chain.mode === "done") return emit("unexplained-write", { sql });
		if (chain.mode === "settle") return settleLine();
		// deliverDue's own stretch writes only sendOne's no-channel UPDATE (last parameter: the id).
		segmentEnd("returned", Number(params[params.length - 1]));
	}
	function onFinished(slot: number) {
		if (!chain || chain.slot !== slot) return emit("unexplained-finish", { p: slot + 1 });
		if (chain.mode === "settle") settleLine();
		if (chain.mode === "start" && snaps[slot] === undefined) {
			chain.mode = "done";
			return emit("deliver-noop", {});
		}
		segmentEnd("idle");
	}

	// ---- instrumentation of this Db instance (src/store/db.ts is not changed) ----
	const orig = { run: db.run.bind(db), tx: db.tx.bind(db), all: db.all.bind(db) };
	let depth = 0;
	db.run = ((sql: string, ...ps: Parameters<Db["run"]>[1][]) => {
		const res = orig.run(sql, ...ps);
		if (depth === 0) onWrite(sql, ps);
		return res;
	}) as Db["run"];
	db.tx = (<T>(fn: () => T): T => {
		depth++;
		let out: T;
		try {
			out = orig.tx(fn);
		} finally {
			depth--;
		}
		if (depth === 0) onWrite("tx", []);
		return out;
	}) as Db["tx"];
	db.all = (<T>(sql: string, ...ps: Parameters<Db["all"]>[1][]): T[] => {
		const rows = orig.all<T>(sql, ...ps);
		if (chain && chain.mode === "start" && snaps[chain.slot] === undefined && /\bFROM outbox\b/.test(sql)) {
			snaps[chain.slot] = (rows as unknown as OutboxDbRow[]).map((x) => ({ row: Number(x.id), att: Number(x.attempts) }));
		}
		return rows;
	}) as Db["all"];

	// ---- the recorder's calls ----
	const advance = (ms: number) => {
		const before = new Set(dbRows().filter((x) => Number(x.next_attempt_at) <= clock.now()).map((x) => Number(x.id)));
		clock.advance(ms);
		const crossing = dbRows()
			.filter((x) => Number(x.next_attempt_at) <= clock.now() && !before.has(Number(x.id)))
			.filter((x) => x.status === "pending" || x.status === "failing")
			.map((x) => Number(x.id));
		// Rows coming due at one instant: one model step each; the later ones' `due` is unchecked
		// on the earlier lines.
		crossing.forEach((row, k) => emit("backoff", { r: row }, [], crossing.slice(k + 1)));
	};
	const enqueue = () => {
		const it = items[enq];
		enqueuing = true;
		let ids: number[];
		try {
			ids = outbox.enqueue(outboxItem(it));
		} finally {
			enqueuing = false;
		}
		for (const id of ids) {
			const k = rowNow(id)?.order_key;
			if (k?.startsWith("split:") && !splitName.has(k)) splitName.set(k, it.name);
		}
		enq++;
		if (dropEnqueueLine && enq === 2) return;
		emit("enqueue", { g: enq });
	};
	const deliver = async () => {
		const slot = passes.findIndex((p) => p.ph === "idle");
		chain = { slot, mode: "start" };
		snaps[slot] = undefined;
		pos[slot] = -1;
		const life = outbox;
		outbox.deliverDue().then(
			() => life === outbox && onFinished(slot),
			(e: unknown) => emit("unexplained-error", { error: String(e) }),
		);
		await drain();
		chain = undefined;
	};
	const settle = async (slot: number, outcome: "succeed" | "fail" | "drop" | "timeout") => {
		const s = inflight[slot] as Send;
		// The answer takes some time (a timeout takes 90 s).
		if (outcome === "timeout") advance(SEND_TIMEOUT_MS);
		else if (r.next() < 0.35) advance(r.pick([1_000, 3_000, 10_000, 30_000]));
		inflight[slot] = undefined;
		chain = { slot, mode: "settle", act: outcome, row: s.row, sent: [] };
		if (outcome === "succeed") {
			received.push({ row: s.row, how: "recorded" });
			chain.sent = [received[received.length - 1]];
			s.resolve({ externalId: String(received.length) });
		} else if (outcome === "fail") s.reject(new Error("ETIMEDOUT"));
		else if (outcome === "drop") s.reject(new PermanentSendError("chat not found"));
		else {
			orphans.push(s);
			if (s.timer && !s.timer.cleared) {
				if (s.timer.ms !== SEND_TIMEOUT_MS) throw new Error(`the send timeout is ${s.timer.ms} ms, not ${SEND_TIMEOUT_MS}`);
				s.timer.fn();
			}
		}
		await drain();
		if (chain?.mode === "settle") settleLine(); // nothing was written
		chain = undefined;
	};
	const orphanSettles = async () => {
		const i = r.int(0, orphans.length - 1);
		const s = orphans[i];
		chain = { slot: -1, mode: "done" };
		const lands = r.next() < 0.5;
		orphans = orphans.filter((_, j) => j !== i);
		if (lands) {
			received.push({ row: s.row, how: "timeout" });
			s.resolve({ externalId: String(received.length) });
		} else s.reject(new Error("ECONNRESET"));
		await drain();
		chain = undefined;
		emit(lands ? "orphan-lands" : "orphan-fails", { i: i + 1 }, lands ? [received[received.length - 1]] : []);
	};
	const crash = () => {
		// Each in-flight send, and each abandoned one, may have reached the owner just before.
		const sent: Delivery[] = [];
		for (const s of inflight) {
			if (s && r.next() < 0.5) received.push({ row: s.row, how: "crash" }), sent.push(received[received.length - 1]);
		}
		for (const s of orphans) {
			if (r.next() < 0.5) received.push({ row: s.row, how: "timeout" }), sent.push(received[received.length - 1]);
		}
		up = false;
		passes = Array.from({ length: SLOTS }, idle);
		snaps = [];
		pos = [];
		inflight = [];
		orphans = []; // their promises are never settled: the process is gone
		if (sent.length) bump("(crash: an in-flight or abandoned copy reached the owner)");
		emit("crash", {}, sent);
	};
	const restart = () => {
		// Daemon.start: a new Outbox (running = false) on the same database; a channel that fails
		// to start is not in the map for this lifetime.
		chanUp = r.next() < 0.8;
		outbox = new ob.Outbox(db, clock, channelsFor(chanUp));
		up = true;
		emit("restart", {});
	};

	const header = { action: "init", seed, group, items, nrows, state: abs([]) };
	const steps = r.int(30, 90);
	for (let i = 0; i < steps; i++) {
		const sending = passes.map((p, k) => (p.ph === "sending" ? k : -1)).filter((k) => k >= 0);
		const choices: [number, () => unknown][] = [
			[up && enq < items.length ? 2.5 : 0, enqueue],
			[up && passes.some((p) => p.ph === "idle") ? 3 : 0, deliver],
			[
				up && sending.length ? 6 : 0,
				() => {
					const x = r.next();
					const outcome = x < 0.5 ? "succeed" : x < 0.8 ? "fail" : x < 0.87 ? "drop" : "timeout";
					return settle(r.pick(sending), outcome);
				},
			],
			[up && orphans.length ? 1 : 0, orphanSettles],
			[
				2,
				() => {
					const later = dbRows()
						.filter((x) => (x.status === "pending" || x.status === "failing") && Number(x.next_attempt_at) > clock.now())
						.map((x) => Number(x.next_attempt_at) - clock.now());
					advance(later.length && r.next() < 0.6 ? Math.min(...later) : r.pick([500, 5_000, 20_000, 60_000, 300_000]));
				},
			],
			[up ? 0.15 : 0, crash],
			[up ? 0 : 3, restart],
		];
		const total = choices.reduce((a, [w]) => a + w, 0);
		let x = r.next() * total;
		for (const [w, f] of choices) {
			if ((x -= w) < 0) {
				await f();
				break;
			}
		}
	}
	db.close();
	return `${[header, ...lines].map((o) => JSON.stringify(o)).join("\n")}\n`;
}

mkdirSync(outDir, { recursive: true });
const groups = Math.ceil(count / groupSize);
for (let g = 0; g < groups; g++) {
	const items = scenario(rng(seed0 * 7919 + g));
	for (let i = g * groupSize; i < Math.min(count, (g + 1) * groupSize); i++) {
		const seed = seed0 + i;
		const text = await record(seed, g + 1, items);
		writeFileSync(join(outDir, `g${String(g + 1).padStart(2, "0")}-trace-${String(seed).padStart(4, "0")}.ndjson`), text);
	}
}
const cov = Object.fromEntries([...coverage].sort());
writeFileSync(join(outDir, "coverage.json"), `${JSON.stringify(cov, null, 1)}\n`);
console.log(
	`recorded ${count} traces (seeds ${seed0}..${seed0 + count - 1}, ${groups} scenarios) in ${outDir}; ` +
		`${Object.keys(cov).length} distinct steps, see coverage.json`,
);
