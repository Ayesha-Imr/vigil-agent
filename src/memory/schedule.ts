// When the memory "dream" runs. The owner sets it in config (proactive.dreamAt), with /dream, or
// by asking the concierge. One small grammar for all three, so they always agree.

import { Cron } from "croner";

export interface DreamSchedule {
	kind: "cron" | "every";
	spec: string;
	/** How to say it back to the owner. */
	label: string;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Consolidating more often than this costs model calls for little new to consolidate. */
export const MIN_DREAM_MINUTES = 60;

function hhmm(text: string): [number, number] | undefined {
	const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
	if (!m) return undefined;
	let h = Number(m[1]);
	const min = m[2] ? Number(m[2]) : 0;
	const ampm = m[3]?.toLowerCase();
	if (ampm === "pm" && h < 12) h += 12;
	if (ampm === "am" && h === 12) h = 0;
	if (h > 23 || min > 59 || (!m[2] && !ampm)) return undefined;
	return [h, min];
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Parse a dream schedule. Accepted:
 * - `off` / `never` / `null` → null (no dream)
 * - `04:00`, `daily 4:30`, `nightly 3am` → every day at that time
 * - `every 6h`, `every 90m`, `every 2 hours` → every N (at least an hour)
 * - `weekly sun 03:00`, `weekly mon,thu 22:00` → those days at that time
 * - any 5-field cron expression, e.g. `0 3 * * 1-5`
 * Throws with a readable message when the text fits none of these.
 */
export function parseDreamSchedule(input: string | null | undefined): DreamSchedule | null {
	if (input === null || input === undefined) return null;
	const text = input.trim().toLowerCase().replace(/\s+/g, " ");
	if (["", "off", "never", "none", "null", "disable", "disabled"].includes(text)) return null;

	const daily = /^(?:daily |nightly |every day at |at )?(.+)$/.exec(text)?.[1] ?? text;
	const t = hhmm(daily);
	if (t) return { kind: "cron", spec: `${t[1]} ${t[0]} * * *`, label: `every day at ${pad(t[0])}:${pad(t[1])}` };

	const every = /^every (\d+(?:\.\d+)?) ?(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/.exec(text);
	if (every) {
		const n = Number(every[1]);
		const minutes = Math.round(every[2].startsWith("h") ? n * 60 : n);
		if (minutes < MIN_DREAM_MINUTES) throw new Error(`dreaming more often than every ${MIN_DREAM_MINUTES} minutes is not allowed`);
		const label = minutes % 60 === 0 ? `every ${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `every ${minutes} minutes`;
		return { kind: "every", spec: String(minutes), label };
	}

	const weekly = /^weekly ([a-z,]+) (.+)$/.exec(text);
	if (weekly) {
		const days = weekly[1].split(",").map((d) => DAYS.indexOf(d.slice(0, 3)));
		const wt = hhmm(weekly[2]);
		if (days.some((d) => d < 0) || !wt) throw new Error(`could not read "${input}": write it like "weekly sun 03:00"`);
		const names = days.map((d) => DAYS[d]).join(", ");
		return { kind: "cron", spec: `${wt[1]} ${wt[0]} * * ${days.join(",")}`, label: `weekly on ${names} at ${pad(wt[0])}:${pad(wt[1])}` };
	}

	if (/^[\d*/,-]+( [\d*/,a-z-]+){4}$/.test(text)) {
		let gap = Number.POSITIVE_INFINITY;
		try {
			const c = new Cron(text, { paused: true });
			const a = c.nextRun();
			const b = a ? c.nextRun(a) : null;
			if (a && b) gap = b.getTime() - a.getTime();
		} catch (err) {
			throw new Error(`"${input}" is not a valid cron expression: ${(err as Error).message}`);
		}
		if (gap < MIN_DREAM_MINUTES * 60_000) throw new Error(`dreaming more often than every ${MIN_DREAM_MINUTES} minutes is not allowed`);
		return { kind: "cron", spec: text, label: `on the cron schedule "${text}"` };
	}

	throw new Error(`could not read "${input}". Try "04:00", "every 12h", "weekly sun 03:00", a cron expression, or "off".`);
}
