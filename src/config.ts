// vigil's configuration: one JSON file under VIGIL_HOME, defaults for everything, secrets from
// the environment when present.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, type GovernorPolicy } from "./core/governor.ts";

export type ChannelId = "telegram" | "discord" | "whatsapp" | "http" | "cli" | "ntfy";

export type AcceptMode = "off" | "observe" | "auto";

export interface VigilConfig {
	owner: {
		name: string;
		timezone: string;
		/** Owner identities per channel: Telegram user ids, Discord user ids, WhatsApp JIDs. */
		identities: Partial<Record<ChannelId, string[]>>;
		/** Where proactive notifications go, in order of preference. */
		notify: ChannelId[];
	};
	channels: {
		telegram?: { token?: string };
		discord?: { token?: string };
		whatsapp?: { enabled: boolean };
		ntfy?: { server: string; topic: string; token?: string };
		/** `publicUrl` is where the phone can reach this server (for ntfy action buttons), if anywhere. */
		http?: { port: number; token?: string; publicUrl?: string };
	};
	/** Ordered `provider/model` candidates per role. The first one with credentials wins. */
	models: Record<ModelRole, string[]>;
	attention: Omit<GovernorPolicy, "timezone">;
	proactive: {
		mode: AcceptMode;
		/** Minutes between heartbeats; 0 turns the heartbeat off. */
		heartbeatMinutes: number;
		/** Local time of the nightly memory consolidation, or null for none. */
		dreamAt: string | null;
	};
	workers: { max: number };
	approvals: { ttlMinutes: number };
}

export type ModelRole = "concierge" | "worker" | "triage" | "dream";

/**
 * Default model preferences. Codex (ChatGPT subscription) first, OpenCode Go second. Entries
 * name a provider and a model id from pi's catalog; `provider/*` picks that provider's first
 * available model. Run `vigil models` to see what your credentials can use.
 */
export const DEFAULT_MODELS: Record<ModelRole, string[]> = {
	concierge: ["openai-codex/*", "opencode-go/*"],
	worker: ["openai-codex/*", "opencode-go/*"],
	triage: ["opencode-go/*", "openai-codex/*"],
	dream: ["opencode-go/*", "openai-codex/*"],
};

export function defaultConfig(): VigilConfig {
	const { timezone: _tz, ...attention } = DEFAULT_POLICY;
	return {
		owner: {
			name: "owner",
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
			identities: {},
			notify: ["telegram", "discord", "whatsapp", "ntfy"],
		},
		channels: { http: { port: 7777 } },
		models: structuredClone(DEFAULT_MODELS),
		attention,
		proactive: { mode: "observe", heartbeatMinutes: 60, dreamAt: "04:00" },
		workers: { max: 2 },
		approvals: { ttlMinutes: 30 },
	};
}

export function vigilHome(): string {
	return process.env.VIGIL_HOME ?? join(homedir(), ".vigil");
}

export interface Paths {
	home: string;
	config: string;
	db: string;
	agentDir: string;
	sessions: string;
	work: string;
	memory: string;
	skills: string;
	policy: string;
}

export function paths(home = vigilHome()): Paths {
	return {
		home,
		config: join(home, "config.json"),
		db: join(home, "vigil.db"),
		agentDir: join(home, "pi"),
		sessions: join(home, "sessions"),
		work: join(home, "work"),
		memory: join(home, "memory"),
		skills: join(home, "skills"),
		policy: join(home, "policy.json"),
	};
}

function merge<T>(base: T, over: unknown): T {
	if (over === null || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
	if (base === null || typeof base !== "object" || Array.isArray(base)) return over as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
		out[k] = k in out ? merge(out[k], v) : v;
	}
	return out as T;
}

/** Load config from disk, apply defaults and environment secrets. */
export function loadConfig(p: Paths = paths()): VigilConfig {
	let fromDisk: unknown = {};
	if (existsSync(p.config)) {
		try {
			fromDisk = JSON.parse(readFileSync(p.config, "utf8"));
		} catch (err) {
			throw new Error(`cannot parse ${p.config}: ${(err as Error).message}`);
		}
	}
	const cfg = merge(defaultConfig(), fromDisk);
	const env = process.env;
	if (env.VIGIL_TELEGRAM_TOKEN) cfg.channels.telegram = { ...cfg.channels.telegram, token: env.VIGIL_TELEGRAM_TOKEN };
	if (env.VIGIL_DISCORD_TOKEN) cfg.channels.discord = { ...cfg.channels.discord, token: env.VIGIL_DISCORD_TOKEN };
	if (env.VIGIL_HTTP_TOKEN && cfg.channels.http) cfg.channels.http.token = env.VIGIL_HTTP_TOKEN;
	if (env.VIGIL_NTFY_TOKEN && cfg.channels.ntfy) cfg.channels.ntfy.token = env.VIGIL_NTFY_TOKEN;
	validate(cfg);
	return cfg;
}

function validate(cfg: VigilConfig): void {
	try {
		new Intl.DateTimeFormat("en", { timeZone: cfg.owner.timezone });
	} catch {
		throw new Error(`owner.timezone "${cfg.owner.timezone}" is not an IANA time zone`);
	}
	if (!["off", "observe", "auto"].includes(cfg.proactive.mode)) {
		throw new Error(`proactive.mode must be off, observe or auto`);
	}
	if (cfg.workers.max < 1) throw new Error("workers.max must be at least 1");
}

export function saveConfig(cfg: VigilConfig, p: Paths = paths()): void {
	mkdirSync(p.home, { recursive: true });
	writeFileSync(p.config, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

export function governorPolicy(cfg: VigilConfig): GovernorPolicy {
	return { ...cfg.attention, timezone: cfg.owner.timezone };
}

/** Whether `senderId` on `channel` is the owner. */
export function isOwner(cfg: VigilConfig, channel: ChannelId, senderId: string): boolean {
	// The CLI runs on the server itself and the HTTP API checks its token before it gets here.
	if (channel === "cli" || channel === "http") return true;
	return (cfg.owner.identities[channel] ?? []).includes(senderId);
}
