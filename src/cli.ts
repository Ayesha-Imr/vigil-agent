#!/usr/bin/env node
// The vigil command: set up, log in, run the daemon, chat locally, check health.

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelRouter } from "./agent/models.ts";
import { bwrapWorks } from "./agent/sandbox.ts";
import { createChannels } from "./channels/index.ts";
import { type ChannelId, defaultConfig, loadConfig, type ModelRole, type Paths, paths, saveConfig, scrubSecretEnv, type VigilConfig } from "./config.ts";
import { systemClock } from "./core/time.ts";
import { Daemon } from "./daemon.ts";
import { panelRoutes } from "./panel/panel.ts";
import { recordedNotices, renderReport, simulate, syntheticWeek } from "./simulate.ts";

const USAGE = `vigil — an always-on personal agent on pi

  vigil init                 set up ~/.vigil (owner, time zone, channels)
  vigil login codex          log in with your ChatGPT plan (device code; works over SSH)
  vigil login opencode       store an OpenCode Go API key
  vigil models               which models each role would use
  vigil start                run the daemon in the foreground
  vigil chat                 talk to vigil in this terminal (runs an embedded daemon)
  vigil status               what is going on (reads the database)
  vigil doctor               check the setup
  vigil simulate [--max N] [--gap MIN] [--quiet HH:MM-HH:MM] [--synthetic]
                             replay your last week of notices under another attention policy
  vigil service              print a systemd unit for running vigil always
  vigil verify               run the formal verification (needs Java)

Environment: VIGIL_HOME (default ~/.vigil), VIGIL_TELEGRAM_TOKEN, VIGIL_DISCORD_TOKEN,
VIGIL_HTTP_TOKEN, VIGIL_NTFY_TOKEN, OPENCODE_API_KEY.`;

async function runtimeFor(p: Paths): Promise<ModelRuntime> {
	mkdirSync(p.agentDir, { recursive: true });
	return await ModelRuntime.create({ authPath: join(p.agentDir, "auth.json"), modelsPath: join(p.agentDir, "models.json"), allowModelNetwork: true });
}

async function ask(rl: ReturnType<typeof createInterface>, q: string, def = ""): Promise<string> {
	const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
	return a || def;
}

async function init(p: Paths): Promise<void> {
	const cfg: VigilConfig = existsSync(p.config) ? loadConfig(p) : defaultConfig();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	console.log(`Setting up vigil in ${p.home}. Enter keeps the value in brackets.\n`);
	cfg.owner.name = await ask(rl, "Your name", cfg.owner.name === "owner" ? "" : cfg.owner.name);
	cfg.owner.timezone = await ask(rl, "Your time zone (IANA, e.g. Asia/Karachi)", cfg.owner.timezone);
	console.log("\nTelegram is the recommended channel: talk to @BotFather, /newbot, copy the token.");
	const tg = await ask(rl, "Telegram bot token (empty to skip)", cfg.channels.telegram?.token ?? "");
	if (tg) {
		cfg.channels.telegram = { token: tg };
		console.log("Your Telegram user id (message @userinfobot), or leave empty to pair later: vigil start prints a /pair code to send to the bot.");
		const id = await ask(rl, "Your Telegram user id (optional)", cfg.owner.identities.telegram?.[0] ?? "");
		if (id) cfg.owner.identities.telegram = [id];
	}
	const dc = await ask(rl, "Discord bot token (empty to skip)", cfg.channels.discord?.token ?? "");
	if (dc) {
		cfg.channels.discord = { token: dc };
		const id = await ask(rl, "Your Discord user id (optional; or pair later with /pair)", cfg.owner.identities.discord?.[0] ?? "");
		if (id) cfg.owner.identities.discord = [id];
	}
	const wa = (await ask(rl, "Enable WhatsApp via Baileys? Unofficial; use a spare number (y/N)", cfg.channels.whatsapp?.enabled ? "y" : "n")).toLowerCase().startsWith("y");
	if (wa) {
		cfg.channels.whatsapp = { enabled: true };
		const jid = await ask(rl, "Your own WhatsApp number in international format, digits only (e.g. 923001234567)", (cfg.owner.identities.whatsapp?.[0] ?? "").replace(/@.*/, ""));
		if (jid) cfg.owner.identities.whatsapp = [`${jid.replace(/\D/g, "")}@s.whatsapp.net`];
	}
	const ntfy = await ask(rl, "ntfy topic for push notifications (empty to skip)", cfg.channels.ntfy?.topic ?? "");
	if (ntfy) cfg.channels.ntfy = { server: cfg.channels.ntfy?.server ?? "https://ntfy.sh", topic: ntfy };
	cfg.channels.http = { port: cfg.channels.http?.port ?? 7777, token: cfg.channels.http?.token ?? randomBytes(18).toString("base64url"), publicUrl: cfg.channels.http?.publicUrl };
	const quiet = await ask(rl, "Quiet hours, HH:MM-HH:MM", cfg.attention.quietHours ? `${cfg.attention.quietHours.start}-${cfg.attention.quietHours.end}` : "22:30-08:00");
	const [qs, qe] = quiet.split("-");
	if (qs && qe) cfg.attention.quietHours = { start: qs.trim(), end: qe.trim() };
	const budget = await ask(rl, "Max interruptions per day (not counting digests and replies)", String(cfg.attention.maxInterruptsPerDay));
	cfg.attention.maxInterruptsPerDay = Number(budget) || cfg.attention.maxInterruptsPerDay;
	rl.close();
	saveConfig(cfg, p);
	console.log(`\nSaved ${p.config}. Panel token: ${cfg.channels.http.token}`);
	console.log("Next: vigil login codex  (and/or)  vigil login opencode, then vigil start.");
}

async function login(p: Paths, which: string): Promise<void> {
	const runtime = await runtimeFor(p);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		if (which === "codex" || which === "openai-codex") {
			await runtime.login("openai-codex", "oauth", {
				prompt: async (pr) => {
					if (pr.type === "select") {
						const device = pr.options.find((o) => o.id.includes("device"));
						return device?.id ?? pr.options[0].id;
					}
					return await rl.question(`${pr.message} `);
				},
				notify: (e) => {
					if (e.type === "device_code") console.log(`\nOpen ${e.verificationUri} on any device and enter: ${e.userCode}\nWaiting…`);
					else if (e.type === "auth_url") console.log(`\nOpen: ${e.url}\n${e.instructions ?? ""}`);
					else if (e.type === "info" || e.type === "progress") console.log(e.message);
				},
			});
			console.log("Logged in to ChatGPT (openai-codex).");
		} else if (which === "opencode" || which === "opencode-go") {
			const key = process.env.OPENCODE_API_KEY || (await rl.question("OpenCode Go API key (from opencode.ai): ")).trim();
			await runtime.login("opencode-go", "api_key", { prompt: async () => key, notify: () => {} });
			console.log("Stored the OpenCode Go key.");
		} else {
			console.log("vigil login codex | opencode");
		}
	} finally {
		rl.close();
	}
}

async function models(p: Paths): Promise<void> {
	const cfg = loadConfig(p);
	const runtime = await runtimeFor(p);
	const router = new ModelRouter(runtime, () => cfg.models, systemClock);
	await router.refresh();
	for (const role of ["concierge", "worker", "triage", "dream"] as ModelRole[]) {
		const c = router.candidates(role);
		console.log(`${role.padEnd(10)} ${c.length ? c.slice(0, 4).map((m) => `${m.provider}/${m.id}`).join("  ") : "(none — log in first)"}`);
	}
	console.log(`\nPreferences live in ${p.config} under "models"; "provider/*" means any model of that provider.`);
}

function status(p: Paths): void {
	if (!existsSync(p.db)) {
		console.log("vigil has not run yet.");
		return;
	}
	const sql = (q: string) => {
		const r = spawnSync(process.execPath, ["-e", `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(p.db)},{readOnly:true});console.log(JSON.stringify(d.prepare(${JSON.stringify(q)}).all()))`], { encoding: "utf8" });
		return JSON.parse(r.stdout || "[]") as Record<string, unknown>[];
	};
	const open = sql("SELECT id, stage, title FROM tickets WHERE status = 'open'");
	const approvals = sql("SELECT id, tool, reason FROM approvals WHERE status = 'pending'");
	const events = sql("SELECT at, kind, text FROM events ORDER BY id DESC LIMIT 12");
	console.log(`open tickets: ${open.length}`);
	for (const t of open) console.log(`  ${t.id} [${t.stage}] ${t.title}`);
	if (approvals.length) console.log(`approvals waiting: ${approvals.map((a) => `${a.id} ${a.tool} (${a.reason})`).join(", ")}`);
	console.log("recent:");
	for (const e of events.reverse()) console.log(`  ${new Date(Number(e.at)).toLocaleTimeString()} ${e.kind}: ${e.text}`);
}

async function doctor(p: Paths): Promise<void> {
	const ok = (b: boolean, t: string, fix = "") => console.log(`${b ? "✓" : "✗"} ${t}${!b && fix ? `\n    → ${fix}` : ""}`);
	const [maj, min] = process.versions.node.split(".").map(Number);
	ok(maj > 22 || (maj === 22 && min >= 19), `Node ${process.versions.node}`, "pi needs Node 22.19 or newer");
	let cfg: VigilConfig | undefined;
	try {
		cfg = loadConfig(p);
		ok(existsSync(p.config), `config at ${p.config}`, "run vigil init");
	} catch (err) {
		ok(false, `config: ${(err as Error).message}`);
	}
	if (!cfg) return;
	const ids = cfg.owner.identities;
	ok(Object.values(ids).some((v) => v && v.length), "an owner identity is set", "vigil init, or set owner.identities in config.json");
	const channels = createChannels(cfg, p, { log: (l) => console.log(`  ${l}`) });
	ok([...channels.keys()].some((c) => c !== "http"), `channels: ${[...channels.keys()].join(", ") || "none"}`, "configure Telegram, Discord, WhatsApp or ntfy");
	const runtime = await runtimeFor(p);
	const router = new ModelRouter(runtime, () => cfg.models, systemClock);
	await router.refresh();
	for (const role of ["concierge", "worker"] as ModelRole[]) {
		const m = router.pick(role);
		ok(Boolean(m), `${role} model: ${m ? `${m.provider}/${m.id}` : "none"}`, "vigil login codex, or vigil login opencode");
	}
	ok(bwrapWorks() || cfg.sandbox === "off", `shell sandbox: ${bwrapWorks() ? (cfg.sandbox === "off" ? "available but off" : "bubblewrap active") : "not available"}`, "apt install bubblewrap (strongly recommended)");
	let java = false;
	try {
		execFileSync("java", ["-version"], { stdio: "ignore" });
		java = true;
	} catch {}
	ok(java, "Java (for vigil verify)", "optional: install a JRE to run the TLA+ checks");
	console.log(`proactive mode: ${cfg.proactive.mode} · quiet ${cfg.attention.quietHours ? `${cfg.attention.quietHours.start}-${cfg.attention.quietHours.end}` : "off"} · ${cfg.attention.maxInterruptsPerDay} interrupts/day`);
}

async function start(p: Paths, opts: { cli: boolean }): Promise<Daemon> {
	const cfg = loadConfig(p);
	// Secrets are in cfg now; take them out of the environment the agent's shells inherit.
	const secrets = scrubSecretEnv();
	let daemonRef: Daemon | undefined;
	const channels = createChannels(cfg, p, {
		cli: opts.cli ? { onClose: () => void shutdown() } : false,
		httpHandlers: panelRoutes(() => daemonRef),
		httpHost: process.env.VIGIL_HTTP_HOST,
	});
	if (opts.cli) {
		cfg.owner.notify = ["cli" as ChannelId, ...cfg.owner.notify.filter((c) => c !== "cli")];
		// A terminal session has no other owner identity to check; the CLI channel is the owner.
	}
	const daemon = await Daemon.create({ paths: p, cfg, channels, log: opts.cli ? () => {} : (l) => console.log(`[vigil] ${l}`) });
	daemonRef = daemon;
	if (secrets.OPENCODE_API_KEY) await daemon.s.modelRuntime.setRuntimeApiKey("opencode-go", secrets.OPENCODE_API_KEY);
	await daemon.s.models.refresh();
	await daemon.start();
	const http = cfg.channels.http;
	if (!opts.cli && http?.token) console.log(`[vigil] panel: http://127.0.0.1:${http.port}/panel (token: channels.http.token in ${p.config})`);
	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await daemon.stop();
		process.exit(0);
	};
	// An always-on daemon must not die of one stray promise; log it and keep going.
	process.on("unhandledRejection", (err) => console.error(`[vigil] unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
	process.on("uncaughtException", (err) => console.error(`[vigil] uncaught exception: ${err.stack ?? err.message}`));
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	return daemon;
}

function simulateCmd(p: Paths, argv: string[]): void {
	const cfg = existsSync(p.config) ? loadConfig(p) : defaultConfig();
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i === -1 ? undefined : argv[i + 1];
	};
	const policy = { ...cfg.attention, timezone: cfg.owner.timezone };
	if (flag("--max")) policy.maxInterruptsPerDay = Number(flag("--max"));
	if (flag("--gap")) policy.minGapMinutes = Number(flag("--gap"));
	if (flag("--quiet")) {
		const [a, b] = flag("--quiet")!.split("-");
		policy.quietHours = a && b ? { start: a, end: b } : null;
	}
	if (flag("--digests")) policy.digestTimes = flag("--digests")!.split(",").filter(Boolean);
	const recorded = argv.includes("--synthetic") ? [] : recordedNotices(p.db, Date.now() - 7 * 86_400_000);
	const stream = recorded.length ? recorded : syntheticWeek(Date.now() - 7 * 86_400_000);
	console.log(renderReport(simulate(stream, policy), recorded.length ? `your last 7 days (${recorded.length} notices)` : "a synthetic noisy week", policy));
}

function service(p: Paths): void {
	const here = dirname(fileURLToPath(import.meta.url));
	const entry = join(here, "cli.js");
	const unit = `[Unit]
Description=vigil personal agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=VIGIL_HOME=${p.home}
ExecStart=${process.execPath} ${existsSync(entry) ? entry : join(here, "cli.ts")} start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
	const target = join(homedir(), ".config", "systemd", "user", "vigil.service");
	console.log(unit);
	console.log(`# Save as ${target}, then:\n#   systemctl --user daemon-reload && systemctl --user enable --now vigil\n#   loginctl enable-linger $USER   # keep it running after you log out`);
	if (process.argv.includes("--write")) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, unit);
		console.log(`# written to ${target}`);
	}
}

function verify(): void {
	const here = dirname(fileURLToPath(import.meta.url));
	const script = [join(here, "..", "verification", "run.sh"), join(here, "..", "..", "verification", "run.sh")].find(existsSync);
	if (!script) {
		console.log("verification/run.sh not found");
		process.exit(1);
	}
	const r = spawnSync("bash", [script], { stdio: "inherit" });
	process.exit(r.status ?? 1);
}

async function main(): Promise<void> {
	process.removeAllListeners("warning");
	process.on("warning", (w) => {
		if (w.name !== "ExperimentalWarning") console.warn(w);
	});
	const [cmd, arg] = process.argv.slice(2);
	const p = paths();
	switch (cmd) {
		case "init":
			return await init(p);
		case "login":
			return await login(p, arg ?? "");
		case "models":
			return await models(p);
		case "start":
			await start(p, { cli: false });
			return;
		case "chat":
			await start(p, { cli: true });
			return;
		case "status":
			return status(p);
		case "doctor":
			return await doctor(p);
		case "service":
			return service(p);
		case "simulate":
			return simulateCmd(p, process.argv.slice(3));
		case "verify":
			return verify();
		default:
			console.log(USAGE);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
