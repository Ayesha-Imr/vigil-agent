// End to end: the real daemon, real pi sessions and tools, a scripted model and a fake chat.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOUR, MINUTE } from "../src/core/time.ts";
import { fauxAssistantMessage, fauxToolCall, type Harness, harness, isConcierge, isWorker } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.daemon.stop();
	h = undefined;
});

const say = (t: string) => fauxAssistantMessage(t);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

describe("vigil end to end", () => {
	it("answers the owner on the chat they wrote from", async () => {
		h = await harness((ctx) => say(ctx.lastUser.includes("hi there") ? "Hello Ayesha." : "?"));
		await h.channel.receive("hi there");
		await h.settle();
		expect(h.channel.texts()).toEqual(["Hello Ayesha."]);
		expect(h.calls[0].lastUser).toMatch(/^\[telegram \d\d:\d\d\] hi there/);
		expect(h.calls[0].system).toContain("Ayesha");
		expect(h.calls[0].system).toContain("<memory");
	});

	it("drops messages from anyone but the owner before a model sees them", async () => {
		h = await harness(() => say("should not happen"));
		await h.channel.receive("hello bot", { senderId: "999" });
		await h.settle();
		expect(h.calls.length).toBe(0);
		expect(h.channel.sent.length).toBe(0);
	});

	it("ignores a redelivered message", async () => {
		h = await harness(() => say("once"));
		await h.channel.receive("x", { externalId: "42:7" });
		await h.channel.receive("x", { externalId: "42:7" });
		await h.settle();
		expect(h.channel.texts()).toEqual(["once"]);
	});

	it("hands long work to a worker, which reports back to the same chat", async () => {
		h = await harness((ctx) => {
			if (isConcierge(ctx)) {
				if (ctx.lastToolResult.startsWith("Started")) return say("On it — I'll report back.");
				return call("spawn_ticket", { title: "Write a haiku file", request: "write me a haiku into a file", scope: "One file in the ticket dir." });
			}
			if (isWorker(ctx)) {
				if (ctx.lastToolResult.startsWith("Reported")) return say("done");
				if (ctx.lastToolResult.includes("Successfully wrote") || ctx.lastToolResult.includes("wrote")) {
					return call("report", { kind: "ready", summary: "Wrote haiku.txt in the ticket directory." });
				}
				return call("write", { path: "haiku.txt", content: "old pond\nfrog jumps in\nsplash" });
			}
			return say("?");
		});
		await h.channel.receive("write me a haiku into a file");
		await h.settle();
		const t = h.daemon.s.tickets.list("all")[0];
		expect(t.title).toBe("Write a haiku file");
		expect(t.mandate.strength).toBe("explicit");
		expect(existsSync(join(t.dir, "haiku.txt"))).toBe(true);
		expect(h.daemon.s.tickets.get(t.id)!.status).toBe("ended");
		const texts = h.channel.texts();
		expect(texts[0]).toBe("On it — I'll report back.");
		expect(texts[1]).toContain("✅ Write a haiku file");
	});

	it("holds a risky command for approval and runs it only after the owner approves", async () => {
		let target = "";
		h = await harness((ctx) => {
			if (ctx.lastToolResult.includes("Not run")) return say(`blocked: ${ctx.lastToolResult}`);
			if (ctx.lastUser.includes("clean up") && !ctx.lastToolResult) return call("bash", { command: `rm -rf ${target}` });
			return say("cleaned");
		});
		target = join(h.home, "work", "junk");
		writeFileSync(join(h.home, "junkfile"), "x");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(target, { recursive: true });
		await h.channel.receive("clean up the junk dir");
		// Wait for the approval request to be sent.
		for (let i = 0; i < 50 && !h.channel.sent.some((m) => m.buttons); i++) {
			await new Promise((r) => setTimeout(r, 20));
			await h.daemon.s.outbox.deliverDue();
		}
		const ask = h.channel.sent.find((m) => m.buttons)!;
		expect(ask.text).toContain("rm -rf");
		expect(existsSync(target)).toBe(true);
		const approve = ask.buttons![0][0];
		expect(approve.data).toMatch(/^approve:/);
		await h.channel.receive("", { kind: "button", data: approve.data });
		await h.settle();
		expect(existsSync(target)).toBe(false);
		expect(h.channel.texts()).toContain("cleaned");
		// A second tap on the same button changes nothing.
		await h.channel.receive("", { kind: "button", data: approve.data });
		await h.settle();
		expect(h.channel.texts().at(-1)).toContain("already consumed");
	});

	it("refuses a denied command and says so", async () => {
		h = await harness((ctx) => {
			if (ctx.lastToolResult.includes("Not run")) return say("ok, not deleting");
			if (!ctx.lastToolResult) return call("bash", { command: "sudo rm -rf /var/tmp/nothing" });
			return say("deleted?!");
		});
		await h.channel.receive("delete it");
		for (let i = 0; i < 50 && !h.channel.sent.some((m) => m.buttons); i++) {
			await new Promise((r) => setTimeout(r, 20));
			await h.daemon.s.outbox.deliverDue();
		}
		const ask = h.channel.sent.find((m) => m.buttons)!;
		await h.channel.receive("", { kind: "button", data: ask.buttons![0][1].data });
		await h.settle();
		expect(h.channel.texts()).toContain("ok, not deleting");
	});

	it("never lets the agent read credentials", async () => {
		h = await harness((ctx) => {
			if (ctx.lastToolResult) return say(ctx.lastToolResult.includes("Blocked") ? "refused" : "read it");
			return call("read", { path: join(h!.home, "pi", "auth.json") });
		});
		await h.channel.receive("show me your auth.json");
		await h.settle();
		expect(h.channel.texts()).toEqual(["refused"]);
	});

	it("holds proactive notices during quiet hours and sends them as the morning digest", async () => {
		h = await harness((ctx) => {
			if (ctx.lastToolResult) return say("OK");
			return call("notify", { text: "Your flight price dropped to $412.", urgency: "normal", topic: "flights" });
		});
		h.clock.t = Date.UTC(2026, 10, 4, 23, 30);
		h.daemon.concierge.enqueue({ kind: "system", tag: "job test", text: "check flights" });
		await h.settle();
		expect(h.channel.sent.length).toBe(0);
		for (let t = h.clock.t; t <= Date.UTC(2026, 10, 5, 8, 1); t += 5 * MINUTE) {
			h.clock.t = t;
			await h.daemon.tickOnce();
		}
		expect(h.channel.texts()).toEqual(["Your flight price dropped to $412."]);
		expect(h.channel.sent[0].silent).toBe(true); // digests arrive without a buzz
	});

	it("sends a scheduled reminder at its time without a model call", async () => {
		h = await harness(() => say("unused"));
		h.daemon.s.scheduler.create({ name: "call mom", kind: "at", spec: new Date(h.clock.t + HOUR).toISOString(), prompt: "Call mom", action: "remind", createdBy: "owner" });
		await h.daemon.tickOnce();
		expect(h.channel.sent.length).toBe(0);
		h.clock.advance(HOUR + MINUTE);
		await h.daemon.tickOnce();
		await h.settle();
		expect(h.channel.texts()).toEqual(["⏰ Call mom"]);
		expect(h.calls.length).toBe(0);
		h.clock.advance(2 * HOUR);
		await h.daemon.tickOnce();
		expect(h.channel.sent.length).toBe(1);
	});

	it("routes an answer button back to the worker that asked", async () => {
		h = await harness((ctx) => {
			if (isConcierge(ctx)) {
				if (ctx.lastToolResult.startsWith("Started")) return say("Starting.");
				return call("spawn_ticket", { title: "Pick a color", request: "paint it", scope: "ask first" });
			}
			if (ctx.lastUser.includes("A: Blue")) return ctx.lastToolResult.startsWith("Reported") ? say("x") : call("report", { kind: "ready", summary: "Painted it blue." });
			if (ctx.lastToolResult.startsWith("Asked")) return say("waiting for answer");
			return call("ask_owner", { question: "Which color?", choices: ["Red", "Blue"] });
		});
		await h.channel.receive("paint it");
		await h.settle();
		const q = h.channel.sent.find((m) => m.buttons)!;
		expect(q.text).toContain("Which color?");
		await h.channel.receive("", { kind: "button", data: q.buttons![0][1].data });
		await h.settle();
		expect(h.channel.texts().some((t) => t.includes("Painted it blue."))).toBe(true);
	});

	it("handles slash commands without a model", async () => {
		h = await harness(() => say("unused"));
		await h.channel.receive("/status");
		await h.channel.receive("/mode auto");
		await h.channel.receive("/pause");
		await h.settle();
		const texts = h.channel.texts();
		expect(texts[0]).toContain("mode observe");
		expect(texts[1]).toBe("Proactive mode: auto.");
		expect(h.daemon.s.paused()).toBe(true);
		expect(h.calls.length).toBe(0);
	});

	it("observe mode records what triage would do and sends nothing; auto mode notifies", async () => {
		let page = "<p>Deadline: March 1</p>";
		const brain = (ctx: import("./helpers/harness.ts").Ctx) => {
			if (ctx.system.includes("You triage events")) {
				if (ctx.lastToolResult) return say("done");
				return call("triage_decide", { action: "notify", reason: "deadline moved", text: "The workshop deadline moved to March 15.", urgency: "normal" });
			}
			return say("?");
		};
		h = await harness(brain, () => {}, { fetcher: async () => page });
		h.daemon.s.watchers.create({ name: "deadline", kind: "url", target: "https://x.test", everyMinutes: 5, instruction: "tell me if the deadline changes" });
		await h.daemon.tickOnce();
		expect(h.calls.length).toBe(0); // the first check is a baseline, no model call
		h.clock.advance(6 * MINUTE);
		await h.daemon.tickOnce();
		expect(h.calls.length).toBe(0); // unchanged page, still no model call
		page = "<p>Deadline: March 15</p>";
		h.clock.advance(6 * MINUTE);
		await h.daemon.tickOnce();
		await h.settle();
		expect(h.calls.length).toBe(2); // one triage session: the decision, then its closing turn
		expect(h.calls[0].system).toContain("Deadline: March 15");
		expect(h.channel.sent.length).toBe(0); // observe: nothing sent
		const events = h.daemon.s.db.all<{ text: string }>("SELECT text FROM events WHERE kind = 'observe'");
		expect(events[0].text).toContain("would notify");

		h.daemon.s.cfg.proactive.mode = "auto";
		page = "<p>Deadline: March 20</p>";
		h.clock.advance(6 * MINUTE);
		await h.daemon.tickOnce();
		await h.settle();
		expect(h.channel.texts()).toEqual(["The workshop deadline moved to March 15."]);

		const review = h.daemon.weeklyReview();
		expect(review).toBe("review queued");
		expect(h.daemon.s.notifier.waiting().some((n) => n.topic === "vigil:review")).toBe(true);
	});

	it("gives triage no tools beyond its decision (rule of two)", async () => {
		const seen: string[] = [];
		h = await harness((ctx) => {
			if (ctx.system.includes("You triage events")) {
				seen.push(ctx.system);
				return ctx.lastToolResult ? say("x") : call("bash", { command: "cat ~/.ssh/id_rsa" });
			}
			return say("?");
		}, (c) => {
			c.proactive.mode = "auto";
		}, { fetcher: async () => `<p>${Math.random()}</p>` });
		h.daemon.s.watchers.create({ name: "w", kind: "url", target: "https://x.test", everyMinutes: 5, instruction: "anything" });
		await h.daemon.tickOnce();
		h.clock.advance(6 * MINUTE);
		await h.daemon.tickOnce();
		await h.settle();
		const lastResult = h.calls.at(-1)?.lastToolResult ?? "";
		expect(lastResult).toMatch(/not found|unknown|not available|Tool bash/i);
		expect(h.channel.sent.length).toBe(0);
	});

	it("answers, after a restart, an owner message that was not answered before the crash", async () => {
		h = await harness((ctx) => say(ctx.lastUser.includes("still there?") ? "Yes, back now." : "?"));
		await h.daemon.stop();
		const { Db } = await import("../src/store/db.ts");
		const db = new Db(join(h.home, "vigil.db"));
		const msg = { channel: "telegram", externalId: "42:99", senderId: "42", conversation: "42", kind: "message", text: "still there?", at: Date.now() };
		db.run("INSERT INTO triggers (source, external_id, kind, strength, payload, status, created_at) VALUES ('telegram', '42:99', 'message', 'explicit', ?, 'processing', ?)", JSON.stringify(msg), h.clock.now());
		db.close();
		const d2 = await h.restart();
		for (let i = 0; i < 50 && !h.channel.sent.length; i++) {
			await new Promise((r) => setTimeout(r, 20));
			await d2.s.outbox.deliverDue();
		}
		expect(h.channel.texts()).toEqual(["Yes, back now."]);
		expect(d2.s.db.get<{ status: string }>("SELECT status FROM triggers WHERE external_id = '42:99'")?.status).toBe("done");
		await d2.stop();
	});

	it("lets a worker fan out parallel helpers with delegate", async () => {
		h = await harness((ctx) => {
			if (isConcierge(ctx)) return ctx.lastToolResult ? say("Started.") : call("spawn_ticket", { title: "Compare two libs", request: "compare A and B", scope: "research" });
			if (ctx.system.includes("You are a helper agent")) return say(ctx.lastUser.includes("library A") ? "A: fast, MIT" : "B: small, Apache-2.0");
			if (isWorker(ctx)) {
				if (ctx.lastToolResult.startsWith("Reported")) return say("x");
				const results = ctx.messages.filter((m) => m.role === "toolResult").length;
				if (results >= 2) {
					const seen = JSON.stringify(ctx.messages);
					return call("report", { kind: "ready", summary: seen.includes("A: fast") && seen.includes("B: small") ? "A is fast (MIT), B is small (Apache-2.0)." : "missing helper output" });
				}
				return fauxAssistantMessage([fauxToolCall("delegate", { task: "Summarize library A" }), fauxToolCall("delegate", { task: "Summarize library B" })], { stopReason: "toolUse" });
			}
			return say("?");
		});
		await h.channel.receive("compare A and B");
		await h.settle();
		expect(h.channel.texts().some((t) => t.includes("A is fast (MIT), B is small (Apache-2.0)."))).toBe(true);
		expect(h.calls.filter((c) => c.system.includes("You are a helper agent")).length).toBe(2);
	});

	it("shows a photo from the phone to the model and saves it to the inbox", async () => {
		let sawImage = false;
		h = await harness((ctx) => {
			const last = [...ctx.messages].reverse().find((m) => m.role === "user");
			sawImage = Array.isArray(last?.content) && (last.content as { type: string }[]).some((c) => c.type === "image");
			return say(sawImage ? "Nice receipt." : "no image");
		});
		await h.channel.receive("what is this?", { attachments: [{ kind: "photo", ref: "png", mimeType: "image/png" }] });
		await h.settle();
		expect(sawImage).toBe(true);
		expect(h.channel.texts()).toEqual(["Nice receipt."]);
		expect(h.calls[0].lastUser).toMatch(/photo saved at .*inbox/);
	});

	it("lets the owner interrupt a slow system run, then runs it again", async () => {
		let systemRuns = 0;
		let doneWith = "";
		h = await harness(async (ctx) => {
			if (ctx.lastUser.includes("[job slow]")) {
				systemRuns++;
				if (systemRuns === 1) await new Promise((r) => setTimeout(r, 400));
				return say("OK");
			}
			return say("Here now.");
		});
		h.daemon.concierge.enqueue({ kind: "system", tag: "job slow", text: "think hard", done: (r) => (doneWith = r) });
		await new Promise((r) => setTimeout(r, 60));
		await h.channel.receive("ping");
		await h.settle();
		for (let i = 0; i < 40 && !doneWith; i++) await new Promise((r) => setTimeout(r, 25));
		expect(h.channel.texts()).toEqual(["Here now."]);
		expect(systemRuns).toBe(2);
		expect(doneWith).toBe("OK");
	});

	it("tells the owner once when no model has answered for half an hour", async () => {
		h = await harness(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized: token expired" }), (c) => {
			c.attention.quietHours = null;
		});
		for (const t of ["a", "b", "c"]) {
			await h.channel.receive(t);
			await h.settle(); // one turn each; back-to-back messages would be batched into one (a 401 is not retried by pi)
		}
		const before = h.channel.sent.length;
		h.daemon.checkModelHealth();
		await h.daemon.s.outbox.deliverDue();
		expect(h.channel.sent.length).toBe(before); // not yet: under 30 minutes
		h.clock.advance(31 * MINUTE);
		h.daemon.checkModelHealth();
		h.daemon.checkModelHealth();
		await h.daemon.s.outbox.deliverDue();
		const alerts = h.channel.texts().filter((t) => t.startsWith("I can't reach any model"));
		expect(alerts.length).toBe(1);
	});

	it("pairs the owner with a one-time code from the server log", async () => {
		h = await harness((ctx) => fauxAssistantMessage(ctx.lastUser.includes("hello") ? "Hi, owner." : "?"), (c) => {
			c.owner.identities = {};
		});
		const code = h.daemon.s.db.getKv<{ code: string }>("pair:telegram")!.code;
		expect(code).toMatch(/^[A-Z2-7]{10}$/);
		await h.channel.receive("hello", { senderId: "777", conversation: "777" });
		await h.channel.receive("/pair AAAAAAAAAA", { senderId: "666", conversation: "666" });
		await h.settle();
		expect(h.channel.sent.length).toBe(0); // strangers get nothing, not even an error
		await h.channel.receive(`/pair ${code}`, { senderId: "777", conversation: "777" });
		await h.settle();
		expect(h.channel.texts().some((t) => t.includes("Paired."))).toBe(true);
		expect(h.daemon.s.cfg.owner.identities.telegram).toEqual(["777"]);
		await h.channel.receive("hello", { senderId: "777", conversation: "777" });
		await h.settle();
		expect(h.channel.texts().at(-1)).toBe("Hi, owner.");
		// Once paired, the code is gone and another person cannot pair.
		await h.channel.receive(`/pair ${code}`, { senderId: "666", conversation: "666" });
		await h.settle();
		expect(h.daemon.s.cfg.owner.identities.telegram).toEqual(["777"]);
	});

	it("tells the concierge what a worker reported, so a later question has context", async () => {
		h = await harness((ctx) => {
			if (isConcierge(ctx)) {
				if (ctx.lastUser.includes("what did you find")) return say(ctx.lastUser.includes("reported ready: Cheapest is TAP") ? "TAP, $438." : "no idea");
				return ctx.lastToolResult ? say("On it.") : call("spawn_ticket", { title: "Flights", request: "find flights", scope: "research" });
			}
			if (isWorker(ctx)) return ctx.lastToolResult ? say("x") : call("report", { kind: "ready", summary: "Cheapest is TAP at $438." });
			return say("?");
		});
		await h.channel.receive("find me flights to Lisbon");
		await h.settle();
		await h.channel.receive("what did you find?");
		await h.settle();
		expect(h.channel.texts().at(-1)).toBe("TAP, $438.");
	});

	it("sends the result of a ticket started over HTTP to the owner's chat", async () => {
		h = await harness((ctx) => {
			if (isConcierge(ctx)) return ctx.lastToolResult ? say("Started.") : call("spawn_ticket", { title: "From a shortcut", request: "do it", scope: "x" });
			if (isWorker(ctx)) return ctx.lastToolResult ? say("x") : call("report", { kind: "ready", summary: "Done from the shortcut." });
			return say("?");
		});
		await h.daemon.onInbound({ channel: "http", externalId: "http:req1", senderId: "owner", conversation: "http", kind: "message", text: "do it", at: Date.now() });
		await h.settle();
		expect(h.channel.texts().some((t) => t.includes("Done from the shortcut."))).toBe(true);
	});

	it("consolidates memory at night, commits it, and turns a pattern into one quiet suggestion", async () => {
		h = await harness((ctx) => {
			if (ctx.system.includes("[memory consolidation]") || ctx.lastUser.includes("Consolidate now")) {
				if (ctx.lastToolResult) return say('SUMMARY: Merged two facts.\nREPORT: {"added": 1, "merged": 1}\nSUGGEST: You checked Lisbon fares three mornings running; want a daily 8:30 check?');
				const path = h.daemon.s.memory.memoryPath;
				return call("write", { path, content: "# Memory\n\n## About the owner\n\n## Preferences\n- Prefers aisle seats\n\n## Ongoing\n\n## Facts\n" });
			}
			return say("?");
		}, (c) => {
			c.proactive.dreamAt = "04:00";
		});
		h.daemon.s.memory.journal("owner", "what are Lisbon fares today?");
		h.daemon.s.memory.journal("owner", "remember I prefer aisle seats");
		const job = h.daemon.s.scheduler.list().find((j) => j.name === "dream")!;
		await h.daemon.runJob({ job, slot: h.clock.now(), coalesced: 0, triggerId: 0 });
		const { readFileSync, existsSync } = await import("node:fs");
		expect(readFileSync(h.daemon.s.memory.memoryPath, "utf8")).toContain("Prefers aisle seats");
		expect(existsSync(join(h.home, "memory", ".git"))).toBe(true);
		const waiting = h.daemon.s.notifier.waiting();
		expect(waiting.map((n) => n.topic)).toEqual(["vigil:suggestion"]);
		expect(waiting[0].text).toContain("daily 8:30 check");
		expect(h.channel.sent.length).toBe(0); // low urgency: it waits for the digest
	});

	it("puts an off switch on every interruption, and the mute holds", async () => {
		h = await harness(() => say("?"), (c) => {
			c.attention.quietHours = null;
			c.attention.minGapMinutes = 0;
		});
		h.daemon.s.notifier.notify({ urgency: "high", topic: "ci", text: "CI is red on main." });
		await h.daemon.s.outbox.deliverDue();
		const sent = h.channel.sent[0];
		expect(sent.buttons?.[0].map((b) => b.label)).toEqual(["🔕 Mute 1 day", "👎 Less like this"]);
		await h.channel.receive("", { kind: "button", data: sent.buttons![0][0].data });
		await h.settle();
		expect(h.channel.texts().at(-1)).toContain('Muted "ci"');
		const again = h.daemon.s.notifier.notify({ urgency: "high", topic: "ci", text: "CI is still red." });
		expect(again.decision).toBe("drop:muted");
	});

	it("explains recent attention decisions with /why", async () => {
		h = await harness(() => say("?"), (c) => {
			c.attention.quietHours = null;
		});
		h.daemon.s.notifier.notify({ urgency: "high", topic: "ci", text: "CI is red." });
		h.daemon.s.notifier.notify({ urgency: "low", topic: "arxiv", text: "New paper." });
		h.daemon.s.notifier.notify({ urgency: "high", topic: "ci", text: "CI is red." });
		await h.channel.receive("/why");
		await h.settle();
		const why = h.channel.texts().at(-1)!;
		expect(why).toContain("Budget: 1/3");
		expect(why).toContain("sent now [high/ci]");
		expect(why).toContain("saved for the digest [low/arxiv]");
		expect(why).toContain("dropped: you already had this news");
	});

	it("pairing codes expire, and ten wrong guesses lock pairing until restart", async () => {
		h = await harness(() => say("?"), (c) => {
			c.owner.identities = {};
		});
		const code = h.daemon.s.db.getKv<{ code: string }>("pair:telegram")!.code;
		for (let i = 0; i < 10; i++) await h.channel.receive(`/pair ${"B".repeat(10)}`, { senderId: "666", conversation: "666" });
		await h.channel.receive(`/pair ${code}`, { senderId: "777", conversation: "777" });
		await h.settle();
		expect(h.daemon.s.cfg.owner.identities.telegram).toBeUndefined();

		const h2 = await harness(() => say("?"), (c) => {
			c.owner.identities = {};
		});
		const code2 = h2.daemon.s.db.getKv<{ code: string }>("pair:telegram")!.code;
		h2.clock.advance(16 * MINUTE);
		await h2.channel.receive(`/pair ${code2}`, { senderId: "777", conversation: "777" });
		expect(h2.daemon.s.cfg.owner.identities.telegram).toBeUndefined();
		await h2.daemon.stop();
	});
});
