// Config loading: defaults fill gaps, explicit nulls turn things off, env secrets apply.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, paths } from "../src/config.ts";

function load(json: unknown) {
	const home = mkdtempSync(join(tmpdir(), "vigil-cfg-"));
	writeFileSync(join(home, "config.json"), JSON.stringify(json));
	return loadConfig(paths(home));
}

describe("config", () => {
	it("fills defaults for missing keys", () => {
		const c = load({ owner: { name: "A", timezone: "UTC" } });
		expect(c.attention.maxInterruptsPerDay).toBe(3);
		expect(c.proactive.dreamAt).toBe("04:00");
		expect(c.owner.name).toBe("A");
	});
	it("an explicit null turns a feature off", () => {
		const c = load({ owner: { timezone: "UTC" }, attention: { quietHours: null }, proactive: { dreamAt: null } });
		expect(c.attention.quietHours).toBeNull();
		expect(c.proactive.dreamAt).toBeNull();
		expect(c.attention.digestTimes).toEqual(["09:00", "18:00"]);
	});
	it("rejects a bad time zone with a clear message", () => {
		expect(() => load({ owner: { timezone: "Mars/Olympus" } })).toThrow(/IANA/);
	});
});
