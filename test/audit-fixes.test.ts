// Regression tests for the correctness findings of the audit.

import { afterEach, describe, expect, it } from "vitest";
import { crossed } from "../src/core/governor.ts";
import { Tickets } from "../src/core/tickets.ts";
import { ManualClock } from "../src/core/time.ts";
import { Db, scrubSecrets } from "../src/store/db.ts";
import { fauxAssistantMessage, fauxToolCall, type Harness, harness, isConcierge, isWorker } from "./helpers/harness.ts";

const countCrossings = (startUtc: number, target: number, tz: string) => {
	let n = 0;
	for (let t = startUtc; t < startUtc + 26 * 3600e3; t += 30e3) if (crossed(t, t + 30e3, target, tz)) n++;
	return n;
};

describe("digest times across DST", () => {
	it("a time in the skipped spring-forward hour fires once", () => {
		expect(countCrossings(Date.UTC(2026, 2, 8, 4, 0), 2 * 60 + 30, "America/New_York")).toBe(1);
	});
	it("a time in the repeated fall-back hour fires once", () => {
		expect(countCrossings(Date.UTC(2026, 10, 1, 3, 0), 60 + 30, "America/New_York")).toBe(1);
	});
	it("ordinary times fire once a day, in any zone", () => {
		for (const tz of ["UTC", "Asia/Karachi", "Asia/Kolkata", "Australia/Lord_Howe", "Europe/London"]) {
			expect(countCrossings(Date.UTC(2026, 5, 1, 0, 0), 9 * 60, tz), tz).toBe(1);
		}
	});
});

describe("tickets named by short name", () => {
	it("an input addressed by short name reaches the ticket and reopens it", () => {
		const db = new Db(":memory:");
		const t = new Tickets(db, new ManualClock(), "/tmp/vigil-tk-test");
		const tk = t.create({ title: "Fix CI", mandate: { request: "fix", scope: "x", strength: "explicit" }, origin: { channel: "telegram", conversation: "1" } });
		t.report(tk.id, "ready", "done");
		expect(t.get(tk.id)?.status).toBe("ended");
		expect(t.addInput(tk.short_name, "owner_message", "one more thing")).toBe(true);
		expect(t.get(tk.id)?.status).toBe("open");
		expect(t.takeInputs(tk.id).map((i) => i.text)).toEqual(["one more thing"]);
		expect(t.stop(tk.short_name)).toBe(true);
		expect(t.get(tk.id)?.stage).toBe("stopped");
	});
});

describe("secrets in the audit log", () => {
	it("masks token-looking strings", () => {
		const s = scrubSecrets("key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz12 and 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw and token=abcdef1234567890xyz");
		expect(s).not.toMatch(/abcdefghijklmnopqrstuv|AAHdqTcv|abcdef1234567890xyz/);
		expect(scrubSecrets("rm -rf build")).toBe("rm -rf build");
	});
});

let h: Harness | undefined;
afterEach(async () => {
	await h?.daemon.stop();
	h = undefined;
});

describe("waiting notices and failed replies", () => {
	it("a reply that fails does not swallow the notices waiting for the digest", async () => {
		h = await harness(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 bad request" }));
		h.daemon.s.notifier.notify({ urgency: "low", topic: "x", text: "a low notice" });
		await h.channel.receive("hello?");
		await h.settle();
		expect(h.daemon.s.notifier.waiting().map((n) => n.text)).toEqual(["a low notice"]);
	});
	it("a reply that succeeds marks them told", async () => {
		h = await harness(() => fauxAssistantMessage("Hi. Also: a low notice."));
		h.daemon.s.notifier.notify({ urgency: "low", topic: "x", text: "a low notice" });
		await h.channel.receive("hello?");
		await h.settle();
		expect(h.daemon.s.notifier.waiting()).toEqual([]);
	});
});

describe("inferred tickets", () => {
	it("work vigil inferred from a watcher gets no shell or write tools", async () => {
		h = await harness((ctx) => {
			if (isWorker(ctx)) {
				return ctx.lastToolResult ? fauxAssistantMessage("x") : fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" });
			}
			return isConcierge(ctx) ? fauxAssistantMessage("?") : fauxAssistantMessage("?");
		});
		const t = h.daemon.s.tickets.create({ title: "Look into a change", mandate: { request: "check", scope: "investigate", strength: "inferred", rule: "watcher w_1" }, origin: { channel: "system", conversation: "" } });
		h.daemon.workers.pump();
		await h.settle();
		const last = h.calls.filter(isWorker).at(-1)!;
		expect(last.lastToolResult).toMatch(/not found|unknown|not available|Tool bash/i);
		expect(h.daemon.s.tickets.get(t.id)).toBeDefined();
	});
});
