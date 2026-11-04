// The attention governor: decides whether a notification may interrupt the owner now, waits for a
// digest, or is dropped. Pure functions over plain state, so the TLA+ model in
// verification/governor maps onto it step for step and property tests can drive it.

import { DAY, inWindow, localMinuteOfDay, MINUTE, parseHHMM } from "./time.ts";

export type Urgency = "critical" | "high" | "normal" | "low";

export const URGENCY_RANK: Record<Urgency, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export interface GovernorPolicy {
	/** IANA time zone of the owner, for quiet hours and digest times. */
	timezone: string;
	/** Local quiet window, may wrap past midnight. Null for none. */
	quietHours: { start: string; end: string } | null;
	/** Local times at which waiting notices go out as one digest. */
	digestTimes: string[];
	/** Interrupts of urgency high/normal allowed in any rolling 24 hours. */
	maxInterruptsPerDay: number;
	/** Minimum minutes between two high/normal interrupts. */
	minGapMinutes: number;
	/** Critical deliveries allowed in any rolling 24 hours; more are treated as high. */
	criticalPerDay: number;
	/** A notice whose dedup key was seen within this many minutes is dropped. */
	dedupWindowMinutes: number;
	/** A waiting notice expires this many hours after it was offered, unless it sets its own expiry. */
	defaultExpiryHours: number;
	/** Send digests without sound or vibration: they are the batch that can wait (default true). */
	silentDigests?: boolean;
}

export const DEFAULT_POLICY: GovernorPolicy = {
	timezone: "UTC",
	quietHours: { start: "22:30", end: "08:00" },
	digestTimes: ["09:00", "18:00"],
	maxInterruptsPerDay: 3,
	minGapMinutes: 60,
	criticalPerDay: 3,
	dedupWindowMinutes: 12 * 60,
	defaultExpiryHours: 36,
};

export interface NoticeInput {
	id: string;
	urgency: Urgency;
	topic: string;
	/** Notices with the same key are the same news. Defaults to topic + text. */
	dedupKey?: string;
	text: string;
	/** Absolute ms epoch; waiting past this the notice expires. */
	expiresAt?: number;
	ticketId?: string;
}

/**
 * Where a notice is. `queued` and `held` wait; `claimed` is shown to a reply that is being written
 * (ticks, mutes and expiry leave it alone until the reply is stored or abandoned); the rest are final.
 */
export type NoticeStatus = "queued" | "held" | "claimed" | "delivered" | "digested" | "dropped" | "expired";

export type Decision = "deliver" | "hold" | "digest" | "drop:duplicate" | "drop:muted";

export interface Notice {
	id: string;
	urgency: Urgency;
	/** Urgency after feedback penalties and the critical cap. */
	effective: Urgency;
	topic: string;
	dedupKey: string;
	text: string;
	ticketId?: string;
	createdAt: number;
	expiresAt: number;
	status: NoticeStatus;
	decision: Decision;
	resolvedAt?: number;
	/** The waiting status a claimed notice returns to if its reply is abandoned. */
	claimedFrom?: "queued" | "held";
}

export interface GovernorState {
	notices: Notice[];
	/** Delivery times of individual high/normal interrupts. */
	interrupts: number[];
	/** Delivery times of critical notices. */
	criticals: number[];
	/** topic -> muted until (ms epoch). */
	mutes: Record<string, number>;
	/** topic -> urgency lowered one step until (ms epoch). */
	penalties: Record<string, number>;
	/** The last time tick() ran; digest and quiet-end crossings are measured from it. */
	lastTickAt: number;
}

export function initialState(now: number): GovernorState {
	return { notices: [], interrupts: [], criticals: [], mutes: {}, penalties: {}, lastTickAt: now };
}

const HISTORY_MS = 7 * DAY;

export function isWaiting(n: Notice): boolean {
	return n.status === "queued" || n.status === "held";
}

/** Whether `t` falls in the owner's quiet hours. */
export function isQuiet(t: number, policy: GovernorPolicy): boolean {
	if (!policy.quietHours) return false;
	const m = localMinuteOfDay(t, policy.timezone);
	return inWindow(m, parseHHMM(policy.quietHours.start), parseHHMM(policy.quietHours.end));
}

function within24h(times: number[], now: number): number {
	return times.filter((t) => t > now - DAY).length;
}

function lower(u: Urgency): Urgency {
	return u === "high" ? "normal" : u === "normal" ? "low" : u;
}

export interface OfferResult {
	state: GovernorState;
	notice: Notice;
	/** Set when the notice must be sent now, on its own. */
	deliverNow: boolean;
}

/** Decide what happens to a new notice. */
export function offer(state: GovernorState, input: NoticeInput, now: number, policy: GovernorPolicy): OfferResult {
	const dedupKey = input.dedupKey ?? `${input.topic}::${input.text.trim().toLowerCase()}`;
	const base: Omit<Notice, "status" | "decision" | "effective"> = {
		id: input.id,
		urgency: input.urgency,
		topic: input.topic,
		dedupKey,
		text: input.text,
		ticketId: input.ticketId,
		createdAt: now,
		expiresAt: input.expiresAt ?? now + policy.defaultExpiryHours * 60 * MINUTE,
	};
	const finish = (
		effective: Urgency,
		status: NoticeStatus,
		decision: Decision,
		patch: Partial<GovernorState> = {},
	): OfferResult => {
		const resolved = status !== "queued" && status !== "held";
		const notice: Notice = { ...base, effective, status, decision, resolvedAt: resolved ? now : undefined };
		return {
			state: { ...state, ...patch, notices: [...state.notices, notice] },
			notice,
			deliverNow: status === "delivered",
		};
	};

	// 1. Muted topics: the owner's explicit word wins over every urgency.
	const mutedUntil = state.mutes[input.topic];
	if (mutedUntil !== undefined && mutedUntil > now) return finish(input.urgency, "dropped", "drop:muted");

	// 2. Duplicates of news already delivered or waiting.
	const windowStart = now - policy.dedupWindowMinutes * MINUTE;
	const dup = state.notices.some(
		(n) => n.dedupKey === dedupKey && n.createdAt > windowStart && n.status !== "dropped" && n.status !== "expired",
	);
	if (dup) return finish(input.urgency, "dropped", "drop:duplicate");

	let effective = input.urgency;
	const penaltyUntil = state.penalties[input.topic];
	if (effective !== "critical" && penaltyUntil !== undefined && penaltyUntil > now) effective = lower(effective);

	// 3. Critical: ignores quiet hours and the interrupt budget, within its own cap.
	if (effective === "critical") {
		if (within24h(state.criticals, now) < policy.criticalPerDay) {
			return finish("critical", "delivered", "deliver", { criticals: [...state.criticals, now] });
		}
		effective = "high";
	}

	// 4. Low urgency always waits for a digest.
	if (effective === "low") return finish(effective, "queued", "digest");

	// 5. Quiet hours hold everything else.
	if (isQuiet(now, policy)) return finish(effective, "held", "hold");

	// 6. Interrupt budget and spacing.
	const last = state.interrupts.length ? Math.max(...state.interrupts) : Number.NEGATIVE_INFINITY;
	const withinBudget = within24h(state.interrupts, now) < policy.maxInterruptsPerDay;
	const spaced = now - last >= policy.minGapMinutes * MINUTE;
	if (withinBudget && spaced) {
		return finish(effective, "delivered", "deliver", { interrupts: [...state.interrupts, now] });
	}

	// 7. Over budget: wait for the digest.
	return finish(effective, "queued", "digest");
}

export interface TickResult {
	state: GovernorState;
	/** Notices to send now as one digest message, most urgent first. Empty when no digest is due. */
	digest: Notice[];
	expired: Notice[];
}

/**
 * Whether the owner's local clock passed time of day `target` in (from, to]. Walks the minutes
 * between the instants (at most a day; ticks are close together) and looks at each step of the
 * local clock: a normal step moves one minute, a spring-forward step jumps ahead (the skipped
 * minutes count as passed, so a target inside the gap fires once), and a fall-back step jumps
 * back (the repeated hour does not fire a second time).
 */
/** Whether local minute `m` at UTC minute `k` already happened within the last three hours (fall-back). */
function repeatedHour(k: number, m: number, tz: string): boolean {
	for (let d = 15; d <= 180; d += 15) if (localMinuteOfDay((k - d) * MINUTE, tz) === m) return true;
	return false;
}

export function crossed(from: number, to: number, target: number, tz: string): boolean {
	const a = Math.floor(from / MINUTE);
	const b = Math.floor(to / MINUTE);
	const startK = Math.max(a + 1, b - 1440);
	let prev = localMinuteOfDay((startK - 1) * MINUTE, tz);
	for (let k = startK; k <= b; k++) {
		const cur = localMinuteOfDay(k * MINUTE, tz);
		const step = (cur - prev + 1440) % 1440;
		if (step > 0 && step <= 180) {
			const offset = (target - prev + 1440) % 1440;
			if (offset > 0 && offset <= step && !repeatedHour(k, cur, tz)) return true;
		}
		prev = cur;
	}
	return false;
}

/** Advance time: expire stale notices and flush a digest when one is due. */
export function tick(state: GovernorState, now: number, policy: GovernorPolicy): TickResult {
	const expired: Notice[] = [];
	let notices = state.notices.map((n) => {
		if (isWaiting(n) && n.expiresAt <= now) {
			const e: Notice = { ...n, status: "expired", resolvedAt: now };
			expired.push(e);
			return e;
		}
		return n;
	});

	const quiet = isQuiet(now, policy);
	const digestDue =
		!quiet && policy.digestTimes.some((d) => crossed(state.lastTickAt, now, parseHHMM(d), policy.timezone));
	const quietEnded =
		!quiet &&
		policy.quietHours !== null &&
		crossed(state.lastTickAt, now, parseHHMM(policy.quietHours.end), policy.timezone) &&
		notices.some((n) => n.status === "held");

	let digest: Notice[] = [];
	if (digestDue || quietEnded) {
		const out = flush(notices, now);
		notices = out.notices;
		digest = out.flushed;
	}

	// Waiting and claimed notices are never pruned: a claim must end in told or released.
	notices = notices.filter((n) => isWaiting(n) || n.status === "claimed" || n.createdAt > now - HISTORY_MS);
	const interrupts = state.interrupts.filter((t) => t > now - DAY);
	const criticals = state.criticals.filter((t) => t > now - DAY);
	const mutes = Object.fromEntries(Object.entries(state.mutes).filter(([, until]) => until > now));
	const penalties = Object.fromEntries(Object.entries(state.penalties).filter(([, until]) => until > now));
	return {
		state: { notices, interrupts, criticals, mutes, penalties, lastTickAt: now },
		digest,
		expired,
	};
}

function flush(notices: Notice[], now: number): { notices: Notice[]; flushed: Notice[] } {
	const flushed: Notice[] = [];
	const next = notices.map((n) => {
		if (!isWaiting(n)) return n;
		const d: Notice = { ...n, status: "digested", resolvedAt: now };
		flushed.push(d);
		return d;
	});
	flushed.sort((a, b) => URGENCY_RANK[b.effective] - URGENCY_RANK[a.effective] || a.createdAt - b.createdAt);
	return { notices: next, flushed };
}

/**
 * The owner wrote to vigil: hand the waiting notices to the reply, since the owner is looking
 * anyway. This is a solicited delivery, so quiet hours and the budget do not apply.
 */
export function takeForReply(state: GovernorState, now: number): { state: GovernorState; notices: Notice[] } {
	// Expire first: a notice past its expiry must not be shown just because no tick ran yet.
	const fresh = state.notices.map((n) => (isWaiting(n) && n.expiresAt <= now ? { ...n, status: "expired" as const, resolvedAt: now } : n));
	const out = flush(fresh, now);
	return { state: { ...state, notices: out.notices }, notices: out.flushed };
}

/**
 * Claim the waiting, unexpired notices for a reply that is about to be written. A claimed notice is
 * left alone by ticks, digests, mutes and expiry, so it cannot also go out in a digest while the
 * model is thinking (verification/governor, finding ConciergeToldTwice).
 */
export function claim(state: GovernorState, now: number): { state: GovernorState; notices: Notice[] } {
	const claimed: Notice[] = [];
	const notices = state.notices.map((n) => {
		if (!isWaiting(n) || n.expiresAt <= now) return n;
		const c: Notice = { ...n, status: "claimed", claimedFrom: n.status as "queued" | "held" };
		claimed.push(c);
		return c;
	});
	return { state: { ...state, notices }, notices: claimed };
}

/** The reply that showed these claimed notices was stored: they count as told. */
export function markDelivered(state: GovernorState, ids: readonly string[], now: number): { state: GovernorState; notices: Notice[] } {
	const want = new Set(ids);
	const done: Notice[] = [];
	const notices = state.notices.map((n) => {
		if (!want.has(n.id) || (n.status !== "claimed" && !isWaiting(n))) return n;
		const d: Notice = { ...n, status: "digested", resolvedAt: now, claimedFrom: undefined };
		done.push(d);
		return d;
	});
	return { state: { ...state, notices }, notices: done };
}

/**
 * No reply was stored: claimed notices wait again, as they were, unless their topic was muted
 * meanwhile, in which case they are dropped as the mute would have dropped them.
 */
export function release(state: GovernorState, ids?: readonly string[], now = Date.now()): GovernorState {
	const want = ids ? new Set(ids) : undefined;
	return {
		...state,
		notices: state.notices.map((n) => {
			if (n.status !== "claimed" || (want && !want.has(n.id))) return n;
			const muted = (state.mutes[n.topic] ?? 0) > now;
			return muted
				? { ...n, status: "dropped", decision: "drop:muted", resolvedAt: now, claimedFrom: undefined }
				: { ...n, status: n.claimedFrom ?? "queued", claimedFrom: undefined };
		}),
	};
}

/** Peek at what waits, without changing anything. */
export function waiting(state: GovernorState): Notice[] {
	return state.notices.filter(isWaiting);
}

/** Mute a topic until `until`; waiting notices on it are dropped. */
export function mute(state: GovernorState, topic: string, until: number, now: number): GovernorState {
	return {
		...state,
		mutes: { ...state.mutes, [topic]: until },
		notices: state.notices.map((n) =>
			isWaiting(n) && n.topic === topic ? { ...n, status: "dropped", decision: "drop:muted", resolvedAt: now } : n,
		),
	};
}

export function unmute(state: GovernorState, topic: string): GovernorState {
	const mutes = { ...state.mutes };
	delete mutes[topic];
	return { ...state, mutes };
}

/** The owner disliked a notice on this topic: lower the topic's urgency one step until `until`. */
export function penalize(state: GovernorState, topic: string, until: number): GovernorState {
	return { ...state, penalties: { ...state.penalties, [topic]: until } };
}

export interface BudgetView {
	interruptsUsed: number;
	interruptsMax: number;
	criticalsUsed: number;
	criticalsMax: number;
	quietNow: boolean;
	waiting: number;
	nextInterruptAt: number | null;
}

export function budget(state: GovernorState, now: number, policy: GovernorPolicy): BudgetView {
	const used = within24h(state.interrupts, now);
	const last = state.interrupts.length ? Math.max(...state.interrupts) : null;
	return {
		interruptsUsed: used,
		interruptsMax: policy.maxInterruptsPerDay,
		criticalsUsed: within24h(state.criticals, now),
		criticalsMax: policy.criticalPerDay,
		quietNow: isQuiet(now, policy),
		waiting: waiting(state).length,
		nextInterruptAt: last === null ? null : last + policy.minGapMinutes * MINUTE,
	};
}

/** Render a digest as one message. */
export function renderDigest(notices: Notice[]): string {
	if (notices.length === 1) return notices[0].text;
	const lines = [`Since the last digest (${notices.length}):`];
	for (const n of notices) {
		const mark = n.effective === "high" || n.effective === "critical" ? "!" : "-";
		lines.push(`${mark} ${n.text}`);
	}
	return lines.join("\n");
}
