// The runtime guard refuses a send the recorded history says breaks a governor rule, even when
// the governor's own state was lost or is wrong.

import { describe, expect, it } from "vitest";
import type { Channel } from "../src/channels/types.ts";
import type { ChannelId } from "../src/config.ts";
import { DEFAULT_POLICY, type GovernorPolicy } from "../src/core/governor.ts";
import { Notifier } from "../src/core/notifier.ts";
import { Outbox } from "../src/core/outbox.ts";
import { HOUR, ManualClock } from "../src/core/time.ts";
import { Db } from "../src/store/db.ts";

function setup() {
	const db = new Db(":memory:");
	const clock = new ManualClock(Date.UTC(2026, 10, 4, 12, 0));
	const outbox = new Outbox(db, clock, new Map<ChannelId, Channel>());
	const policy: GovernorPolicy = { ...DEFAULT_POLICY, timezone: "UTC", maxInterruptsPerDay: 2, minGapMinutes: 0 };
	const make = () => new Notifier({ db, clock, outbox, policy: () => policy, route: () => ({ channel: "telegram", conversation: "1" }) });
	return { db, clock, make };
}

describe("runtime invariant guard", () => {
	it("blocks an interrupt over budget when the governor forgot its history", () => {
		const { db, clock, make } = setup();
		let n = make();
		n.notify({ urgency: "high", topic: "a", text: "one" });
		clock.advance(HOUR);
		n.notify({ urgency: "high", topic: "a", text: "two" });
		expect(db.all("SELECT * FROM outbox").length).toBe(2);
		// The governor's snapshot is lost (say, a bad migration); a fresh one thinks the budget is free.
		db.run("DELETE FROM kv WHERE key = 'governor'");
		n = make();
		clock.advance(HOUR);
		const third = n.notify({ urgency: "high", topic: "a", text: "three" });
		expect(third.decision).toBe("deliver");
		expect(db.all("SELECT * FROM outbox").length).toBe(2);
		const v = db.all<{ text: string }>("SELECT text FROM events WHERE kind = 'invariant.violation'");
		expect(v[0].text).toMatch(/^Budget/);
	});

	it("lets normal traffic through", () => {
		const { db, clock, make } = setup();
		const n = make();
		n.notify({ urgency: "high", topic: "a", text: "one" });
		clock.advance(HOUR);
		n.notify({ urgency: "critical", topic: "b", text: "down" });
		expect(db.all("SELECT * FROM outbox").length).toBe(2);
		expect(db.all("SELECT * FROM events WHERE kind = 'invariant.violation'").length).toBe(0);
	});
});
