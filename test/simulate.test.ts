// vigil simulate replays a stream through the real governor; its numbers obey the policy.

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/core/governor.ts";
import { simulate, syntheticWeek } from "../src/simulate.ts";

describe("vigil simulate", () => {
	it("never shows more non-critical buzzes per day than the budget, and accounts for every notice", () => {
		const policy = { ...DEFAULT_POLICY, timezone: "UTC" };
		const stream = syntheticWeek(Date.UTC(2026, 10, 1));
		const days = simulate(stream, policy);
		expect(days.reduce((a, d) => a + d.offered, 0)).toBe(stream.length);
		for (const d of days) expect(d.buzzes - d.critical).toBeLessThanOrEqual(policy.maxInterruptsPerDay); // a UTC calendar day is one 24 h window
		const strict = simulate(stream, { ...policy, maxInterruptsPerDay: 0, criticalPerDay: 0 });
		expect(strict.reduce((a, d) => a + d.buzzes, 0)).toBe(0);
	});
});
