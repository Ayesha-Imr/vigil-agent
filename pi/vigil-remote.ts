// A pi extension that connects an interactive pi session (say, on your laptop) to your vigil
// daemon: hand long work to vigil, ask it something, ping your phone, and get a push when a long
// pi run finishes. Install with `pi install git:github.com/Ayesha-Imr/vigil-agent`.
//
// Environment: VIGIL_URL (default http://127.0.0.1:7777), VIGIL_HTTP_TOKEN (required),
// VIGIL_NOTIFY_AFTER_MINUTES (push when a run took longer than this; default 10, 0 = off).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE = (process.env.VIGIL_URL ?? "http://127.0.0.1:7777").replace(/\/$/, "");
const TOKEN = process.env.VIGIL_HTTP_TOKEN ?? "";
const NOTIFY_AFTER_MS = Number(process.env.VIGIL_NOTIFY_AFTER_MINUTES ?? 10) * 60_000;

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
	if (!TOKEN) throw new Error("set VIGIL_HTTP_TOKEN (the http token from your vigil config)");
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(130_000),
	});
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) throw new Error(`vigil ${res.status}: ${String(data.error ?? res.statusText)}`);
	return data;
}

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: {} };
}

export default function vigilRemote(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "vigil_ticket",
		label: "Hand off to vigil",
		description:
			"Hand a long-running task to vigil, the user's always-on agent on their server. It works in the background and reports to the user's phone. Use when the user asks to do something later, overnight, or 'in the background'.",
		parameters: Type.Object({ title: Type.String(), request: Type.String({ description: "The task, in the user's words, with the context vigil needs." }) }),
		async execute(_id, p) {
			const r = await api("POST", "/api/ticket", { title: p.title, request: p.request });
			return text(`vigil started ${r.id}: ${r.title}. It will report to the user's phone.`);
		},
	});
	pi.registerTool({
		name: "vigil_notify",
		label: "Push to phone",
		description: "Send the user a notice on their phone through vigil (it respects their quiet hours and budget). Use when the user asked to be told about something.",
		parameters: Type.Object({
			text: Type.String(),
			urgency: Type.Optional(Type.Unsafe<string>({ type: "string", enum: ["critical", "high", "normal", "low"] })),
		}),
		async execute(_id, p) {
			const r = await api("POST", "/api/notify", { text: p.text, urgency: p.urgency ?? "normal", topic: "pi" });
			return text(`notice ${r.id}: ${r.decision}`);
		},
	});
	pi.registerTool({
		name: "vigil_ask",
		label: "Ask vigil",
		description: "Ask vigil something it knows (its memory of the user, its schedule, its open tasks) and get its reply.",
		parameters: Type.Object({ question: Type.String() }),
		async execute(_id, p) {
			const r = await api("POST", "/api/message", { text: p.question });
			return text(String(r.reply ?? "(no reply)"));
		},
	});

	pi.registerCommand("vigil", {
		description: "Send a message to vigil, or /vigil status",
		handler: async (args, ctx) => {
			try {
				if (!args.trim() || args.trim() === "status") {
					const r = await api("GET", "/api/status");
					ctx.ui.notify(String(r.text));
					return;
				}
				const r = await api("POST", "/api/message", { text: args });
				ctx.ui.notify(String(r.reply ?? "(no reply)"));
			} catch (err) {
				ctx.ui.notify(`vigil: ${(err as Error).message}`, "error");
			}
		},
	});

	// Push to the phone when a long run finishes, so the user can walk away from the laptop.
	let startedAt = 0;
	pi.on("agent_start", () => {
		startedAt = Date.now();
	});
	pi.on("agent_settled", async (_e, ctx) => {
		if (!TOKEN || NOTIFY_AFTER_MS <= 0 || !startedAt) return;
		const took = Date.now() - startedAt;
		startedAt = 0;
		if (took < NOTIFY_AFTER_MS) return;
		const minutes = Math.round(took / 60_000);
		await api("POST", "/api/notify", {
			text: `pi finished in ${ctx.cwd.split("/").pop()} after ${minutes} min.`,
			urgency: "normal",
			topic: "pi",
		}).catch(() => {});
	});
}
