// Tests for building channels from config and choosing the owner's notification route.
// Constructing channels does not connect anywhere; nothing here starts one.

import { describe, expect, it } from "vitest";
import { createChannels, ownerRoute } from "../../src/channels/index.ts";
import { defaultConfig, paths } from "../../src/config.ts";

function config() {
	const cfg = defaultConfig();
	cfg.owner.identities = { telegram: ["42"], discord: ["99"] };
	cfg.owner.notify = ["whatsapp", "discord", "telegram", "ntfy"];
	return cfg;
}

describe("createChannels", () => {
	it("creates configured channels and logs why others are skipped", () => {
		const cfg = config();
		cfg.channels = {
			telegram: { token: "123:abc" },
			discord: {},
			ntfy: { server: "https://ntfy.sh", topic: "t" },
			http: { port: 0 },
		};
		const lines: string[] = [];
		const chans = createChannels(cfg, paths("/tmp/vigil-test-home"), { log: (l) => lines.push(l) });
		expect([...chans.keys()].sort()).toEqual(["ntfy", "telegram"]);
		expect(lines.some((l) => l.includes("discord skipped: no token"))).toBe(true);
		expect(lines.some((l) => l.includes("http skipped: no token"))).toBe(true);
		expect(lines.some((l) => l.includes("ntfy notifications will have no action buttons"))).toBe(true);
	});

	it("creates WhatsApp only when enabled, and the CLI on request", () => {
		const cfg = config();
		cfg.channels = { whatsapp: { enabled: false }, http: { port: 0, token: "x" } };
		const off = createChannels(cfg, paths("/tmp/vigil-test-home"), { log: () => {}, cli: true });
		expect([...off.keys()].sort()).toEqual(["cli", "http"]);
		cfg.channels.whatsapp = { enabled: true };
		cfg.owner.identities.whatsapp = ["923001234567@s.whatsapp.net"];
		const on = createChannels(cfg, paths("/tmp/vigil-test-home"), { log: () => {} });
		expect(on.get("whatsapp")?.ownerConversation()).toBe("923001234567@s.whatsapp.net");
	});
});

describe("ownerRoute", () => {
	it("picks the first channel in notify order that knows the owner's conversation", () => {
		const cfg = config();
		cfg.channels = { telegram: { token: "123:abc" }, discord: { token: "d" }, http: { port: 0, token: "x" } };
		const chans = createChannels(cfg, paths("/tmp/vigil-test-home"), { log: () => {} });
		const route = ownerRoute(cfg, chans);
		expect(route?.channel.id).toBe("discord");
		expect(route?.conversation).toBe("dm:99");
		chans.delete("discord");
		expect(ownerRoute(cfg, chans)?.conversation).toBe("42");
	});

	it("returns undefined when no channel can reach the owner", () => {
		const cfg = config();
		cfg.owner.identities = {};
		cfg.channels = { telegram: { token: "123:abc" }, http: { port: 0, token: "x" } };
		expect(ownerRoute(cfg, createChannels(cfg, paths("/tmp/vigil-test-home"), { log: () => {} }))).toBeUndefined();
	});
});
