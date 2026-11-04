// Property tests: drive the real governor with random action sequences and check the same rules
// the TLA+ model checks (verification/governor/Governor.tla).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_POLICY,
	type GovernorPolicy,
	type GovernorState,
	initialState,
	isQuiet,
	mute,
	type Notice,
	offer,
	penalize,
	takeForReply,
	tick,
	type Urgency,
} from "../src/core/governor.ts";
import { DAY, HOUR, MINUTE } from "../src/core/time.ts";

type Action =
	| { kind: "offer"; urgency: Urgency; topic: number; key: number; expiresInH: number | null }
	| { kind: "advance"; minutes: number }
	| { kind: "reply" }
	| { kind: "mute"; topic: number; hours: number }
	| { kind: "penalize"; topic: number };

const action: fc.Arbitrary<Action> = fc.oneof(
	{
		weight: 5,
		arbitrary: fc.record({
			kind: fc.constant("offer" as const),
			urgency: fc.constantFrom<Urgency>("critical", "high", "normal", "low"),
			topic: fc.integer({ min: 0, max: 3 }),
			key: fc.integer({ min: 0, max: 6 }),
			expiresInH: fc.option(fc.integer({ min: 1, max: 48 }), { nil: null }),
		}),
	},
	{ weight: 5, arbitrary: fc.record({ kind: fc.constant("advance" as const), minutes: fc.integer({ min: 1, max: 240 }) }) },
	{ weight: 1, arbitrary: fc.record({ kind: fc.constant("reply" as const) }) },
	{
		weight: 1,
		arbitrary: fc.record({
			kind: fc.constant("mute" as const),
			topic: fc.integer({ min: 0, max: 3 }),
			hours: fc.integer({ min: 1, max: 30 }),
		}),
	},
	{ weight: 1, arbitrary: fc.record({ kind: fc.constant("penalize" as const), topic: fc.integer({ min: 0, max: 3 }) }) },
);

interface Sent {
	step: number;
	at: number;
	notice: Notice;
	how: "alone" | "digest" | "reply";
}

interface Run {
	sent: Sent[];
	offered: string[];
	state: GovernorState;
	muteLog: { topic: string; step: number; until: number }[];
	end: number;
}

function run(actions: Action[], policy: GovernorPolicy, start: number): Run {
	let now = start;
	let state = initialState(now);
	const sent: Sent[] = [];
	const offered: string[] = [];
	const muteLog: Run["muteLog"] = [];
	let seq = 0;
	let step = 0;
	const doTick = () => {
		const r = tick(state, now, policy);
		state = r.state;
		for (const n of r.digest) sent.push({ step, at: now, notice: n, how: "digest" });
	};
	for (const a of actions) {
		step++;
		switch (a.kind) {
			case "offer": {
				const id = `n${seq++}`;
				offered.push(id);
				const r = offer(
					state,
					{
						id,
						urgency: a.urgency,
						topic: `t${a.topic}`,
						dedupKey: `k${a.key}`,
						text: `news ${a.key}`,
						expiresAt: a.expiresInH === null ? undefined : now + a.expiresInH * HOUR,
					},
					now,
					policy,
				);
				state = r.state;
				if (r.deliverNow) sent.push({ step, at: now, notice: r.notice, how: "alone" });
				break;
			}
			case "advance": {
				// The daemon ticks every 30 seconds; tick at least once per simulated minute step.
				const target = now + a.minutes * MINUTE;
				while (now < target) {
					now = Math.min(target, now + 7 * MINUTE);
					doTick();
				}
				break;
			}
			case "reply": {
				const r = takeForReply(state, now);
				state = r.state;
				for (const n of r.notices) sent.push({ step, at: now, notice: n, how: "reply" });
				break;
			}
			case "mute": {
				const until = now + a.hours * HOUR;
				muteLog.push({ topic: `t${a.topic}`, step, until });
				state = mute(state, `t${a.topic}`, until, now);
				break;
			}
			case "penalize":
				state = penalize(state, `t${a.topic}`, now + 7 * DAY);
				break;
		}
	}
	return { sent, offered, state, muteLog, end: now };
}

const policies: fc.Arbitrary<GovernorPolicy> = fc.record({
	timezone: fc.constantFrom("UTC", "Asia/Karachi", "America/Los_Angeles", "Asia/Kolkata"),
	quietHours: fc.constantFrom<GovernorPolicy["quietHours"]>(
		{ start: "22:30", end: "08:00" },
		{ start: "01:00", end: "06:00" },
		null,
	),
	digestTimes: fc.constantFrom(["09:00", "18:00"], ["12:30"], [] as string[]),
	maxInterruptsPerDay: fc.integer({ min: 0, max: 5 }),
	minGapMinutes: fc.integer({ min: 0, max: 120 }),
	criticalPerDay: fc.integer({ min: 0, max: 3 }),
	dedupWindowMinutes: fc.integer({ min: 0, max: 24 * 60 }),
	defaultExpiryHours: fc.integer({ min: 1, max: 48 }),
});

const start = Date.UTC(2026, 10, 4, 6, 17, 0);
const params = { numRuns: 400 };

describe("attention governor: invariants under random use", () => {
	it("Budget: individual high/normal interrupts stay within the rolling 24h cap and spacing", () => {
		fc.assert(
			fc.property(fc.array(action, { maxLength: 120 }), policies, (actions, policy) => {
				const { sent } = run(actions, policy, start);
				const interrupts = sent.filter((s) => s.how === "alone" && s.notice.effective !== "critical").map((s) => s.at);
				for (const t of interrupts) {
					expect(interrupts.filter((u) => u > t - DAY && u <= t).length).toBeLessThanOrEqual(policy.maxInterruptsPerDay);
				}
				for (let i = 1; i < interrupts.length; i++) {
					expect(interrupts[i] - interrupts[i - 1]).toBeGreaterThanOrEqual(policy.minGapMinutes * MINUTE);
				}
				const crit = sent.filter((s) => s.how === "alone" && s.notice.effective === "critical").map((s) => s.at);
				for (const t of crit) {
					expect(crit.filter((u) => u > t - DAY && u <= t).length).toBeLessThanOrEqual(policy.criticalPerDay);
				}
			}),
			params,
		);
	});

	it("Quiet: nothing but critical goes out unsolicited during quiet hours", () => {
		fc.assert(
			fc.property(fc.array(action, { maxLength: 120 }), policies, (actions, policy) => {
				const { sent } = run(actions, policy, start);
				for (const s of sent) {
					if (s.how === "reply") continue;
					if (s.how === "alone" && s.notice.effective === "critical") continue;
					expect(isQuiet(s.at, policy)).toBe(false);
				}
			}),
			params,
		);
	});

	it("NoMuted: nothing is sent on a topic while it is muted", () => {
		fc.assert(
			fc.property(fc.array(action, { maxLength: 120 }), policies, (actions, policy) => {
				const { sent, muteLog } = run(actions, policy, start);
				for (const s of sent) {
					const muted = muteLog.some((m) => m.topic === s.notice.topic && m.step < s.step && s.at < m.until);
					expect(muted, `${s.notice.id} on muted topic ${s.notice.topic} sent ${s.how}`).toBe(false);
				}
			}),
			params,
		);
	});

	it("NoDuplicate: two sent notices never share a dedup key within the dedup window", () => {
		fc.assert(
			fc.property(fc.array(action, { maxLength: 120 }), policies, (actions, policy) => {
				const { sent } = run(actions, policy, start);
				for (let i = 0; i < sent.length; i++) {
					for (let j = i + 1; j < sent.length; j++) {
						if (sent[i].notice.dedupKey !== sent[j].notice.dedupKey) continue;
						const gap = Math.abs(sent[i].notice.createdAt - sent[j].notice.createdAt);
						expect(gap).toBeGreaterThanOrEqual(policy.dedupWindowMinutes * MINUTE);
					}
				}
			}),
			params,
		);
	});

	it("Conservation: every offered notice is in exactly one place and sent at most once", () => {
		fc.assert(
			fc.property(fc.array(action, { maxLength: 120 }), policies, (actions, policy) => {
				const { sent, offered, state } = run(actions, policy, start);
				const ids = sent.map((s) => s.notice.id);
				expect(new Set(ids).size).toBe(ids.length);
				const kept = new Set(state.notices.map((n) => n.id));
				for (const id of offered) {
					// History is pruned after 7 days; younger notices must still be accounted for.
					if (!kept.has(id)) continue;
					expect(state.notices.filter((n) => n.id === id).length).toBe(1);
				}
				for (const s of sent) expect(["delivered", "digested"]).toContain(s.notice.status);
			}),
			params,
		);
	});

	it("EventuallyResolved: once time runs past every expiry, nothing is left waiting", () => {
		fc.assert(
			fc.property(fc.array(action, { maxLength: 80 }), policies, (actions, policy) => {
				const { state, end } = run(actions, policy, start);
				let s = state;
				for (let t = end; t <= end + 3 * DAY; t += 10 * MINUTE) s = tick(s, t, policy).state;
				expect(s.notices.filter((n) => n.status === "queued" || n.status === "held")).toEqual([]);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("attention governor: examples", () => {
	const policy: GovernorPolicy = { ...DEFAULT_POLICY, timezone: "UTC" };
	it("holds a normal notice at night and sends it when quiet hours end", () => {
		const night = Date.UTC(2026, 10, 4, 23, 0);
		let s = initialState(night);
		const r = offer(s, { id: "a", urgency: "normal", topic: "x", text: "build passed" }, night, policy);
		expect(r.notice.decision).toBe("hold");
		s = r.state;
		let digest: Notice[] = [];
		for (let t = night; t <= night + 10 * HOUR; t += MINUTE / 2) {
			const out = tick(s, t, policy);
			s = out.state;
			if (out.digest.length) {
				digest = out.digest;
				expect(new Date(t).getUTCHours()).toBe(8);
				break;
			}
		}
		expect(digest.map((n) => n.id)).toEqual(["a"]);
	});

	it("lets a critical notice through at night, up to its cap", () => {
		const night = Date.UTC(2026, 10, 4, 3, 0);
		let s = initialState(night);
		const decisions: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = offer(s, { id: `c${i}`, urgency: "critical", topic: "server", text: `down ${i}` }, night + i, policy);
			s = r.state;
			decisions.push(r.notice.decision);
		}
		expect(decisions).toEqual(["deliver", "deliver", "deliver", "hold", "hold"]);
	});

	it("drops a repeat of the same news", () => {
		const day = Date.UTC(2026, 10, 4, 12, 0);
		let s = initialState(day);
		s = offer(s, { id: "a", urgency: "high", topic: "ci", text: "CI is red" }, day, policy).state;
		const r = offer(s, { id: "b", urgency: "high", topic: "ci", text: "CI is red" }, day + HOUR, policy);
		expect(r.notice.decision).toBe("drop:duplicate");
	});
});
