// The services every part of the agent layer reaches: one object, built by the daemon.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Attachment } from "../channels/types.ts";
import type { ChannelId, Paths, VigilConfig } from "../config.ts";
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
	/**
	 * Fetch the files of an owner message: images go to the model when it accepts them; every file
	 * is saved under inbox/ and named in a note so the agent can open it with its tools.
	 */
	fetchAttachments: (channel: ChannelId, attachments: Attachment[], acceptsImages: boolean) => Promise<{ images: ImageContent[]; notes: string[] }>;
	/** Show a typing indicator in a chat, where the channel supports it. Never throws. */
	typing: (channel: ChannelId, conversation: string) => Promise<void>;
}

/**
 * Leave the concierge a note about something that happened elsewhere (a worker's result, a question
 * it asked, an action triage took), so the conversation knows when the owner asks about it. Notes
 * are stored, and folded into the concierge's next turn; they never start a turn themselves.
 */
export function noteToConcierge(s: Services, text: string): void {
	const notes = s.db.getKv<string[]>("concierge.notes") ?? [];
	notes.push(text.slice(0, 600));
	s.db.setKv("concierge.notes", notes.slice(-30));
}

/** Take the pending notes (and clear them). */
export function takeConciergeNotes(s: Services): string[] {
	const notes = s.db.getKv<string[]>("concierge.notes") ?? [];
	if (notes.length) s.db.setKv("concierge.notes", []);
	return notes;
}

/** Send a message the owner asked for (a reply or a ticket result): no budget, but quiet hours hold it. */
export function sendSolicited(
	s: Services,
	to: OwnerRoute | undefined,
	text: string,
	ref: { kind: "ticket" | "reply" | "attention" | "approval"; id: string },
	opts: { replyTo?: string; buttons?: { data: string; label: string }[][]; urgent?: boolean; topic?: string; ticketId?: string } = {},
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
		// A question or result that has to go out during quiet hours arrives without a buzz.
		silent: quiet && !opts.urgent,
		ref,
		// Every message of one ticket to one conversation keeps its order: results and questions alike
		// (verification/outbox, finding F1: a question could be overtaken by the next report).
		orderKey: (() => {
			const tk = ref.kind === "ticket" ? ref.id : opts.ticketId;
			return tk ? `${tk}:${route.channel}:${route.conversation}` : undefined;
		})(),
	});
}
