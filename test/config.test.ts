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
	it("reads any dream schedule /dream accepts, and rejects the rest", () => {
		expect(load({ owner: { timezone: "UTC" }, proactive: { dreamAt: "every 12h" } }).proactive.dreamAt).toBe("every 12h");
		expect(load({ owner: { timezone: "UTC" }, proactive: { dreamAt: "weekly sun 03:00" } }).proactive.dreamAt).toBe("weekly sun 03:00");
		expect(() => load({ owner: { timezone: "UTC" }, proactive: { dreamAt: "sometimes" } })).toThrow(/proactive.dreamAt/);
	});

	it("rejects a bad time zone with a clear message", () => {
		expect(() => load({ owner: { timezone: "Mars/Olympus" } })).toThrow(/IANA/);
	});
});

describe("config secrets and identities", () => {
	it("never writes secrets that came from the environment", async () => {
		const { readFileSync } = await import("node:fs");
		const { saveConfig } = await import("../src/config.ts");
		process.env.VIGIL_TELEGRAM_TOKEN = "123:from-env";
		const home = mkdtempSync(join(tmpdir(), "vigil-cfg-"));
		writeFileSync(join(home, "config.json"), JSON.stringify({ owner: { timezone: "UTC" }, channels: { telegram: {} } }));
		const c = loadConfig(paths(home));
		expect(c.channels.telegram?.token).toBe("123:from-env");
		c.proactive.mode = "auto";
		saveConfig(c, paths(home));
		const disk = readFileSync(join(home, "config.json"), "utf8");
		expect(disk).not.toContain("from-env");
		expect(disk).toContain('"auto"');
		delete process.env.VIGIL_TELEGRAM_TOKEN;
	});
	it("matches phone-number owners by digits", async () => {
		const { isOwner, defaultConfig } = await import("../src/config.ts");
		const c = defaultConfig();
		c.owner.identities = { signal: ["+92 300 123-4567"], whatsapp: ["923001234567@s.whatsapp.net"] };
		expect(isOwner(c, "signal", "+923001234567")).toBe(true);
		expect(isOwner(c, "whatsapp", "923001234567@s.whatsapp.net")).toBe(true);
		expect(isOwner(c, "signal", "+923001234568")).toBe(false);
	});
});
