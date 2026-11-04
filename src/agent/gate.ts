// The approval gate: a pi extension that classifies every tool call by data-driven rules and
// holds risky calls until the owner approves that exact call. Forbidden calls never run.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Approvals, callHash } from "../core/approvals.ts";

export type Verdict = "safe" | "risky" | "forbidden";

export interface Rule {
	/** Tool name, or "*" for any tool. */
	tool: string;
	/** Regex tested against the call's main text: the bash command, the path, or the JSON args. */
	match: string;
	verdict: Verdict;
	reason: string;
	/** Regex flags; default "i". Use "" where case matters (git branch -D vs -d). */
	flags?: string;
}

export interface GatePolicy {
	rules: Rule[];
	/** Directories write/edit may touch without approval. */
	writableRoots: string[];
}

/** Rules every install starts with. The owner adds more in policy.json; theirs are checked first. */
export const DEFAULT_RULES: Rule[] = [
	{ tool: "*", match: String.raw`(^|[^\w.-])auth\.json\b|\.ssh\b|id_(rsa|ed25519|ecdsa)\b|\.gnupg\b|mcp-auth\.json\b`, verdict: "forbidden", reason: "touches credentials" },
	{ tool: "*", match: String.raw`vigil\.db\b`, verdict: "forbidden", reason: "touches vigil's own database" },
	{ tool: "bash", match: String.raw`\brm\b(?=[^;&|]*\s-(-recursive\b|[a-zA-Z]*[rR]))(?=[^;&|]*\s-(-force\b|[a-zA-Z]*f))`, verdict: "risky", reason: "recursive forced delete", flags: "" },
	{ tool: "bash", match: String.raw`\bsudo\b|\bsu\s+-|\bdoas\b`, verdict: "risky", reason: "runs as another user" },
	{ tool: "bash", match: String.raw`\bgit\s+push\b`, verdict: "risky", reason: "pushes to a remote" },
	{ tool: "bash", match: String.raw`\bgit\s+(reset\s+--hard\b|clean\s+-[a-zA-Z]*f[a-zA-Z]*|branch\s+(-D|--delete\s+--force)\b|checkout\s+--\s+\.|restore\s+\.)`, verdict: "risky", reason: "discards git work", flags: "" },
	{ tool: "bash", match: String.raw`(curl|wget)[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b`, verdict: "risky", reason: "pipes a download into a shell" },
	{ tool: "bash", match: String.raw`\b(mkfs|fdisk|shutdown|reboot|halt|poweroff)\b|\bdd\s+if=|\bsystemctl\s+(stop|disable|mask)\b|\bkill\s+-9\s+1\b`, verdict: "risky", reason: "changes the system" },
	{ tool: "bash", match: String.raw`\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+(repo\s+(delete|create)|release\s+create|pr\s+merge|secret)\b|\bdocker\s+push\b`, verdict: "risky", reason: "publishes or changes something outside" },
	{ tool: "bash", match: String.raw`\bcrontab\s+-r\b|>\s*/etc/|\bchmod\s+-R\s+777\b`, verdict: "risky", reason: "changes system configuration" },
	{ tool: "bash", match: String.raw`\b(sendmail|mail|mutt)\b.*@|\bssh\s+\S+@`, verdict: "risky", reason: "contacts another host or person" },
	{ tool: "add_watcher", match: String.raw`"kind"\s*:\s*"command"`, verdict: "risky", reason: "runs a shell command on a schedule" },
];

/**
 * Rules that protect vigil's own state under its home directory: config and policy (they hold the
 * HTTP token and the approval rules), the credentials, the database and the session transcripts.
 * An agent that could read the token could approve its own calls; one that could edit the policy
 * could widen its own permissions.
 */
export function homeRules(home: string): Rule[] {
	const h = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [
		{
			tool: "*",
			// Under vigil's home only work/, memory/, skills/ and inbox/ are for the agent; everything
			// else (config, policy, credentials, the database, transcripts) is listed by exclusion, so
			// globs such as pi/*.json or vigil.d? do not slip past a list of names.
			match: String.raw`(${h}|\.vigil)/(?!(work|memory|skills|inbox)(/|\b))[^\s'"]`,
			verdict: "forbidden",
			reason: "touches vigil's own configuration, credentials or transcripts",
		},
		{
			// Best effort against `cd ~/.vigil && cat config.json`. A regex cannot follow every shell
			// trick; the real boundary is that approvals do not come from the HTTP API by default.
			tool: "bash",
			match: String.raw`(\.vigil|${h})[\s\S]*\b(config\.json|policy\.json|auth\.json|sessions|whatsapp-auth)\b`,
			verdict: "forbidden",
			reason: "touches vigil's own configuration, credentials or transcripts",
		},
	];
}

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "tool_search"]);
const VIGIL_TOOLS = /^(notify|remember|recall|forget|spawn_ticket|ticket_\w+|schedule_job|list_jobs|cancel_job|add_watcher|list_watchers|remove_watcher|mute_topic|unmute_topic|report|ask_owner|triage_decide)$/;
/** MCP and other external tools whose names suggest a side effect outside vigil. */
const READ_ONLY = /^(get|list|read|search|fetch|query|find|lookup|view|describe|show|count|check)([_-]|[A-Z])/;
const SIDE_EFFECT = /(send|create|delete|remove|update|post|write|cancel|pay|transfer|archive|move|reply|forward|invite|share|publish|purchase|order|book|submit|merge|close|trash)/i;

export function loadGatePolicy(path: string, writableRoots: string[], home?: string): GatePolicy {
	let rules: Rule[] = [];
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { rules?: Rule[]; writableRoots?: string[] };
		rules = parsed.rules ?? [];
		writableRoots = [...writableRoots, ...(parsed.writableRoots ?? [])];
	}
	for (const r of rules) new RegExp(r.match, r.flags ?? "i"); // Fail at startup, not mid-call, on a bad pattern.
	// Owner rules cannot loosen the protection of vigil's own state: those rules come first.
	return { rules: [...(home ? homeRules(home) : []), ...rules, ...DEFAULT_RULES], writableRoots: writableRoots.map((r) => realOrSelf(resolve(r))) };
}

/** Resolve a tool path the way pi's write and edit tools do: `~` expands, a leading `@` is dropped. */
export function resolveLikePi(p: string, cwd: string): string {
	let path = p.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = homedir() + path.slice(1);
	return resolve(cwd, path);
}

/** Follow symlinks for the deepest part of the path that exists, so a link cannot leave a root. */
function realOrSelf(abs: string): string {
	let cur = abs;
	const rest: string[] = [];
	for (let i = 0; i < 64; i++) {
		try {
			const real = realpathSync(cur);
			return rest.length ? resolve(real, ...rest.reverse()) : real;
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return abs;
			rest.push(basename(cur));
			cur = parent;
		}
	}
	return abs;
}

/** The text a rule's regex is tested against. */
export function callText(tool: string, input: Record<string, unknown>): string {
	if (tool === "bash" && typeof input.command === "string") return input.command;
	if (typeof input.path === "string") return input.path;
	if (typeof input.file_path === "string") return input.file_path;
	return JSON.stringify(input);
}

/** Classify a call. Owner rules first, then defaults; writes outside the roots are risky. */
export function classify(policy: GatePolicy, tool: string, input: Record<string, unknown>, cwd: string): { verdict: Verdict; reason: string } {
	const text = callText(tool, input);
	for (const r of policy.rules) {
		if (r.tool !== "*" && r.tool !== tool) continue;
		if (new RegExp(r.match, r.flags ?? "i").test(text)) return { verdict: r.verdict, reason: r.reason };
	}
	const bare = tool.replace(/^.*(__|\.|\/)/, "");
	if (!BUILTIN_TOOLS.has(tool) && !VIGIL_TOOLS.test(tool) && !READ_ONLY.test(bare) && SIDE_EFFECT.test(bare)) {
		return { verdict: "risky", reason: `external tool ${tool} may change something outside vigil` };
	}
	if (tool === "write" || tool === "edit") {
		const p = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
		const abs = realOrSelf(resolveLikePi(p, cwd));
		if (!policy.writableRoots.some((root) => abs === root || abs.startsWith(`${root}/`))) {
			return { verdict: "risky", reason: `writes outside vigil's directories (${abs})` };
		}
	}
	return { verdict: "safe", reason: "" };
}

export interface GateHooks {
	approvals: Approvals;
	policy: () => GatePolicy;
	ttlMs: () => number;
	/** Who asks: "concierge" or a ticket id; shown to the owner. */
	requester: string;
	cwd: string;
	/** Send the approval request to the owner. */
	ask: (approvalId: string, text: string) => void;
	log: (text: string) => void;
}

/** The pi extension. One per session, so the requester and cwd are known. */
export function approvalGate(h: GateHooks): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", async (event, ctx) => {
			const input = event.input as Record<string, unknown>;
			const { verdict, reason } = classify(h.policy(), event.toolName, input, h.cwd);
			if (verdict === "safe") return undefined;
			if (verdict === "forbidden") {
				h.log(`blocked ${event.toolName}: ${reason}`);
				return { block: true, reason: `Blocked by vigil's policy: ${reason}. Do not try another way to do this.` };
			}
			const a = h.approvals.request(h.requester, event.toolName, input, reason, h.ttlMs());
			const shown = callText(event.toolName, input).slice(0, 700);
			h.ask(a.id, `Approve? ${h.requester} wants to run ${event.toolName} (${reason}):\n\n${shown}`);
			const outcome = await h.approvals.wait(a.id, ctx.signal);
			// Run only if this exact call's approval is consumed now: approved, same hash, not expired, not used.
			if (outcome === "approved" && h.approvals.consume(a.id, callHash(event.toolName, input))) return undefined;
			const why = outcome === "denied" ? "the owner denied it" : "no approval arrived in time";
			return { block: true, reason: `Not run: ${why}. Do not retry it in another form; report it instead.` };
		});
	};
}
