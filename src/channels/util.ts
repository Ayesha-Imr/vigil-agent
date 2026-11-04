// Small helpers shared by the channel adapters: logging, button flattening, text truncation, and
// numbered "reply 1 to …" buttons for apps without real buttons (WhatsApp, Signal).

import type { Button } from "./types.ts";

/** A line logger. Channels log connection state and dropped events; nothing secret. */
export type Log = (line: string) => void;

/** The default logger: stderr, so stdout stays free for `vigil chat` and QR codes. */
export const stderrLog: Log = (line) => {
	process.stderr.write(`${line}\n`);
};

/** All buttons in reading order, ignoring rows. */
export function flattenButtons(buttons: Button[][] | undefined): Button[] {
	return (buttons ?? []).flat();
}

/** Cut `text` to at most `max` UTF-16 units, ending with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = max - 1;
	// Do not leave half a surrogate pair at the end.
	const code = text.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut--;
	return `${text.slice(0, cut)}…`;
}

/** The message of an unknown thrown value. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Wait for `work` at most `ms`, then let it finish in the background (errors go to `onError`).
 * For update loops that must not stall behind a slow handler but should usually wait for it.
 */
export async function settleWithin(work: Promise<void>, ms: number, onError: (err: unknown) => void): Promise<void> {
	const guarded = work.catch(onError);
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	await Promise.race([guarded, timeout]);
	clearTimeout(timer);
}

/** How long a bare-digit reply still counts as pressing one of the last buttons sent. */
export const BUTTON_REPLY_WINDOW_MS = 30 * 60_000;

/** The text for a message with buttons: the numbered choices appended. */
/**
 * Buttons a bare digit may press on apps without real buttons. Approvals are never among them (a
 * digit meant for one question must not approve another message's command), and the Mute/Less
 * switches of notices are left out so they do not take the place of a pending question.
 */
export function digitButtons(buttons: Button[]): Button[] {
	return buttons.filter((b) => !/^(approve|deny|mute|less):/.test(b.data));
}

export function renderWithButtons(text: string, buttons: Button[]): string {
	if (buttons.length === 0) return text;
	const lines: string[] = [];
	const digits = digitButtons(buttons);
	if (digits.length) lines.push(`Reply ${digits.map((b, i) => `${i + 1} to ${b.label}`).join(", ")}`);
	const approve = buttons.find((b) => b.data.startsWith("approve:"));
	if (approve) lines.push(`Reply /approve ${approve.data.slice(8)} or /deny ${approve.data.slice(8)}`);
	return lines.length ? `${text}\n\n${lines.join("\n")}` : text;
}

interface Remembered {
	buttons: Button[];
	at: number;
	/** The external id of the message that carried the buttons. */
	messageId: string;
}

/** Remembers the last buttons sent per conversation and maps a bare-digit reply to one. */
export class ButtonMemory {
	private readonly last = new Map<string, Remembered>();
	private readonly windowMs: number;

	constructor(windowMs = BUTTON_REPLY_WINDOW_MS) {
		this.windowMs = windowMs;
	}

	remember(conversation: string, buttons: Button[], messageId: string, now: number): void {
		const digits = digitButtons(buttons);
		if (digits.length === 0) return;
		this.last.set(conversation, { buttons: digits, at: now, messageId });
	}

	/**
	 * The button a reply presses, if `text` is just a number for one of the last buttons sent to
	 * this conversation within the window. A match is used up, so a later "2" is plain text.
	 */
	match(conversation: string, text: string, now: number): { button: Button; messageId: string } | undefined {
		const entry = this.last.get(conversation);
		if (!entry) return undefined;
		if (now - entry.at > this.windowMs) {
			this.last.delete(conversation);
			return undefined;
		}
		const m = /^\s*(\d{1,2})\s*\.?\s*$/.exec(text);
		if (!m) return undefined;
		const button = entry.buttons[Number(m[1]) - 1];
		if (!button) return undefined;
		this.last.delete(conversation);
		return { button, messageId: entry.messageId };
	}
}
