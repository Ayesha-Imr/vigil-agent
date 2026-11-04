// Wall-clock helpers: an injectable clock and owner-local time of day.

export interface Clock {
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock tests move by hand. */
export class ManualClock implements Clock {
	t: number;
	constructor(t = Date.UTC(2026, 0, 5, 12, 0, 0)) {
		this.t = t;
	}
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hourCycle: "h23",
		});
		formatters.set(tz, f);
	}
	return f;
}

/** Minutes since local midnight in `tz` (0..1439). */
export function localMinuteOfDay(t: number, tz: string): number {
	const parts = formatter(tz).formatToParts(new Date(t));
	const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
	const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
	return h * 60 + m;
}

/** Local calendar date `YYYY-MM-DD` in `tz`. */
export function localDate(t: number, tz: string): string {
	const parts = formatter(tz).formatToParts(new Date(t));
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
	return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Parse "HH:MM" into minutes since midnight. */
export function parseHHMM(s: string): number {
	const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
	if (!m) throw new Error(`invalid time of day "${s}", expected HH:MM`);
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) throw new Error(`invalid time of day "${s}"`);
	return h * 60 + min;
}

/** Whether minute-of-day `m` lies in the window [start, end), which may wrap past midnight. */
export function inWindow(m: number, start: number, end: number): boolean {
	if (start === end) return false;
	return start < end ? m >= start && m < end : m >= start || m < end;
}
