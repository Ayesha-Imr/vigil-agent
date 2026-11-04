// Watchers: cheap deterministic checks (a web page, a feed, a command's output) that wake the
// agent only when something changed. The model never runs on an unchanged check.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../store/db.ts";
import { type Clock, MINUTE } from "./time.ts";

export type WatcherKind = "url" | "feed" | "command";

export interface Watcher {
	id: string;
	name: string;
	kind: WatcherKind;
	target: string;
	every_minutes: number;
	/** What the owner wants to know, in their words: "tell me when the price drops below 40". */
	instruction: string;
	enabled: number;
	last_value: string | null;
	last_checked_at: number | null;
	last_error: string | null;
	created_at: number;
}

export interface Change {
	watcher: Watcher;
	/** A short, bounded description of what changed, for the triage prompt. */
	summary: string;
	triggerId: number;
}

const MAX_SNAPSHOT = 20_000;

export type Fetcher = (url: string) => Promise<string>;

export const defaultFetcher: Fetcher = async (url) => {
	const res = await fetch(url, { headers: { "user-agent": "vigil-watcher/0.1" }, signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.text();
};

/** Reduce HTML to visible text, so markup churn does not count as change. */
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
}

/** Pull item titles and links out of RSS or Atom without a parser dependency. */
export function feedItems(xml: string): { id: string; title: string; link: string }[] {
	const items: { id: string; title: string; link: string }[] = [];
	const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) ?? [];
	for (const b of blocks) {
		const pick = (tag: string) => {
			const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(b);
			return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
		};
		const hrefM = /<link[^>]*href="([^"]+)"/i.exec(b);
		const link = pick("link") || (hrefM ? hrefM[1] : "");
		const title = htmlToText(pick("title"));
		const id = pick("guid") || pick("id") || link || title;
		if (id) items.push({ id, title, link });
	}
	return items;
}

/** Lines added and removed between two snapshots, bounded. */
export function lineDiff(before: string, after: string, max = 40): string {
	const a = new Set(before.split("\n").map((l) => l.trim()).filter(Boolean));
	const b = new Set(after.split("\n").map((l) => l.trim()).filter(Boolean));
	const added = [...b].filter((l) => !a.has(l));
	const removed = [...a].filter((l) => !b.has(l));
	const out: string[] = [];
	for (const l of added.slice(0, max)) out.push(`+ ${l.slice(0, 300)}`);
	for (const l of removed.slice(0, Math.max(0, max - out.length))) out.push(`- ${l.slice(0, 300)}`);
	const hidden = added.length + removed.length - out.length;
	if (hidden > 0) out.push(`(${hidden} more changed lines)`);
	return out.join("\n");
}

function runCommand(cmd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("sh", ["-c", cmd], { timeout: 120_000, maxBuffer: 2_000_000 }, (err, stdout, stderr) => {
			if (err && !stdout) reject(new Error(`${err.message}\n${stderr}`.slice(0, 1000)));
			else resolve(stdout);
		});
	});
}

export class Watchers {
	private readonly db: Db;
	private readonly clock: Clock;
	private readonly fetcher: Fetcher;
	private busy = false;

	constructor(db: Db, clock: Clock, fetcher: Fetcher = defaultFetcher) {
		this.db = db;
		this.clock = clock;
		this.fetcher = fetcher;
	}

	create(input: { name: string; kind: WatcherKind; target: string; everyMinutes: number; instruction: string }): Watcher {
		const id = `w_${randomUUID().slice(0, 8)}`;
		this.db.run(
			`INSERT INTO watchers (id, name, kind, target, every_minutes, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.name,
			input.kind,
			input.target,
			Math.max(5, Math.round(input.everyMinutes)),
			input.instruction,
			this.clock.now(),
		);
		this.db.event("watcher.created", `${input.name}: ${input.kind} ${input.target}`, { id });
		return this.get(id)!;
	}

	get(id: string): Watcher | undefined {
		return this.db.get<Watcher>("SELECT * FROM watchers WHERE id = ?", id);
	}

	list(): Watcher[] {
		return this.db.all<Watcher>("SELECT * FROM watchers ORDER BY created_at");
	}

	remove(id: string): boolean {
		return this.db.run("DELETE FROM watchers WHERE id = ?", id).changes === 1;
	}

	/** Check every due watcher once; record a Trigger for each real change. */
	async checkDue(): Promise<Change[]> {
		if (this.busy) return [];
		this.busy = true;
		try {
			const now = this.clock.now();
			const due = this.db
				.all<Watcher>("SELECT * FROM watchers WHERE enabled = 1")
				.filter((w) => w.last_checked_at === null || w.last_checked_at + w.every_minutes * MINUTE <= now);
			const changes: Change[] = [];
			for (const w of due) {
				const c = await this.checkOne(w);
				if (c) changes.push(c);
			}
			return changes;
		} finally {
			this.busy = false;
		}
	}

	async checkOne(w: Watcher): Promise<Change | undefined> {
		const now = this.clock.now();
		let snapshot: string;
		try {
			snapshot = await this.snapshot(w);
		} catch (err) {
			this.db.run("UPDATE watchers SET last_checked_at = ?, last_error = ? WHERE id = ?", now, (err as Error).message.slice(0, 500), w.id);
			return undefined;
		}
		snapshot = snapshot.slice(0, MAX_SNAPSHOT);
		const first = w.last_value === null;
		const changed = !first && w.last_value !== snapshot;
		this.db.run("UPDATE watchers SET last_value = ?, last_checked_at = ?, last_error = NULL WHERE id = ?", snapshot, now, w.id);
		if (!changed) return undefined;
		const summary = this.summarize(w, w.last_value ?? "", snapshot);
		if (!summary.trim()) return undefined;
		const hash = createHash("sha256").update(snapshot).digest("hex").slice(0, 16);
		const ins = this.db.run(
			`INSERT INTO triggers (source, external_id, kind, strength, payload, created_at)
			 VALUES ('watch', ?, 'watch', 'inferred', ?, ?) ON CONFLICT(source, external_id) DO NOTHING`,
			`${w.id}:${hash}`,
			JSON.stringify({ watcherId: w.id, summary }),
			now,
		);
		if (ins.changes !== 1) return undefined;
		return { watcher: w, summary, triggerId: ins.lastInsertRowid };
	}

	private async snapshot(w: Watcher): Promise<string> {
		switch (w.kind) {
			case "url":
				return htmlToText(await this.fetcher(w.target));
			case "feed":
				return feedItems(await this.fetcher(w.target))
					.map((i) => `${i.id}\t${i.title}\t${i.link}`)
					.join("\n");
			case "command":
				return (await runCommand(w.target)).trim();
		}
	}

	private summarize(w: Watcher, before: string, after: string): string {
		if (w.kind === "feed") {
			const old = new Set(before.split("\n").map((l) => l.split("\t")[0]));
			const fresh = after
				.split("\n")
				.filter((l) => l && !old.has(l.split("\t")[0]))
				.slice(0, 15)
				.map((l) => {
					const [, title, link] = l.split("\t");
					return `new: ${title} ${link}`;
				});
			return fresh.join("\n");
		}
		return lineDiff(before, after);
	}
}
