// Tests for the shared channel helpers.

import { describe, expect, it } from "vitest";
import { settleWithin, truncate } from "../../src/channels/util.ts";

describe("truncate", () => {
	it("cuts with an ellipsis and never splits a surrogate pair", () => {
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("hello world", 6)).toBe("hello…");
		expect(truncate("ab😀cd", 4)).toBe("ab…");
	});
});

describe("settleWithin", () => {
	it("waits for fast work and stops waiting for slow work", async () => {
		let done = false;
		await settleWithin(Promise.resolve().then(() => void (done = true)), 1_000, () => {});
		expect(done).toBe(true);
		const t0 = Date.now();
		const errors: unknown[] = [];
		await settleWithin(new Promise<void>((_, reject) => setTimeout(() => reject(new Error("late")), 60)), 10, (e) => errors.push(e));
		expect(Date.now() - t0).toBeLessThan(55);
		await new Promise((r) => setTimeout(r, 80));
		expect(errors).toHaveLength(1);
	});
});
