// CLI channel for `vigil chat`: lines from stdin are messages, sent messages are printed with
// their buttons as "[1] Approve [2] Deny", and typing /1 presses the first button.

import { createInterface, type Interface } from "node:readline";
import type { ChannelId } from "../config.ts";
import type { Button, Channel, InboundMessage, OutboundMessage, SendResult } from "./types.ts";
import { errorText, flattenButtons } from "./util.ts";

const ID: ChannelId = "cli";
/** The conversation of the local terminal. */
export const CLI_CONVERSATION = "cli";

export interface CliOptions {
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	/** Called when input ends (Ctrl-D). */
	onClose?: () => void;
	prompt?: string;
}

/** Render buttons as `[1] Approve [2] Deny`. */
export function renderCliButtons(buttons: Button[]): string {
	return buttons.map((b, i) => `[${i + 1}] ${b.label}`).join(" ");
}

/** A readline channel over stdin and stdout. */
export class CliChannel implements Channel {
	readonly id = ID;
	private readonly input: NodeJS.ReadableStream;
	private readonly output: NodeJS.WritableStream;
	private readonly onClose: (() => void) | undefined;
	private readonly prompt: string;
	private rl: Interface | undefined;
	private lastButtons: { buttons: Button[]; messageId: string } | undefined;
	private seq = 0;
	private sent = 0;
	private readonly session = Date.now().toString(36);

	constructor(opts: CliOptions = {}) {
		this.input = opts.input ?? process.stdin;
		this.output = opts.output ?? process.stdout;
		this.onClose = opts.onClose;
		this.prompt = opts.prompt ?? "> ";
	}

	async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
		const rl = createInterface({ input: this.input, output: this.output, terminal: false });
		this.rl = rl;
		rl.on("line", (line) => {
			const msg = this.parse(line);
			if (!msg) {
				this.showPrompt();
				return;
			}
			onInbound(msg).catch((err: unknown) => this.print(`(error: ${errorText(err)})`));
		});
		rl.on("close", () => {
			this.rl = undefined;
			this.onClose?.();
		});
		this.showPrompt();
	}

	/** Turn a typed line into an InboundMessage; `/N` presses button N of the last message. */
	parse(line: string): InboundMessage | undefined {
		const text = line.trim();
		if (!text) return undefined;
		const externalId = `cli:${this.session}:${++this.seq}`;
		const base = { channel: ID, externalId, senderId: "owner", conversation: CLI_CONVERSATION, at: Date.now() };
		const press = /^\/(\d+)$/.exec(text);
		if (press) {
			const button = this.lastButtons?.buttons[Number(press[1]) - 1];
			if (!button) {
				this.print("(no such button)");
				return undefined;
			}
			return { ...base, kind: "button", text: button.label, data: button.data, replyTo: this.lastButtons?.messageId };
		}
		return { ...base, kind: "message", text };
	}

	async send(msg: OutboundMessage): Promise<SendResult> {
		const externalId = `cli:out:${this.session}:${++this.sent}`;
		const buttons = flattenButtons(msg.buttons);
		let out = msg.text;
		if (buttons.length > 0) {
			out += `\n${renderCliButtons(buttons)}  (type /1 to press [1])`;
			this.lastButtons = { buttons, messageId: externalId };
		}
		this.print(out);
		return { externalId };
	}

	private print(text: string): void {
		this.output.write(`\n${text}\n`);
		this.showPrompt();
	}

	private showPrompt(): void {
		if (this.rl) this.output.write(this.prompt);
	}

	ownerConversation(): string | undefined {
		return CLI_CONVERSATION;
	}

	async stop(): Promise<void> {
		this.rl?.close();
		this.rl = undefined;
	}
}
