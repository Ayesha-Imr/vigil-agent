// Triage of watcher changes: a throwaway session on the cheap model with no tools that read
// private data or change anything (Rule of Two: untrusted input, no outside effects). Its single
// decision is executed by code, under the proactive accept mode.

import { createHash } from "node:crypto";
import type { Change } from "../core/watchers.ts";
import { fill, TRIAGE_PROMPT } from "./prompts.ts";
import type { Services } from "./services.ts";
import { buildSession, promptWithFallback } from "./sessions.ts";
import { type TriageDecision, triageTools } from "./tools.ts";

export async function triage(s: Services, change: Change): Promise<TriageDecision | undefined> {
	const mode = s.cfg.proactive.mode;
	const w = change.watcher;
	if (mode === "off") {
		s.db.run("UPDATE triggers SET status = 'dropped', note = 'proactive mode off', processed_at = ? WHERE id = ?", s.clock.now(), change.triggerId);
		return undefined;
	}
	let decision: TriageDecision | undefined;
	const prompt = fill(TRIAGE_PROMPT, {
		owner: s.cfg.owner.name,
		name: w.name,
		kind: w.kind,
		target: w.target,
		instruction: w.instruction,
		summary: change.summary.slice(0, 6000),
	});
	try {
		const { session } = await buildSession(s, {
			role: "triage",
			cwd: s.paths.home,
			persistence: { kind: "memory" },
			prompt,
			builtinTools: [],
			customTools: triageTools((d) => {
				decision ??= d;
			}),
			requester: null,
			skills: false,
		});
		await promptWithFallback(s, session, "triage", "Decide now with triage_decide.");
		session.dispose();
	} catch (err) {
		s.db.event("triage.error", `${w.name}: ${(err as Error).message}`);
		s.db.run("UPDATE triggers SET status = 'failed', note = ?, processed_at = ? WHERE id = ?", (err as Error).message.slice(0, 300), s.clock.now(), change.triggerId);
		return undefined;
	}
	const d = decision ?? { action: "ignore" as const, reason: "triage made no decision" };
	const note = `${d.action}: ${d.reason}`;
	s.db.run("UPDATE triggers SET status = 'done', note = ?, processed_at = ? WHERE id = ?", note.slice(0, 500), s.clock.now(), change.triggerId);

	if (mode === "observe") {
		if (d.action !== "ignore") {
			s.memory.journal("observe", `would have ${d.action} for watcher ${w.name}: ${d.text ?? d.reason}`);
			s.db.event("observe", `would ${d.action}: ${w.name}: ${(d.text ?? d.reason).slice(0, 200)}`);
		}
		return d;
	}
	if (d.action === "notify" && d.text) {
		s.notifier.notify({
			urgency: d.urgency ?? "normal",
			topic: `watch:${w.name}`,
			dedupKey: `watch:${w.id}:${createHash("sha256").update(d.text).digest("hex").slice(0, 12)}`,
			text: d.text,
		});
	} else if (d.action === "ticket" && d.text) {
		s.tickets.create({
			title: `${w.name}: ${d.text.slice(0, 60)}`,
			mandate: { request: d.text, scope: `Follow up on a change seen by watcher "${w.name}" (${w.instruction}). Investigate and report; do not take outside actions.`, strength: "inferred", rule: `watcher ${w.id}` },
			origin: { channel: "system", conversation: "" },
		});
		s.wakeWorkers();
	}
	return d;
}
