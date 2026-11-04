// The notifier: the governor plus persistence and delivery. Everything vigil says without being
// asked goes through notify(); replies to the owner's own messages do not.

import { randomUUID } from "node:crypto";
import type { ChannelId } from "../config.ts";
import type { Db } from "../store/db.ts";
import {
	budget,
	type BudgetView,
	type GovernorPolicy,
	type GovernorState,
	initialState,
	markDelivered,
	mute,
	type Notice,
	type NoticeInput,
	offer,
	penalize,
	renderDigest,
	takeForReply,
	tick,
	unmute,
	waiting,
} from "./governor.ts";
import { checkSend } from "./invariants.ts";
import type { Outbox } from "./outbox.ts";
import { type Clock, DAY } from "./time.ts";

export interface OwnerRoute {
	channel: ChannelId;
	conversation: string;
}

const STATE_KEY = "governor";

export class Notifier {
	private state: GovernorState;
	private readonly db: Db;
	private readonly clock: Clock;
	private readonly outbox: Outbox;
	private readonly policy: () => GovernorPolicy;
	private readonly route: () => OwnerRoute | undefined;

	constructor(opts: {
		db: Db;
		clock: Clock;
		outbox: Outbox;
		policy: () => GovernorPolicy;
		route: () => OwnerRoute | undefined;
	}) {
		this.db = opts.db;
		this.clock = opts.clock;
		this.outbox = opts.outbox;
		this.policy = opts.policy;
		this.route = opts.route;
		this.state = this.db.getKv<GovernorState>(STATE_KEY) ?? initialState(this.clock.now());
	}

	/** Offer a notification to the governor; it is sent now, later, or never. */
	notify(input: Omit<NoticeInput, "id"> & { id?: string }): Notice {
		const now = this.clock.now();
		return this.db.tx(() => {
			const r = offer(this.state, { ...input, id: input.id ?? `nt_${randomUUID().slice(0, 8)}` }, now, this.policy());
			// Guard against the recorded history before this notice is recorded as delivered.
			const violation = r.deliverNow ? checkSend(this.db, r.notice, now, this.policy(), this.state.mutes, false) : undefined;
			this.commit(r.state);
			this.record(r.notice);
			if (violation) this.db.event("invariant.violation", `${violation.rule}: ${violation.detail}; notice ${r.notice.id} not sent`);
			else if (r.deliverNow) this.send(r.notice.text, { kind: "notice", id: r.notice.id }, r.notice.effective === "critical");
			this.db.event("notice", `${r.notice.decision}: [${r.notice.effective}/${r.notice.topic}] ${r.notice.text.slice(0, 120)}`);
			return r.notice;
		});
	}

	/** Advance the governor's clock; sends a digest when one is due. */
	tick(): Notice[] {
		const now = this.clock.now();
		return this.db.tx(() => {
			const r = tick(this.state, now, this.policy());
			this.commit(r.state);
			for (const n of r.expired) this.record(n);
			const quietViolation = r.digest.length ? checkSend(this.db, r.digest[0], now, this.policy(), {}, true) : undefined;
			if (quietViolation) {
				this.db.event("invariant.violation", `${quietViolation.rule}: ${quietViolation.detail}; digest not sent`);
			} else if (r.digest.length) {
				for (const n of r.digest) this.record(n);
				this.send(renderDigest(r.digest), { kind: "digest", id: r.digest.map((n) => n.id).join(",") }, false);
				this.db.event("digest", `sent digest of ${r.digest.length}`);
			}
			return r.digest;
		});
	}

	/** The owner wrote: take what waits, so the reply can mention it. */
	takeForReply(): Notice[] {
		const now = this.clock.now();
		return this.db.tx(() => {
			const r = takeForReply(this.state, now);
			this.commit(r.state);
			for (const n of r.notices) this.record(n);
			return r.notices;
		});
	}

	/** Confirm that a stored reply told the owner about these waiting notices. */
	confirmDelivered(ids: readonly string[]): void {
		if (!ids.length) return;
		const now = this.clock.now();
		this.db.tx(() => {
			const r = markDelivered(this.state, ids, now);
			this.commit(r.state);
			for (const n of r.notices) this.record(n);
		});
	}

	mute(topic: string, forMs: number): void {
		const now = this.clock.now();
		this.db.tx(() => {
			this.commit(mute(this.state, topic, now + forMs, now));
			for (const n of this.state.notices) if (n.topic === topic && n.decision === "drop:muted") this.record(n);
			this.db.event("mute", `muted ${topic} for ${Math.round(forMs / 60000)} min`);
		});
	}

	unmute(topic: string): void {
		this.commit(unmute(this.state, topic));
	}

	/** The owner disliked a notice: lower its topic's urgency for a week. */
	dislike(noticeId: string): string | undefined {
		const n = this.state.notices.find((x) => x.id === noticeId);
		if (!n) return undefined;
		this.commit(penalize(this.state, n.topic, this.clock.now() + 7 * DAY));
		this.db.event("feedback", `owner disliked a notice on ${n.topic}; lowering it for 7 days`);
		return n.topic;
	}

	topicOf(noticeId: string): string | undefined {
		return this.state.notices.find((x) => x.id === noticeId)?.topic;
	}

	waiting(): Notice[] {
		return waiting(this.state);
	}

	mutes(): Record<string, number> {
		return { ...this.state.mutes };
	}

	budget(): BudgetView {
		return budget(this.state, this.clock.now(), this.policy());
	}

	private send(text: string, ref: { kind: "notice" | "digest"; id: string }, critical: boolean): void {
		const route = this.route();
		if (!route) {
			this.db.event("notice.unroutable", "no owner channel is configured; notice kept in the panel only");
			return;
		}
		// An interruption comes with its own off switch; digests (many topics) do not.
		const buttons =
			ref.kind === "notice"
				? [[{ data: `mute:${ref.id}`, label: "🔕 Mute 1 day" }, { data: `less:${ref.id}`, label: "👎 Less like this" }]]
				: undefined;
		this.outbox.enqueue({ ...route, text: critical ? `🚨 ${text}` : text, ref, buttons });
	}

	private commit(state: GovernorState): void {
		this.state = state;
		this.db.setKv(STATE_KEY, state, this.clock.now());
	}

	private record(n: Notice): void {
		this.db.run(
			`INSERT INTO notices (id, urgency, effective, topic, text, decision, status, ticket_id, created_at, resolved_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET status = excluded.status, decision = excluded.decision, resolved_at = excluded.resolved_at`,
			n.id,
			n.urgency,
			n.effective,
			n.topic,
			n.text,
			n.decision,
			n.status,
			n.ticketId ?? null,
			n.createdAt,
			n.resolvedAt ?? null,
		);
	}
}
