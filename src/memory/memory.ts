// Memory as plain files: MEMORY.md (curated, injected into every prompt, size-capped), a daily
// journal (append-only), and free-form notes. Files stay readable and editable by the owner, and
// the agent can also read them with its normal file tools.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { localDate, localMinuteOfDay } from "../core/time.ts";

export const MEMORY_CAP_CHARS = 8000;

const TEMPLATE = `# Memory

What vigil knows and keeps in mind. The owner may edit this file; vigil edits it with its
memory tools and consolidates it every night.

## About the owner

## Preferences

## Ongoing

## Facts
`;

export const HEARTBEAT_TEMPLATE = `# Heartbeat checklist

On each heartbeat, vigil reads this file. Write what you want it to keep an eye on, one item per
line. Leave it empty and vigil only looks at its own open work.

`;

export class Memory {
	readonly dir: string;
	private readonly tz: () => string;
	private readonly now: () => number;

	/** `now` is vigil's clock, so journal days agree with the scheduler's (and with tests' clocks). */
	constructor(dir: string, tz: () => string, now: () => number = Date.now) {
		this.dir = dir;
		this.tz = tz;
		this.now = now;
		mkdirSync(join(dir, "journal"), { recursive: true });
		mkdirSync(join(dir, "notes"), { recursive: true });
		if (!existsSync(this.memoryPath)) writeFileSync(this.memoryPath, TEMPLATE);
		if (!existsSync(this.heartbeatPath)) writeFileSync(this.heartbeatPath, HEARTBEAT_TEMPLATE);
	}

	get memoryPath(): string {
		return join(this.dir, "MEMORY.md");
	}

	get heartbeatPath(): string {
		return join(this.dir, "HEARTBEAT.md");
	}

	/** MEMORY.md for the system prompt, cut to the cap with a note when it is too long. */
	core(): string {
		const text = readFileSync(this.memoryPath, "utf8");
		if (text.length <= MEMORY_CAP_CHARS) return text;
		return `${text.slice(0, MEMORY_CAP_CHARS)}\n\n[MEMORY.md is over ${MEMORY_CAP_CHARS} chars; the rest is cut. Consolidate it.]`;
	}

	heartbeat(): string {
		return existsSync(this.heartbeatPath) ? readFileSync(this.heartbeatPath, "utf8") : "";
	}

	/** Add a bullet under a section of MEMORY.md, unless the same line is already there. */
	remember(text: string, section = "Facts"): { added: boolean } {
		const line = `- ${text.replace(/\s+/g, " ").trim()}`;
		const content = readFileSync(this.memoryPath, "utf8");
		if (content.split("\n").some((l) => l.trim().toLowerCase() === line.toLowerCase())) return { added: false };
		const lines = content.split("\n");
		const header = `## ${section}`;
		let idx = lines.findIndex((l) => l.trim().toLowerCase() === header.toLowerCase());
		if (idx === -1) {
			if (lines[lines.length - 1] !== "") lines.push("");
			lines.push(header, "");
			idx = lines.length - 2;
		}
		// Insert after the last bullet of the section.
		let at = idx + 1;
		while (at < lines.length && !lines[at].startsWith("## ")) at++;
		while (at > idx + 1 && lines[at - 1].trim() === "") at--;
		lines.splice(at, 0, line);
		writeFileSync(this.memoryPath, lines.join("\n"));
		return { added: true };
	}

	/** Remove MEMORY.md lines containing `fragment` (case-insensitive). Returns the removed lines. */
	forget(fragment: string): string[] {
		const needle = fragment.toLowerCase().trim();
		if (!needle) return [];
		const lines = readFileSync(this.memoryPath, "utf8").split("\n");
		const removed = lines.filter((l) => l.startsWith("- ") && l.toLowerCase().includes(needle));
		writeFileSync(this.memoryPath, lines.filter((l) => !removed.includes(l)).join("\n"));
		return removed;
	}

	/** Append one entry to today's journal. */
	journal(kind: string, text: string, now = this.now()): void {
		const day = localDate(now, this.tz());
		const m = localMinuteOfDay(now, this.tz());
		const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
		const file = join(this.dir, "journal", `${day}.md`);
		if (!existsSync(file)) writeFileSync(file, `# ${day}\n\n`);
		appendFileSync(file, `- ${hhmm} [${kind}] ${text.replace(/\s+/g, " ").trim().slice(0, 1000)}\n`);
	}

	journalFor(day: string): string {
		const file = join(this.dir, "journal", `${day}.md`);
		return existsSync(file) ? readFileSync(file, "utf8") : "";
	}

	/** Search every memory file. Scores paragraphs by query-term overlap; returns the best hits. */
	search(query: string, limit = 8): { file: string; line: number; text: string; score: number }[] {
		const terms = tokenize(query);
		if (!terms.length) return [];
		const hits: { file: string; line: number; text: string; score: number }[] = [];
		for (const file of walk(this.dir)) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (let i = 0; i < lines.length; i++) {
				const window = lines.slice(i, i + 3).join(" ");
				const words = tokenize(lines[i]);
				if (!words.length || lines[i].startsWith("#")) continue;
				const set = new Set(tokenize(window));
				const matched = terms.filter((t) => set.has(t)).length;
				if (!matched) continue;
				const exact = window.toLowerCase().includes(query.toLowerCase()) ? 2 : 0;
				const recency = file.includes("journal") ? 0 : 0.5;
				hits.push({ file: relative(this.dir, file), line: i + 1, text: lines[i].slice(0, 400), score: matched / terms.length + exact + recency });
			}
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}
}

const STOP = new Set("a an and are as at be by for from has have i in is it me my of on or so that the this to was we what when where who will with you your".split(" "));

function tokenize(s: string): string[] {
	return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".")) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p));
		else if (name.endsWith(".md")) out.push(p);
	}
	return out;
}
