// The panel's HTTP API: authentication, state, notify, ticket, and what it refuses by default.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpChannel } from "../src/channels/http.ts";
import { defaultConfig, paths } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { panelRoutes } from "../src/panel/panel.ts";
import { FakeChannel } from "./helpers/harness.ts";

const PORT = 19000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;
let daemon: Daemon;
const phone = new FakeChannel();

beforeAll(async () => {
	const cfg = defaultConfig();
	cfg.owner.timezone = "UTC";
	cfg.owner.identities = { telegram: ["42"] };
	cfg.owner.notify = ["telegram"];
	cfg.attention.quietHours = null;
	cfg.proactive.heartbeatMinutes = 0;
	cfg.proactive.dreamAt = null;
	cfg.channels.http = { port: PORT, token: "sekret" };
	let d: Daemon | undefined;
	const http = new HttpChannel({ port: PORT, token: "sekret", handlers: panelRoutes(() => d), log: () => {} });
	const rt = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	d = await Daemon.create({ paths: paths(mkdtempSync(join(tmpdir(), "vigil-panel-"))), cfg, channels: new Map<never, never>([["telegram", phone], ["http", http]] as never), modelRuntime: rt, timers: false, log: () => {} });
	await d.start();
	daemon = d;
});
afterAll(async () => {
	await daemon.stop();
});

const req = (path: string, init: RequestInit = {}, token: string | null = "sekret") =>
	fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });

describe("panel API", () => {
	it("refuses requests without the right token", async () => {
		expect((await req("/api/state", {}, null)).status).toBe(401);
		expect((await req("/api/state", {}, "wrong")).status).toBe(401);
		expect((await req("/api/state")).status).toBe(200);
	});
	it("serves the page and the state", async () => {
		const page = await (await fetch(`${base}/panel`)).text();
		expect(page).toContain("<title>vigil</title>");
		const s = (await (await req("/api/state")).json()) as { mode: string; httpApprovals: boolean };
		expect(s.mode).toBe("observe");
		expect(s.httpApprovals).toBe(false);
	});
	it("notify goes through the governor and reaches the phone", async () => {
		const r = (await (await req("/api/notify", { method: "POST", body: JSON.stringify({ text: "Deploy finished", urgency: "high", topic: "deploy" }) })).json()) as { decision: string };
		expect(r.decision).toBe("deliver");
		await daemon.s.outbox.deliverDue();
		expect(phone.texts()).toContain("Deploy finished");
		const low = (await (await req("/api/notify", { method: "POST", body: JSON.stringify({ text: "fyi", urgency: "low" }) })).json()) as { decision: string };
		expect(low.decision).toBe("digest");
	});
	it("ticket creates explicit background work", async () => {
		const r = (await (await req("/api/ticket", { method: "POST", body: JSON.stringify({ title: "From the laptop", request: "summarize the logs" }) })).json()) as { id: string };
		expect(daemon.s.tickets.get(r.id)?.mandate.strength).toBe("explicit");
	});
	it("refuses mode changes and approvals over HTTP by default", async () => {
		const mode = await req("/api/action", { method: "POST", body: JSON.stringify({ data: "mode:auto" }) });
		expect(mode.status).toBe(403);
		expect(daemon.s.cfg.proactive.mode).toBe("observe");
		const a = daemon.s.approvals.request("test", "bash", { command: "sudo true" }, "x", 60_000);
		await req("/api/action", { method: "POST", body: JSON.stringify({ data: `approve:${a.id}` }) });
		expect(daemon.s.approvals.get(a.id)?.status).toBe("pending");
	});
	it("status returns the same text as /status", async () => {
		const r = (await (await req("/api/status")).json()) as { text: string };
		expect(r.text).toContain("mode observe");
	});
});
