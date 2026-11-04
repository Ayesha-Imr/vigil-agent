// `vigil simulate`: replay a stream of notices through the governor under a candidate policy and
// show what the owner's phone would have done, day by day. Uses the recorded notice history when
// there is one, else a synthetic week. Pure: nothing is sent and nothing is stored.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { type GovernorPolicy, initialState, type NoticeInput, offer, tick, type Urgency } from "./core/governor.ts";
import { DAY, localDate, MINUTE } from "./core/time.ts";

export interface SimNotice {
	at: number;
	urgency: Urgency;
	topic: string;
	text: string;
}

export interface DayReport {
	day: string;
	offered: number;
	buzzes: number;
	critical: number;
	digests: number;
	digested: number;
	dropped: number;
	nightBuzzes: number;
}

/** A plausible noisy week: CI, feeds, a server, a price watcher, worker results. */
export function syntheticWeek(start: number): SimNotice[] {
	const out: SimNotice[] = [];
	let seed = 7;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed / 2 ** 31;
	};
	const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
	for (let d = 0; d < 7; d++) {
		const n = 8 + Math.floor(rnd() * 10);
		for (let i = 0; i < n; i++) {
			const at = start + d * DAY + Math.floor(rnd() * DAY);
			const kind = pick(["ci", "ci", "arxiv", "arxiv", "github", "server", "flights", "ticket"]);
			const urgency: Urgency =
				kind === "server" ? (rnd() < 0.15 ? "critical" : "high") : kind === "ticket" ? "high" : kind === "github" ? "normal" : kind === "ci" ? pick(["normal", "low"]) : "low";
			out.push({ at, urgency, topic: kind, text: `${kind} event ${Math.floor(rnd() * 4)}` });
		}
	}
	return out.sort((a, b) => a.at - b.at);
}

/** Read recorded notices from vigil's database (read-only). */
export function recordedNotices(dbPath: string, sinceMs: number): SimNotice[] {
	if (!existsSync(dbPath)) return [];
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = db.prepare("SELECT created_at, urgency, topic, text FROM notices WHERE created_at > ? ORDER BY created_at").all(sinceMs) as {
			created_at: number;
			urgency: Urgency;
			topic: string;
			text: string;
		}[];
		return rows.map((r) => ({ at: r.created_at, urgency: r.urgency, topic: r.topic, text: r.text }));
	} finally {
		db.close();
	}
}

/** Run the stream through the governor, ticking every five minutes like the daemon. */
export function simulate(stream: SimNotice[], policy: GovernorPolicy): DayReport[] {
	if (!stream.length) return [];
	const start = stream[0].at;
	const end = stream[stream.length - 1].at + DAY;
	let state = initialState(start);
	const days = new Map<string, DayReport>();
	const day = (t: number) => {
		const k = localDate(t, policy.timezone);
		let r = days.get(k);
		if (!r) {
			r = { day: k, offered: 0, buzzes: 0, critical: 0, digests: 0, digested: 0, dropped: 0, nightBuzzes: 0 };
			days.set(k, r);
		}
		return r;
	};
	let i = 0;
	let seq = 0;
	for (let t = start; t <= end; t += 5 * MINUTE) {
		while (i < stream.length && stream[i].at <= t) {
			const n = stream[i++];
			const input: NoticeInput = { id: `s${seq++}`, urgency: n.urgency, topic: n.topic, text: n.text };
			const r = offer(state, input, n.at, policy);
			state = r.state;
			const d = day(n.at);
			d.offered++;
			if (r.deliverNow) {
				d.buzzes++;
				if (r.notice.effective === "critical") d.critical++;
				const h = new Date(n.at).toLocaleString("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: policy.timezone });
				if (Number(h) < 7) d.nightBuzzes++;
			}
			if (r.notice.status === "dropped") d.dropped++;
		}
		const out = tick(state, t, policy);
		state = out.state;
		if (out.digest.length) {
			const d = day(t);
			d.digests++;
			d.digested += out.digest.length;
		}
	}
	return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

export function renderReport(days: DayReport[], source: string, policy: GovernorPolicy): string {
	const lines = [
		`source: ${source}`,
		`policy: ${policy.maxInterruptsPerDay} interrupts/day, ${policy.minGapMinutes} min apart, critical cap ${policy.criticalPerDay}, quiet ${policy.quietHours ? `${policy.quietHours.start}-${policy.quietHours.end}` : "off"}, digests ${policy.digestTimes.join(" ") || "none"}`,
		"",
		"day         offered  buzzes  (critical)  digests (items)  dropped",
	];
	for (const d of days) {
		lines.push(
			`${d.day}  ${String(d.offered).padStart(7)}  ${String(d.buzzes).padStart(6)}  ${`(${d.critical})`.padStart(10)}  ${String(d.digests).padStart(7)} ${`(${d.digested})`.padStart(7)}  ${String(d.dropped).padStart(7)}`,
		);
	}
	const total = days.reduce((a, d) => ({ offered: a.offered + d.offered, buzzes: a.buzzes + d.buzzes }), { offered: 0, buzzes: 0 });
	lines.push("", `${total.offered} notices became ${total.buzzes} buzzes (${total.offered ? Math.round((100 * total.buzzes) / total.offered) : 0}%); the rest waited for digests or were dropped as repeats.`);
	return lines.join("\n");
}

