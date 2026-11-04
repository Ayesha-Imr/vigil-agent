// The services every part of the agent layer reaches: one object, built by the daemon.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Paths, VigilConfig } from "../config.ts";
import type { Approvals } from "../core/approvals.ts";
import type { Notifier, OwnerRoute } from "../core/notifier.ts";
import type { Outbox } from "../core/outbox.ts";
import type { Scheduler } from "../core/scheduler.ts";
import type { Tickets } from "../core/tickets.ts";
import type { Clock } from "../core/time.ts";
import type { Watchers } from "../core/watchers.ts";
import type { Memory } from "../memory/memory.ts";
import type { Db } from "../store/db.ts";
import type { GatePolicy } from "./gate.ts";
import type { ModelRouter } from "./models.ts";

export interface Services {
	cfg: VigilConfig;
	paths: Paths;
	db: Db;
	clock: Clock;
	outbox: Outbox;
	notifier: Notifier;
	approvals: Approvals;
	scheduler: Scheduler;
	watchers: Watchers;
	memory: Memory;
	tickets: Tickets;
	models: ModelRouter;
	modelRuntime: ModelRuntime;
	gatePolicy: () => GatePolicy;
	ownerRoute: () => OwnerRoute | undefined;
	/** Directory of skills shipped with vigil (formal verification and others). */
	skillsDir: string;
	/** Whether processing is paused (/pause). Sources keep recording; nothing new runs. */
	paused: () => boolean;
	/** Wake the worker pool after something queued work for it. */
	wakeWorkers: () => void;
}

/** Send a message the owner asked for (a reply or a ticket result): no budget, but quiet hours hold it. */
export function sendSolicited(
	s: Services,
	to: OwnerRoute | undefined,
	text: string,
	ref: { kind: "ticket" | "reply" | "attention" | "approval"; id: string },
	opts: { replyTo?: string; buttons?: { data: string; label: string }[][]; urgent?: boolean; topic?: string } = {},
): void {
	const route = to ?? s.ownerRoute();
	if (!route) {
		s.db.event("unroutable", `no channel to send: ${text.slice(0, 100)}`);
		return;
	}
	const quiet = s.notifier.budget().quietNow;
	if (quiet && !opts.urgent && !opts.buttons) {
		// Held until quiet hours end, then delivered with the morning digest.
		s.notifier.notify({ urgency: "high", topic: opts.topic ?? `${ref.kind}:${ref.id}`, text, ticketId: ref.kind === "ticket" ? ref.id : undefined });
		return;
	}
	s.outbox.enqueue({
		channel: route.channel,
		conversation: route.conversation,
		text,
		buttons: opts.buttons,
		replyTo: opts.replyTo,
		ref,
		orderKey: ref.kind === "ticket" ? `${ref.id}:${route.channel}:${route.conversation}` : undefined,
	});
}
