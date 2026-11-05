// Trace recorder for trace validation of the attention governor against Governor.tla.
//
// Drives the real governor functions (src/core/governor.ts) with random action sequences, the way
// Notifier, the concierge and the daemon call them, in the model's time discretisation: one slot is
// 8 hours, every call happens on a slot boundary, the policy is one of MCGovernor.tla's MCPolicies
// written as a real GovernorPolicy, and the time zone has no DST. Each run is written as one NDJSON
// file: line 1 is the header (constants and the initial state), then one line per call with the
// action, its arguments, the notices the code handed out for sending, and the resulting state
// mapped to Governor.tla's variables. GovernorTrace.tla checks that the file is a behavior of the
// model.
//
//   node --experimental-strip-types verification/governor/trace/record.ts --out DIR [--count 100] [--seed 1]
//        [--governor PATH]   a copy of governor.ts to drive instead (check.sh's mutants)
//        [--drop-mute-line]  instrumentation mutant: apply mute() but do not log the call
//
// What the mapping keeps and loses: see verification/README.md, "Trace validation".

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as G from "../../../src/core/governor.ts";

// ---- arguments ---------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name: string, def?: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : def;
};
const outDir = resolve(opt("out") ?? "verification/out/trace");
const count = Number(opt("count", "100"));
const seed0 = Number(opt("seed", "1"));
const dropMuteLine = argv.includes("--drop-mute-line");
const govPath = opt("governor");
const gov: typeof G = await import(
	govPath ? pathToFileURL(resolve(govPath)).href : new URL("../../../src/core/governor.ts", import.meta.url).href
);

// ---- the discretisation (MCGovernor.tla) -------------------------------------------------------
const MINUTE = 60_000;
const SLOT = 8 * 60 * MINUTE; // one model time unit
const TOPICS = ["t1", "t2"];
const KEYS = ["k1", "k2", "k3", "k4"];
const URGENCIES: G.Urgency[] = ["critical", "high", "normal", "low"];
const MUTE_FOR = [1, 2, 3, 6]; // Notifier.mute forMs in slots: 8 h, 16 h, the 1-day button, 2 days
const MAX_TIME = 30; // GovernorTrace.cfg MaxTime: the model's clock stops here; a run may stop earlier
const MAX_CUSTOM_EXPIRY = 24; // NoticeInput.expiresAt offsets, in slots (beyond HISTORY_SLOTS too)
const PENALTY_MS = 7 * 24 * 60 * MINUTE; // Notifier.dislike: now + 7 * DAY

// Zones without DST, so every slot boundary is a local 00:00, 08:00 or 16:00.
const ZONES: { tz: string; offsetMin: number }[] = [
	{ tz: "UTC", offsetMin: 0 },
	{ tz: "Asia/Karachi", offsetMin: 300 },
	{ tz: "Asia/Kolkata", offsetMin: 330 },
	{ tz: "Asia/Tokyo", offsetMin: 540 },
	{ tz: "America/Bogota", offsetMin: -300 },
];

const hhmm = (slot: number) => `${String(slot * 8).padStart(2, "0")}:00`;

// MCGovernor.tla MCPolicies, as the GovernorPolicy objects the code reads.
function policies(tz: string): G.GovernorPolicy[] {
	return [
		{
			timezone: tz,
			quietHours: { start: hhmm(0), end: hhmm(1) },
			digestTimes: [hhmm(2)],
			maxInterruptsPerDay: 1,
			minGapMinutes: 480,
			criticalPerDay: 1,
			dedupWindowMinutes: 960,
			defaultExpiryHours: 16,
		},
		{
			timezone: tz,
			quietHours: null,
			digestTimes: [],
			maxInterruptsPerDay: 2,
			minGapMinutes: 0,
			criticalPerDay: 1,
			dedupWindowMinutes: 480,
			defaultExpiryHours: 16,
		},
		{
			timezone: tz,
			quietHours: { start: hhmm(2), end: hhmm(1) },
			digestTimes: [hhmm(0), hhmm(1)],
			maxInterruptsPerDay: 2,
			minGapMinutes: 480,
			criticalPerDay: 0,
			dedupWindowMinutes: 960,
			defaultExpiryHours: 16,
		},
	];
}

// ---- the abstraction function: code values -> model values ---------------------------------
function whole(x: number, unit: number, what: string): number {
	if (x % unit !== 0) throw new Error(`${what} = ${x} is not a whole number of ${unit}`);
	return x / unit;
}
const toMin = (s: string) => {
	const [h, m] = s.split(":").map(Number);
	return h * 60 + m;
};
// The policy as MCGovernor.tla writes it, computed from the GovernorPolicy (not copied).
function absPolicy(p: G.GovernorPolicy) {
	return {
		hasQuiet: p.quietHours !== null,
		qStart: p.quietHours ? whole(toMin(p.quietHours.start), 480, "quiet start") : 0,
		qEnd: p.quietHours ? whole(toMin(p.quietHours.end), 480, "quiet end") : 0,
		digest: p.digestTimes.map((d) => whole(toMin(d), 480, "digest time")),
		maxInt: p.maxInterruptsPerDay,
		minGap: whole(p.minGapMinutes, 480, "minGapMinutes"),
		critCap: p.criticalPerDay,
		dedup: whole(p.dedupWindowMinutes, 480, "dedupWindowMinutes"),
		expiry: whole(p.defaultExpiryHours, 8, "defaultExpiryHours"),
	};
}

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

// ---- one run ---------------------------------------------------------------------------------
interface Line {
	action: string;
	args: Record<string, unknown>;
	sent: number[];
	at: string;
	state: unknown;
}

function record(seed: number): string {
	const r = rng(seed);
	const zone = r.pick(ZONES);
	const policyIx = r.int(0, 2);
	const policy = policies(zone.tz)[policyIx];
	// Some runs keep a concierge turn open for days (the model awaits the reply for any time), so a
	// claimed notice can outlive HISTORY_MS while ticks prune around it.
	const longTurn = r.next() < 0.2;
	const horizon = longTurn ? MAX_TIME : r.pick([6, 9, 12, 18, MAX_TIME]); // this run's horizon
	const turnEnd = longTurn ? 0.005 : 1;
	const steps = longTurn ? r.int(150, 220) : r.int(30, 160);
	// Slot 0 is a local midnight: 2026-11-02 00:00 in the owner's zone.
	const T0 = Date.UTC(2026, 10, 2, 0, 0) - zone.offsetMin * MINUTE;

	let now = T0;
	let state = gov.initialState(now);
	let offered = 0;
	let busy = false;
	let peeked: string[] = []; // the concierge turn's `const waiting = claimForReply()`
	const lines: Line[] = [];

	const slot = (t: number, what: string) => whole(t - T0, SLOT, what);
	// Governor.tla Until(): an until past the model's MaxTime acts as MaxTime + 1
	const cap = (t: number, what: string) => Math.min(slot(t, what), MAX_TIME + 1);
	const idOf = (s: string) => Number(s.slice(1)); // "n3" -> 3
	const abs = () => {
		const st: string[] = [];
		const nt: unknown[] = [];
		const kept: boolean[] = [];
		for (let i = 1; i <= offered; i++) {
			const n = state.notices.find((x) => x.id === `n${i}`);
			if (!n) {
				// offered, then pruned by tick(): the code no longer knows its status
				st.push("*");
				nt.push({});
				kept.push(false);
				continue;
			}
			st.push(n.status);
			kept.push(true);
			nt.push({
				eff: n.effective,
				topic: n.topic,
				key: n.dedupKey,
				createdAt: slot(n.createdAt, "createdAt"),
				expiresAt: slot(n.expiresAt, "expiresAt"),
				claimedFrom: n.claimedFrom ?? "none",
			});
		}
		const topicMap = (m: Record<string, number>, what: string) =>
			Object.fromEntries(TOPICS.map((t) => [t, m[t] === undefined ? -1 : cap(m[t], what)]));
		for (const t of Object.keys(state.mutes)) if (!TOPICS.includes(t)) throw new Error(`unknown topic ${t}`);
		return {
			now: slot(now, "now"),
			lastTickAt: slot(state.lastTickAt, "lastTickAt"),
			st,
			nt,
			kept,
			interrupts: state.interrupts.map((t) => slot(t, "interrupt")),
			criticals: state.criticals.map((t) => slot(t, "critical")),
			mutes: topicMap(state.mutes, "mute until"),
			penalties: topicMap(state.penalties, "penalty until"),
			busy,
			peeked: peeked.map(idOf),
		};
	};
	const log = (action: string, args: Record<string, unknown>, sent: G.Notice[] | string[] = []) =>
		lines.push({
			action,
			args,
			sent: sent.map((s) => idOf(typeof s === "string" ? s : s.id)),
			at: new Date(now).toISOString(),
			state: abs(),
		});

	const header = () => ({
		action: "init",
		seed,
		n: offered,
		maxTime: MAX_TIME,
		horizon,
		timezone: zone.tz,
		policyIndex: policyIx,
		policy: absPolicy(policy),
		topics: TOPICS,
		keys: KEYS,
	});
	const initState = abs();

	for (let i = 0; i < steps; i++) {
		const s = slot(now, "now");
		const choices: [number, () => void][] = [
			[
				s < horizon ? 3 : 0,
				() => {
					// Advance: the clock moves on one slot; the daemon's next tick is a separate step.
					now += SLOT;
					log("advance", {});
				},
			],
			[
				4,
				() => {
					// Notifier.tick -> tick()
					const out = gov.tick(state, now, policy);
					state = out.state;
					log("tick", {}, out.digest);
				},
			],
			[
				s + 1 <= horizon ? 4 : 0,
				() => {
					// Notifier.notify -> offer(); an offer must be able to expire by MaxTime (the model's bound)
					const n = ++offered;
					const u = r.pick(URGENCIES);
					const tp = r.pick(TOPICS);
					const k = r.pick(KEYS);
					const custom = r.next() < (longTurn ? 0.7 : 0.35) || s + policy.defaultExpiryHours / 8 > horizon;
					const dur = custom ? r.int(1, Math.min(MAX_CUSTOM_EXPIRY, horizon - s)) : policy.defaultExpiryHours / 8;
					const res = gov.offer(
						state,
						{ id: `n${n}`, urgency: u, topic: tp, dedupKey: k, text: `news ${k}`, expiresAt: custom ? now + dur * SLOT : undefined },
						now,
						policy,
					);
					state = res.state;
					log("offer", { n, u, tp, k, dur }, res.deliverNow ? [res.notice] : []);
				},
			],
			[
				1,
				() => {
					// /digest -> Notifier.takeForReply -> takeForReply()
					const out = gov.takeForReply(state, now);
					state = out.state;
					log("digest", {}, out.notices);
				},
			],
			[
				busy || (longTurn && !gov.waiting(state).length) ? 0 : 1.5,
				() => {
					// concierge turn starts: claimForReply() -> claim()
					const out = gov.claim(state, now);
					state = out.state;
					busy = true;
					peeked = out.notices.map((n) => n.id);
					log("claim", {});
				},
			],
			[
				busy ? 1.5 * turnEnd : 0,
				() => {
					// the turn ends: model text -> reply + confirmDelivered (markDelivered); none -> releaseClaim (release)
					const outcome = r.pick(["stored", "partial", "none"]);
					const told = outcome === "none" ? [] : peeked;
					if (outcome === "none") {
						if (peeked.length) state = gov.release(state, peeked, now);
					} else if (peeked.length) {
						state = gov.markDelivered(state, peeked, now).state;
					}
					busy = false;
					peeked = [];
					log("reply", { outcome }, told);
				},
			],
			[
				busy ? 0.4 * turnEnd : 0,
				() => {
					// the daemon restarts mid-turn: the Notifier constructor's releaseClaim(undefined)
					state = gov.release(state, undefined, now);
					busy = false;
					peeked = [];
					log("restart", {});
				},
			],
			[
				1,
				() => {
					// Notifier.mute(topic, forMs) -> mute(state, topic, now + forMs, now)
					const tp = r.pick(TOPICS);
					const dur = r.pick(MUTE_FOR);
					state = gov.mute(state, tp, now + dur * SLOT, now);
					if (!dropMuteLine) log("mute", { tp, dur });
				},
			],
			[
				0.5,
				() => {
					const tp = r.pick(TOPICS);
					state = gov.unmute(state, tp);
					log("unmute", { tp });
				},
			],
			[
				state.notices.length ? 0.5 : 0,
				() => {
					// Notifier.dislike(id): find the notice, penalize(topic, now + 7 days)
					const n = r.pick(state.notices);
					state = gov.penalize(state, n.topic, now + PENALTY_MS);
					log("penalize", { n: idOf(n.id) });
				},
			],
		];
		const total = choices.reduce((a, [w]) => a + w, 0);
		let x = r.next() * total;
		for (const [w, f] of choices) {
			if ((x -= w) < 0) {
				f();
				break;
			}
		}
	}
	// The header needs N, known only at the end; every state array has length N.
	const pad = (st: ReturnType<typeof abs>) => {
		while (st.st.length < offered) {
			st.st.push("none");
			st.nt.push({});
			st.kept.push(false);
		}
		return st;
	};
	const out = [{ ...header(), state: pad(initState) }, ...lines.map((l) => ({ ...l, state: pad(l.state as ReturnType<typeof abs>) }))];
	// Coverage: which (call, status change) pairs this run exercised, e.g. "tick: queued->digested".
	for (let i = 1; i < out.length; i++) {
		const a = out[i - 1].state.st;
		const b = out[i].state.st;
		let changed = false;
		for (let j = 0; j < b.length; j++) {
			if (a[j] === b[j]) continue;
			changed = true;
			const k = `${out[i].action}: ${a[j]}->${b[j]}`;
			coverage.set(k, (coverage.get(k) ?? 0) + 1);
		}
		if (!changed) coverage.set(`${out[i].action}: (no status change)`, (coverage.get(`${out[i].action}: (no status change)`) ?? 0) + 1);
	}
	return `${out.map((o) => JSON.stringify(o)).join("\n")}\n`;
}

const coverage = new Map<string, number>();

mkdirSync(outDir, { recursive: true });
for (let i = 0; i < count; i++) {
	const seed = seed0 + i;
	writeFileSync(join(outDir, `trace-${String(seed).padStart(4, "0")}.ndjson`), record(seed));
}
const cov = Object.fromEntries([...coverage].sort());
writeFileSync(join(outDir, "coverage.json"), `${JSON.stringify(cov, null, 1)}\n`);
console.log(
	`recorded ${count} traces (seeds ${seed0}..${seed0 + count - 1}) in ${outDir}; ` +
		`${Object.keys(cov).filter((k) => !k.includes("no status")).length} distinct (call, status change) pairs, see coverage.json`,
);
