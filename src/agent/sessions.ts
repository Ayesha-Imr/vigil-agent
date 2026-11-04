// Building pi sessions for vigil's roles: the right model, tools, skills, approval gate, and a
// system prompt whose time and memory are filled in fresh on every turn.

import { mkdirSync } from "node:fs";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ModelRole } from "../config.ts";
import { localDate, localMinuteOfDay } from "../core/time.ts";
import { approvalGate } from "./gate.ts";
import { type AnyModel, key } from "./models.ts";
import type { Services } from "./services.ts";

export interface SessionSpec {
	role: ModelRole;
	cwd: string;
	/** "memory" for a throwaway session; otherwise a session directory, resumed when a file is given. */
	persistence: { kind: "memory" } | { kind: "dir"; dir: string; file?: string | null };
	/** The base system prompt; {{now}}, {{tz}}, {{memory}} and {{mode}} are filled each turn. */
	prompt: string;
	builtinTools: string[];
	customTools: ToolDefinition[];
	/** Who is asking for approvals, or null for a session with no risky tools. */
	requester: string | null;
	skills: boolean;
	model?: AnyModel;
}

export interface Built {
	session: AgentSession;
	model: AnyModel;
}

export function nowText(s: Services): string {
	const t = s.clock.now();
	const tz = s.cfg.owner.timezone;
	const m = localMinuteOfDay(t, tz);
	const weekday = new Date(t).toLocaleDateString("en-GB", { weekday: "long", timeZone: tz });
	return `${weekday} ${localDate(t, tz)} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Fill the per-turn placeholders. */
export function dynamicVars(s: Services): Record<string, string> {
	return {
		now: nowText(s),
		tz: s.cfg.owner.timezone,
		mode: s.cfg.proactive.mode,
		memory: `<memory file="${s.memory.memoryPath}">\n${s.memory.core()}\n</memory>`,
	};
}

export async function buildSession(s: Services, spec: SessionSpec): Promise<Built> {
	const model = spec.model ?? s.models.pick(spec.role);
	if (!model) {
		throw new Error(`no model with credentials for role "${spec.role}". Run \`vigil login\` (Codex) or set OPENCODE_API_KEY (OpenCode Go).`);
	}
	mkdirSync(spec.cwd, { recursive: true });

	const extensions: ExtensionFactory[] = [
		(pi) => {
			pi.on("before_agent_start", (event) => {
				const vars = dynamicVars(s);
				return { systemPrompt: event.systemPrompt.replace(/\{\{(now|tz|memory|mode)\}\}/g, (_m, k: string) => vars[k] ?? "") };
			});
		},
	];
	if (spec.requester) {
		const requester = spec.requester;
		extensions.push(
			approvalGate({
				approvals: s.approvals,
				policy: s.gatePolicy,
				ttlMs: () => s.cfg.approvals.ttlMinutes * 60_000,
				requester,
				cwd: spec.cwd,
				ask: (id, text) => {
					const route = s.ownerRoute();
					if (!route) return;
					s.outbox.enqueue({
						...route,
						text,
						buttons: [[{ data: `approve:${id}`, label: "Approve" }, { data: `deny:${id}`, label: "Deny" }]],
						ref: { kind: "approval", id },
					});
				},
				log: (text) => s.db.event("gate", `${requester}: ${text}`),
			}),
		);
	}

	const loader = new DefaultResourceLoader({
		cwd: spec.cwd,
		agentDir: s.paths.agentDir,
		systemPrompt: spec.prompt,
		additionalSkillPaths: spec.skills ? [s.skillsDir, s.paths.skills] : [],
		noSkills: !spec.skills,
		noContextFiles: spec.role !== "worker",
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: extensions,
	});
	await loader.reload();

	let sessionManager: SessionManager;
	if (spec.persistence.kind === "memory") {
		sessionManager = SessionManager.inMemory(spec.cwd);
	} else {
		mkdirSync(spec.persistence.dir, { recursive: true });
		sessionManager = spec.persistence.file
			? SessionManager.open(spec.persistence.file, spec.persistence.dir, spec.cwd)
			: SessionManager.create(spec.cwd, spec.persistence.dir);
	}

	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: true, maxRetries: 2 },
		compaction: { enabled: true },
	});

	const { session } = await createAgentSession({
		cwd: spec.cwd,
		agentDir: s.paths.agentDir,
		model,
		thinkingLevel: spec.role === "triage" ? "low" : "medium",
		modelRuntime: s.modelRuntime,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
		tools: [...spec.builtinTools, ...spec.customTools.map((t) => t.name)],
		customTools: spec.customTools,
	});
	return { session, model };
}

export interface RunResult {
	text: string;
	error?: string;
	model: string;
}

/**
 * Prompt a session and wait until pi settles; on a provider failure, fall back to the role's next
 * model and ask the session to carry on. The session history keeps the failed turn.
 */
export async function promptWithFallback(s: Services, session: AgentSession, role: ModelRole, text: string): Promise<RunResult> {
	const tried = new Set<string>();
	let input = text;
	for (let attempt = 0; attempt < 4; attempt++) {
		const model = session.model as AnyModel | undefined;
		if (model) tried.add(key(model));
		let error: string | undefined;
		try {
			await session.prompt(input);
			const last = [...session.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
				| { stopReason?: string; errorMessage?: string }
				| undefined;
			if (last?.stopReason === "error") error = last.errorMessage ?? "provider error";
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		if (!error) return { text: session.getLastAssistantText() ?? "", model: model ? key(model) : "?" };
		const verdict = model ? s.models.failed(model, error) : { fallBack: false, kind: "other" as const };
		s.db.event("model.error", `${role} ${model ? key(model) : "?"}: ${error.slice(0, 300)}`);
		const next = verdict.fallBack ? s.models.pick(role, tried) : undefined;
		if (!next || tried.has(key(next))) return { text: session.getLastAssistantText() ?? "", error, model: model ? key(model) : "?" };
		await session.setModel(next);
		s.db.event("model.fallback", `${role} → ${key(next)}`);
		input = `(The previous attempt failed with a provider error and was switched to another model. Continue the task from where it stopped.)`;
	}
	return { text: session.getLastAssistantText() ?? "", error: "too many provider failures", model: "?" };
}
