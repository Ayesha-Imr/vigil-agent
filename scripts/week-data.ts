// Runs a synthetic noisy week through the real governor and prints every notice's fate as JSON,
// for the explainer page's chart: node --experimental-strip-types scripts/week-data.ts
import { DEFAULT_POLICY, initialState, offer, tick } from "../src/core/governor.ts";
import { MINUTE } from "../src/core/time.ts";
import { syntheticWeek } from "../src/simulate.ts";

const policy = { ...DEFAULT_POLICY, timezone: "UTC" };
const start = Date.UTC(2026, 9, 26, 0, 0);
const stream = syntheticWeek(start);
let state = initialState(start);
const fate = new Map<string, { t: number; u: string; topic: string; how: string; at?: number }>();
const digests: { t: number; n: number }[] = [];
let i = 0;
for (let t = start; t <= start + 8 * 86_400_000; t += 5 * MINUTE) {
	while (i < stream.length && stream[i].at <= t) {
		const n = stream[i];
		const id = `s${i++}`;
		const r = offer(state, { id, urgency: n.urgency, topic: n.topic, text: n.text }, n.at, policy);
		state = r.state;
		fate.set(id, { t: n.at - start, u: n.urgency, topic: n.topic, how: r.deliverNow ? (r.notice.effective === "critical" ? "critical" : "buzz") : r.notice.decision.startsWith("drop") ? "dropped" : "waiting" });
	}
	const out = tick(state, t, policy);
	state = out.state;
	for (const n of out.digest) {
		const f = fate.get(n.id);
		if (f) Object.assign(f, { how: "digest", at: t - start });
	}
	for (const n of out.expired) {
		const f = fate.get(n.id);
		if (f) f.how = "expired";
	}
	if (out.digest.length) digests.push({ t: t - start, n: out.digest.length });
}
console.log(JSON.stringify({ policy: { max: policy.maxInterruptsPerDay, gap: policy.minGapMinutes, quiet: policy.quietHours, digests: policy.digestTimes }, notices: [...fate.values()].filter((f) => f.t < 7 * 86_400_000), digests: digests.filter((d) => d.t < 7 * 86_400_000) }));
