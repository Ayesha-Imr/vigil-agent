// vigil demo is also an end-to-end test of a whole day: reminder, research, approval, quiet hours.

import { describe, expect, it, vi } from "vitest";
import { runDemo } from "../src/demo.ts";

describe("vigil demo", () => {
	it("tells the whole story, honestly", async () => {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
		});
		try {
			await runDemo();
		} finally {
			spy.mockRestore();
		}
		const out = lines.join("\n");
		expect(out).toContain("⏰ Call the bank");
		expect(out).toContain("✅ Compare e-ink tablets");
		expect(out).toMatch(/Approve\?.*pushes to a remote/);
		expect(out.indexOf("tap [Approve]")).toBeLessThan(out.indexOf("Pushed your reading notes"));
		expect(out).toContain("(nothing sent: quiet hours)");
		expect(out).toMatch(/08:00 .*Boox Note Air4 C dropped/);
		expect(out).toContain("1 of 3");
	}, 60_000);
});
