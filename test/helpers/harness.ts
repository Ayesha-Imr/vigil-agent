// Test harness: a vigil daemon with a scripted faux model and a fake chat channel.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Channel, InboundMessage, OutboundMessage, SendResult } from "../../src/channels/types.ts";
import { defaultConfig, paths, type VigilConfig } from "../../src/config.ts";
import { ManualClock } from "../../src/core/time.ts";
import { Daemon } from "../../src/daemon.ts";

export { fauxAssistantMessage, fauxToolCall };

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export class FakeChannel implements Channel {
	readonly id = "telegram" as const;
	sent: (OutboundMessage & { externalId: string })[] = [];
	private onInbound?: (m: InboundMessage) => Promise<void>;
	private seq = 0;
	async start(onInbound: (m: InboundMessage) => Promise<void>): Promise<void> {
		this.onInbound = onInbound;
	}
	async send(msg: OutboundMessage): Promise<SendResult> {
		const externalId = `42:${1000 + this.sent.length}`;
		this.sent.push({ ...msg, externalId });
		return { externalId };
	}
	ownerConversation(): string {
		return "42";
	}
	async stop(): Promise<void> {}
	async download(a: { ref: string; mimeType?: string }): Promise<{ data: Buffer; mimeType: string }> {
		if (a.ref === "png") return { data: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" };
		return { data: Buffer.from(`bytes of ${a.ref}`), mimeType: a.mimeType ?? "application/octet-stream" };
	}
	async receive(text: string, opts: Partial<InboundMessage> = {}): Promise<void> {
		this.seq++;
		await this.onInbound!({
			channel: "telegram",
			externalId: `42:${this.seq}`,
			senderId: "42",
			conversation: "42",
			kind: "message",
			text,
			at: Date.now(),
			...opts,
		});
	}
	texts(): string[] {
		return this.sent.map((m) => m.text);
	}
}

export interface Ctx {
	system: string;
	lastUser: string;
	lastToolResult: string;
	messages: { role: string; content: unknown }[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: string }).text) : "")).join("");
	return "";
}

/** Route every model call through one function that sees the role's system prompt. */
export type Brain = (ctx: Ctx) => AssistantMessage | Promise<AssistantMessage>;

export interface Harness {
	daemon: Daemon;
	channel: FakeChannel;
	clock: ManualClock;
	cfg: VigilConfig;
	home: string;
	calls: Ctx[];
	settle: () => Promise<void>;
	/** Start another daemon on the same home, as after a restart. */
	restart: () => Promise<Daemon>;
}

export async function harness(brain: Brain, tweak: (cfg: VigilConfig) => void = () => {}, opts: { fetcher?: (url: string) => Promise<string> } = {}): Promise<Harness> {
	const home = mkdtempSync(join(tmpdir(), "vigil-test-"));
	const p = paths(home);
	const cfg = defaultConfig();
	cfg.owner.name = "Ayesha";
	cfg.owner.timezone = "UTC";
	cfg.owner.identities = { telegram: ["42"] };
	cfg.owner.notify = ["telegram"];
	cfg.models = { concierge: ["faux/*"], worker: ["faux/*"], triage: ["faux/*"], dream: ["faux/*"] };
	cfg.proactive.heartbeatMinutes = 0;
	cfg.proactive.dreamAt = null;
	tweak(cfg);

	const calls: Ctx[] = [];
	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4000 }] });
	const responder = (context: { messages: { role: string; content: unknown }[] }) => {
		const msgs = context.messages;
		const ctx: Ctx = {
			system: msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n"),
			lastUser: textOf([...msgs].reverse().find((m) => m.role === "user")?.content),
			lastToolResult: textOf([...msgs].reverse().find((m) => m.role === "toolResult")?.content),
			messages: msgs,
		};
		calls.push(ctx);
		return brain(ctx);
	};
	faux.setResponses(Array.from({ length: 200 }, () => responder as never));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	runtime.registerProvider("faux", {
		baseUrl: "http://faux.invalid",
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({ id: m.id, name: m.name, api: m.api, reasoning: false, input: ["text", "image"], cost: m.cost, contextWindow: 200_000, maxTokens: 4000 })),
	} as never);

	const clock = new ManualClock(Date.UTC(2026, 10, 4, 12, 0, 0));
	const channel = new FakeChannel();
	const daemon = await Daemon.create({
		paths: p,
		cfg,
		channels: new Map([["telegram", channel]]),
		clock,
		modelRuntime: runtime,
		timers: false,
		fetcher: opts.fetcher,
		log: () => {},
	});
	await daemon.start();
	const settle = async () => {
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 20));
			await daemon.s.outbox.deliverDue();
			if (daemon.concierge.pending() === 0 && daemon.workers.activeCount() === 0) {
				await new Promise((r) => setTimeout(r, 20));
				await daemon.s.outbox.deliverDue();
				if (daemon.concierge.pending() === 0 && daemon.workers.activeCount() === 0) return;
			}
		}
	};
	const restart = async () => {
		const d2 = await Daemon.create({ paths: p, cfg, channels: new Map([["telegram", channel]]), clock, modelRuntime: runtime, timers: false, log: () => {} });
		await d2.start();
		return d2;
	};
	return { daemon, channel, clock, cfg, home, calls, settle, restart };
}

export function isWorker(ctx: Ctx): boolean {
	return ctx.system.includes("You are a vigil worker");
}
export function isConcierge(ctx: Ctx): boolean {
	return ctx.system.includes("always-on personal agent");
}
