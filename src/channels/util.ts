// Small helpers shared by the channel adapters: logging, button flattening, text truncation.

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
