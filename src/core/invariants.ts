// Runtime guards: the governor's model-checked invariants, checked again against the recorded
// delivery history right before a send. A violation means a bug in the governor or its wiring;
// the send is refused and the violation is logged, so a regression costs a log line, not a 3 a.m. buzz.

import type { Db } from "../store/db.ts";
import { type GovernorPolicy, isQuiet, type Notice } from "./governor.ts";
import { DAY, MINUTE } from "./time.ts";

export interface Violation {
	rule: "Budget" | "MinGap" | "CriticalCap" | "Quiet" | "NoMuted";
	detail: string;
}

/** Check one about-to-be-sent notice. `mutes` is the governor's current mute map. */
export function checkSend(db: Db, n: Notice, now: number, policy: GovernorPolicy, mutes: Record<string, number>, digest: boolean): Violation | undefined {
	const mutedUntil = mutes[n.topic];
	if (mutedUntil !== undefined && mutedUntil > now) return { rule: "NoMuted", detail: `topic ${n.topic} is muted` };
	if (digest) {
		return isQuiet(now, policy) ? { rule: "Quiet", detail: "digest during quiet hours" } : undefined;
	}
	if (n.effective === "critical") {
		const c = db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM notices WHERE decision = 'deliver' AND effective = 'critical' AND resolved_at > ? AND id != ?",
			now - DAY,
			n.id,
		)?.n ?? 0;
		return c >= policy.criticalPerDay ? { rule: "CriticalCap", detail: `${c} critical notices in 24 h` } : undefined;
	}
	if (isQuiet(now, policy)) return { rule: "Quiet", detail: `${n.effective} notice during quiet hours` };
	const rows = db.all<{ resolved_at: number }>(
		"SELECT resolved_at FROM notices WHERE decision = 'deliver' AND effective IN ('high', 'normal') AND resolved_at > ? AND id != ? ORDER BY resolved_at DESC",
		now - DAY,
		n.id,
	);
	if (rows.length >= policy.maxInterruptsPerDay) return { rule: "Budget", detail: `${rows.length} interrupts in 24 h` };
	if (rows.length && now - rows[0].resolved_at < policy.minGapMinutes * MINUTE) {
		return { rule: "MinGap", detail: `last interrupt ${Math.round((now - rows[0].resolved_at) / MINUTE)} min ago` };
	}
	return undefined;
}
