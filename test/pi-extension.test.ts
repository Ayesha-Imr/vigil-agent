// The pi package's extension, loaded by pi's own loader into a pi session, drives a real vigil
// daemon over its HTTP API.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { HttpChannel } from "../src/channels/http.ts";
import { defaultConfig, paths } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { panelRoutes } from "../src/panel/panel.ts";
import { FakeChannel } from "./helpers/harness.ts";

const PORT = 17000 + Math.floor(Math.random() * 2000);
let daemon: Daemon | undefined;
afterAll(async () => {
	await daemon?.stop();
});

describe("pi extension vigil-remote", () => {
	it("registers its tools in pi and pushes a notice to the phone through vigil", async () => {
		const home = mkdtempSync(join(tmpdir(), "vigil-ext-"));
		const cfg = defaultConfig();
		cfg.owner.timezone = "UTC";
		cfg.owner.identities = { telegram: ["42"] };
		cfg.owner.notify = ["telegram"];
		cfg.attention.quietHours = null;
		cfg.proactive.heartbeatMinutes = 0;
		cfg.proactive.dreamAt = null;
		const phone = new FakeChannel();
		const http = new HttpChannel({ port: PORT, token: "tok", handlers: panelRoutes(() => daemon), log: () => {} });
		const rt = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		daemon = await Daemon.create({ paths: paths(home), cfg, channels: new Map<never, never>([["telegram", phone], ["http", http]] as never), modelRuntime: rt, timers: false, log: () => {} });
		await daemon.start();

		process.env.VIGIL_URL = `http://127.0.0.1:${PORT}`;
		process.env.VIGIL_HTTP_TOKEN = "tok";
		const faux = registerFauxProvider({ provider: "fauxpi", models: [{ id: "m" }] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("vigil_notify", { text: "Training run finished: loss 0.21", urgency: "high" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Sent."),
		]);
		const piRt = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		piRt.registerProvider("fauxpi", { baseUrl: "http://x.invalid", apiKey: "k", api: faux.api, models: [{ id: "m", name: "m", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } as never);
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
		const loader = new DefaultResourceLoader({ cwd: home, agentDir, additionalExtensionPaths: [join(process.cwd(), "pi", "vigil-remote.ts")], noContextFiles: true });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: home, agentDir, model: piRt.getModel("fauxpi", "m")!, modelRuntime: piRt, resourceLoader: loader, sessionManager: SessionManager.inMemory(home), settingsManager: SettingsManager.inMemory({}) });
		expect(session.getAllTools().map((t) => t.name)).toEqual(expect.arrayContaining(["vigil_ticket", "vigil_notify", "vigil_ask"]));
		await session.prompt("tell my phone the run finished");
		session.dispose();
		await daemon.s.outbox.deliverDue();
		expect(phone.texts()).toEqual(["Training run finished: loss 0.21"]);
	});
});
