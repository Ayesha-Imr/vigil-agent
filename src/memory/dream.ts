// "Dreaming": consolidate memory against the record of what happened since the last time. The
// design follows Anthropic's notes on agent memory: the journal is the ground truth, MEMORY.md is
// a small injected index over linked notes, facts are dated, conflicts are kept rather than
// silently resolved, and every run is checked afterwards and can be undone.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DREAM_PROMPT, fill } from "../agent/prompts.ts";
import type { Services } from "../agent/services.ts";
import { buildSession, promptWithFallback } from "../agent/sessions.ts";
import { DAY, localDate } from "../core/time.ts";
import { scrubSecrets } from "../store/db.ts";
import { MEMORY_CAP_CHARS } from "./memory.ts";

export const DREAM_KEY = "dream.last";
/** A consolidation that would leave less than this share of memory is undone. */
export const SHRINK_LIMIT = 0.6;
/** Below this many characters, shrinking is normal tidying and not checked. */
const SHRINK_FLOOR = 2_000;
const JOURNAL_CAP = 30_000;

export interface DreamCounts {
	added?: number;
	updated?: number;
	merged?: number;
	moved?: number;
	conflicts?: number;
	removed?: number;
}

export interface DreamReport {
	at: number;
	status: "done" | "skipped" | "reverted" | "error";
	summary: string;
	/** When the last consolidation that counted ended: the next one starts from here. */
	coveredUntil?: number;
	entries?: number;
	counts?: DreamCounts;
	redacted?: number;
	sizeBefore?: number;
	sizeAfter?: number;
}

export function git(dir: string, args: string[]): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile("git", ["-C", dir, "-c", "user.name=vigil", "-c", "user.email=vigil@localhost", ...args], { timeout: 30_000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") }));
	});
}

/** Put MEMORY.md and the notes back as they are at `rev`. Paths are restored one by one: an
 * empty notes folder is not tracked, and one missing path must not stop the other. */
async function restore(dir: string, rev: string): Promise<void> {
	await git(dir, ["checkout", rev, "--", "MEMORY.md"]);
	await git(dir, ["checkout", rev, "--", "notes"]);
}

async function commit(dir: string, message: string): Promise<void> {
	if (!existsSync(join(dir, ".git"))) await git(dir, ["init", "-q"]);
	await git(dir, ["add", "-A"]);
	await git(dir, ["commit", "-qm", message]);
}

export function lastDream(s: Services): DreamReport | undefined {
	return s.db.getKv<DreamReport>(DREAM_KEY);
}

function record(s: Services, r: DreamReport): DreamReport {
	const prev = lastDream(s);
	s.db.setKv(DREAM_KEY, { ...r, coveredUntil: r.coveredUntil ?? prev?.coveredUntil });
	s.db.event("dream", `${r.status}: ${r.summary}`);
	return r;
}

/** Remove secrets the model wrote despite the rule; returns how many files changed. */
function redact(s: Services): number {
	let n = 0;
	const files = [s.memory.memoryPath, ...s.memory.noteFiles().map((f) => join(s.memory.dir, "notes", f))];
	for (const f of files) {
		const before = readFileSync(f, "utf8");
		const after = scrubSecrets(before);
		if (after !== before) {
			writeFileSync(f, after);
			n++;
		}
	}
	return n;
}

/** Run one consolidation. Returns the report it stored. */
export async function runDream(s: Services): Promise<DreamReport> {
	const now = s.clock.now();
	const dir = s.memory.dir;
	const prev = lastDream(s);
	// The first run looks back two days, like the old nightly job; later runs start where the last ended.
	const since = prev?.coveredUntil ?? now - 2 * DAY;
	const entries = s.memory.journalSince(since, now);
	if (!entries.length) {
		return record(s, { at: now, status: "skipped", summary: "nothing new since the last consolidation" });
	}
	// Commit first: the owner's own edits and remember() calls are kept apart from the dream's.
	await commit(dir, "before dream");
	const sizeBefore = s.memory.size();
	let journals = entries.join("\n");
	if (journals.length > JOURNAL_CAP) journals = `[older entries cut]\n${journals.slice(-JOURNAL_CAP)}`;
	const tz = s.cfg.owner.timezone;
	let text = "";
	let error: string | undefined;
	try {
		const { session } = await buildSession(s, {
			role: "dream",
			cwd: dir,
			persistence: { kind: "memory" },
			prompt: fill(DREAM_PROMPT, {
				owner: s.cfg.owner.name,
				dir,
				cap: String(Math.round(MEMORY_CAP_CHARS * 0.75)),
				since: new Date(since).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }),
				memory: readFileSync(s.memory.memoryPath, "utf8"),
				notes: s.memory.notesIndex() || "(none yet)",
				journals,
			}),
			builtinTools: ["read", "write", "edit", "ls", "grep", "find"],
			customTools: [],
			requester: "dream",
			skills: false,
		});
		const r = await promptWithFallback(s, session, "dream", "Consolidate now.");
		session.dispose();
		text = r.text;
		error = r.error;
	} catch (err) {
		error = (err as Error).message;
	}
	if (error && !text) {
		await restore(dir, "HEAD");
		return record(s, { at: now, status: "error", summary: error.slice(0, 200) });
	}

	const redacted = redact(s);
	const sizeAfter = s.memory.size();
	if (sizeBefore > SHRINK_FLOOR && sizeAfter < sizeBefore * SHRINK_LIMIT) {
		// Consolidation reorganizes; it should not lose this much. Put the files back as they were.
		await restore(dir, "HEAD");
		const pct = Math.round((1 - sizeAfter / sizeBefore) * 100);
		s.notifier.notify({ urgency: "low", topic: "vigil:memory", text: `Memory consolidation was undone: it would have removed ${pct}% of what vigil remembers. Nothing was lost.` });
		return record(s, { at: now, status: "reverted", summary: `would have removed ${pct}% of memory; kept the previous version`, entries: entries.length, sizeBefore, sizeAfter });
	}

	const summary = (/^SUMMARY:\s*(.+)$/m.exec(text)?.[1] ?? text.split("\n")[0] ?? "").trim().slice(0, 200) || "consolidated";
	let counts: DreamCounts | undefined;
	try {
		const raw = /^REPORT:\s*(\{.*\})\s*$/m.exec(text)?.[1];
		if (raw) counts = JSON.parse(raw) as DreamCounts;
	} catch {
		counts = undefined;
	}
	const today = localDate(now, tz);
	await commit(dir, `dream ${today}: ${summary.slice(0, 72)}`);
	// A repeated request becomes one low-urgency offer to automate it, waiting for the digest.
	const suggestion = /^SUGGEST:\s*(.+)$/m.exec(text)?.[1]?.trim();
	if (suggestion) s.notifier.notify({ urgency: "low", topic: "vigil:suggestion", text: `💡 ${suggestion}`, dedupKey: `suggest:${today}` });
	return record(s, { at: now, status: "done", summary, coveredUntil: now, entries: entries.length, counts, redacted, sizeBefore, sizeAfter });
}

/** Undo the last consolidation's changes to MEMORY.md and the notes. Journals are untouched. */
export async function undoDream(s: Services): Promise<string> {
	const dir = s.memory.dir;
	const head = await git(dir, ["log", "-1", "--format=%s"]);
	if (!head.ok || !head.out.startsWith("dream ")) return "The last change to memory was not a consolidation, so there is nothing to undo.";
	const added = await git(dir, ["diff", "--name-only", "--diff-filter=A", "HEAD~1", "HEAD", "--", "notes"]);
	await restore(dir, "HEAD~1");
	for (const f of added.out.split("\n").filter(Boolean)) rmSync(join(dir, f), { force: true });
	await commit(dir, "undo dream");
	s.db.event("dream", "undone by the owner");
	return "Undone: MEMORY.md and the notes are back as they were before the last consolidation.";
}

/** One paragraph for /dream and the concierge's tool. */
export function dreamStatus(s: Services, scheduleLabel: string | undefined, nextRunAt: number | null | undefined): string {
	const tz = s.cfg.owner.timezone;
	const when = (t: number) => new Date(t).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
	const lines = [scheduleLabel ? `Memory consolidation runs ${scheduleLabel}${nextRunAt ? `; next ${when(nextRunAt)}` : ""}.` : "Memory consolidation is off."];
	const last = lastDream(s);
	if (last) {
		const c = last.counts;
		const nums = c ? ` (${["added", "updated", "merged", "moved", "conflicts", "removed"].map((k) => `${c[k as keyof DreamCounts] ?? 0} ${k}`).join(", ")})` : "";
		lines.push(`Last run ${when(last.at)}: ${last.status}, ${last.summary}${nums}.${last.redacted ? ` Removed secrets from ${last.redacted} file(s).` : ""}`);
	}
	lines.push(`MEMORY.md is ${readFileSync(s.memory.memoryPath, "utf8").length} of ${MEMORY_CAP_CHARS} characters; ${s.memory.noteFiles().length} notes.`);
	return lines.join("\n");
}
