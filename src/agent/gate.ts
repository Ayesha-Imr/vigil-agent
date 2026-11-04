// The approval gate: a pi extension that classifies every tool call by data-driven rules and
// holds risky calls until the owner approves that exact call. Forbidden calls never run.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
}

export interface GatePolicy {
	rules: Rule[];
	/** Directories write/edit may touch without approval. */
	writableRoots: string[];
}

/** Rules every install starts with. The owner adds more in policy.json; theirs are checked first. */
export const DEFAULT_RULES: Rule[] = [
	{ tool: "*", match: String.raw`(^|/)auth\.json\b|\.ssh/|id_(rsa|ed25519)\b|\.gnupg/`, verdict: "forbidden", reason: "touches credentials" },
	{ tool: "*", match: String.raw`vigil\.db\b`, verdict: "forbidden", reason: "touches vigil's own database" },
	{ tool: "bash", match: String.raw`\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*(rf|fr)[a-zA-Z]*\b|\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f`, verdict: "risky", reason: "recursive forced delete" },
	{ tool: "bash", match: String.raw`\bsudo\b|\bsu\s+-|\bdoas\b`, verdict: "risky", reason: "runs as another user" },
	{ tool: "bash", match: String.raw`\bgit\s+push\b`, verdict: "risky", reason: "pushes to a remote" },
	{ tool: "bash", match: String.raw`\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b`, verdict: "risky", reason: "discards git work" },
	{ tool: "bash", match: String.raw`(curl|wget)[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b`, verdict: "risky", reason: "pipes a download into a shell" },
	{ tool: "bash", match: String.raw`\b(mkfs|fdisk|shutdown|reboot|halt|poweroff)\b|\bdd\s+if=|\bsystemctl\s+(stop|disable|mask)\b|\bkill\s+-9\s+1\b`, verdict: "risky", reason: "changes the system" },
	{ tool: "bash", match: String.raw`\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+(repo\s+(delete|create)|release\s+create|pr\s+merge|secret)\b|\bdocker\s+push\b`, verdict: "risky", reason: "publishes or changes something outside" },
	{ tool: "bash", match: String.raw`\bcrontab\s+-r\b|>\s*/etc/|\bchmod\s+-R\s+777\b`, verdict: "risky", reason: "changes system configuration" },
	{ tool: "bash", match: String.raw`\b(sendmail|mail|mutt)\b.*@|\bssh\s+\S+@`, verdict: "risky", reason: "contacts another host or person" },
];

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "tool_search"]);
const VIGIL_TOOLS = /^(notify|remember|recall|forget|spawn_ticket|ticket_\w+|schedule_job|list_jobs|cancel_job|add_watcher|list_watchers|remove_watcher|mute_topic|unmute_topic|report|ask_owner|triage_decide)$/;
/** MCP and other external tools whose names suggest a side effect outside vigil. */
const SIDE_EFFECT = /(send|create|delete|remove|update|post|write|cancel|pay|transfer|archive|move|reply|forward|invite|share|publish|purchase|order|book|submit|merge|close|trash)/i;

export function loadGatePolicy(path: string, writableRoots: string[]): GatePolicy {
	let rules: Rule[] = [];
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { rules?: Rule[]; writableRoots?: string[] };
		rules = parsed.rules ?? [];
		writableRoots = [...writableRoots, ...(parsed.writableRoots ?? [])];
	}
	for (const r of rules) new RegExp(r.match); // Fail at startup, not mid-call, on a bad pattern.
	return { rules: [...rules, ...DEFAULT_RULES], writableRoots: writableRoots.map((r) => resolve(r)) };
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
		if (new RegExp(r.match, "i").test(text)) return { verdict: r.verdict, reason: r.reason };
	}
	if (!BUILTIN_TOOLS.has(tool) && !VIGIL_TOOLS.test(tool) && SIDE_EFFECT.test(tool)) {
		return { verdict: "risky", reason: `external tool ${tool} may change something outside vigil` };
	}
	if (tool === "write" || tool === "edit") {
		const p = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
		const abs = resolve(cwd, p);
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
