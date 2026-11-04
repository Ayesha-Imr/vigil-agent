// HTTP channel and the daemon's small HTTP server (node:http, no framework). `POST /api/message`
// waits for vigil's reply so iOS Shortcuts and scripts get an answer in one request; other routes
// (the panel) are mounted with `route()`. Every route needs the token.

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelId } from "../config.ts";
import type { Button, Channel, InboundMessage, OutboundMessage, SendResult } from "./types.ts";
import { errorText, type Log, stderrLog } from "./util.ts";

const ID: ChannelId = "http";
/** The conversation every HTTP message belongs to. */
export const HTTP_CONVERSATION = "http";
/** How long `POST /api/message` waits for the reply. */
export const REPLY_TIMEOUT_MS = 120_000;
/**
 * Parts of a split reply arriving this soon after the previous one are added to it. The outbox
 * sends the parts of one message back to back in a single pass, so this can be short.
 */
const CONTINUATION_MS = 300;
const MAX_BODY_BYTES = 1_000_000;

export interface HttpRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: IncomingMessage["headers"];
	/** Parsed JSON body, or the raw text for non-JSON bodies; undefined when empty. */
	body: unknown;
	raw: IncomingMessage;
}

export interface HttpResponse {
	status?: number;
	/** A string or Buffer is sent as is; anything else as JSON. */
	body?: unknown;
	headers?: Record<string, string>;
}

export type RouteHandler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

export interface HttpServerOptions {
	port: number;
	/** The API token. Without one every request is refused. */
	token?: string;
	/** Defaults to 127.0.0.1; put a reverse proxy in front to expose it. */
	host?: string;
	log?: Log;
}

/** Whether `given` equals `expected`, in time that does not depend on where they differ. */
export function safeEqual(given: string, expected: string): boolean {
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b) && given.length === expected.length;
}

/** A signature that lets one specific button press through without the token (ntfy actions). */
export function signButton(token: string, data: string): string {
	return createHmac("sha256", token).update(`button:${data}`).digest("base64url");
}

/** The bearer token or `?token=` of a request. */
export function requestToken(headers: IncomingMessage["headers"], query: URLSearchParams): string | undefined {
	const auth = headers.authorization;
	if (typeof auth === "string") {
		const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
		if (m) return m[1];
	}
	return query.get("token") ?? undefined;
}

interface Route {
	handler: RouteHandler;
	/** Return true to let a request in without the token (it must check something else). */
	allowUnauthenticated?: (req: HttpRequest) => boolean;
}

/** A tiny router with token auth. */
export class HttpServer {
	private readonly opts: HttpServerOptions;
	private readonly routes = new Map<string, Route>();
	private readonly log: Log;
	private server: Server | undefined;

	constructor(opts: HttpServerOptions) {
		this.opts = opts;
		this.log = opts.log ?? stderrLog;
	}

	/** Register a handler for an exact method and path, e.g. `route("GET", "/panel", h)`. */
	route(method: string, path: string, handler: RouteHandler, allowUnauthenticated?: (req: HttpRequest) => boolean): void {
		this.routes.set(`${method.toUpperCase()} ${path}`, { handler, allowUnauthenticated });
	}

	get token(): string | undefined {
		return this.opts.token;
	}

	/** Start listening; resolves with the bound port (useful with port 0). */
	async listen(): Promise<number> {
		if (this.server) return this.port();
		const server = createServer((req, res) => {
			this.handle(req, res).catch((err: unknown) => {
				this.log(`http: ${req.method} ${req.url} failed: ${errorText(err)}`);
				if (!res.headersSent) write(res, { status: 500, body: { error: "internal error" } });
				else res.end();
			});
		});
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.opts.port, this.opts.host ?? "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		return this.port();
	}

	port(): number {
		return (this.server?.address() as AddressInfo | null)?.port ?? this.opts.port;
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = (req.method ?? "GET").toUpperCase();
		const route = this.routes.get(`${method} ${url.pathname}`);
		if (!route) {
			const other = [...this.routes.keys()].some((k) => k.endsWith(` ${url.pathname}`));
			write(res, other ? { status: 405, body: { error: "method not allowed" } } : { status: 404, body: { error: "not found" } });
			return;
		}
		let body: unknown;
		try {
			body = await readBody(req);
		} catch (err) {
			write(res, { status: 400, body: { error: errorText(err) } });
			return;
		}
		const request: HttpRequest = { method, path: url.pathname, query: url.searchParams, headers: req.headers, body, raw: req };
		const expected = this.opts.token;
		const given = requestToken(req.headers, url.searchParams);
		const authed = expected !== undefined && expected !== "" && given !== undefined && safeEqual(given, expected);
		if (!authed && !(expected && route.allowUnauthenticated?.(request))) {
			write(res, expected ? { status: 401, body: { error: "unauthorized" } } : { status: 503, body: { error: "http token not configured" } });
			return;
		}
		write(res, await route.handler(request));
	}
}

function write(res: ServerResponse, r: HttpResponse): void {
	const status = r.status ?? 200;
	const headers: Record<string, string> = { "cache-control": "no-store", ...r.headers };
	if (r.body === undefined) {
		res.writeHead(status, headers).end();
	} else if (typeof r.body === "string" || Buffer.isBuffer(r.body)) {
		res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }).end(r.body);
	} else {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers }).end(JSON.stringify(r.body));
	}
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > MAX_BODY_BYTES) throw new Error("body too large");
		chunks.push(buf);
	}
	if (size === 0) return undefined;
	const text = Buffer.concat(chunks).toString("utf8");
	const type = String(req.headers["content-type"] ?? "");
	if (type.includes("json") || /^\s*[{[]/.test(text)) {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new Error("invalid JSON body");
		}
	}
	return text;
}

function field(body: unknown, query: URLSearchParams, name: string): string | undefined {
	if (typeof body === "object" && body !== null) {
		const v = (body as Record<string, unknown>)[name];
		if (typeof v === "string") return v;
	}
	if (typeof body === "string" && name === "text") return body;
	return query.get(name) ?? undefined;
}

interface Waiter {
	parts: string[];
	buttons?: Button[][];
	resolve: () => void;
	timer: NodeJS.Timeout;
	firstAt?: number;
}

export interface HttpChannelOptions extends HttpServerOptions {
	/** Extra routes keyed `"METHOD /path"`, e.g. `{ "GET /panel": handler }`. */
	handlers?: Record<string, RouteHandler>;
	/** How long `POST /api/message` waits for the reply. */
	replyTimeoutMs?: number;
}

/**
 * The HTTP channel. `POST /api/message {text}` emits a message and answers `{reply}` once the
 * core sends a message to conversation "http" with replyTo = that message's externalId.
 * `POST /api/button {data}` emits a button press; it also accepts `?data=…&sig=…` signed with
 * `signButton()` instead of the token, for ntfy action buttons.
 */
export class HttpChannel implements Channel {
	readonly id = ID;
	/** The underlying server, for mounting more routes. */
	readonly server: HttpServer;
	private readonly replyTimeoutMs: number;
	private readonly waiters = new Map<string, Waiter>();
	private onInbound: ((msg: InboundMessage) => Promise<void>) | undefined;
	/** The waiter that most recently got a first part, for split replies (only part 1 has replyTo). */
	private lastAnswered: string | undefined;

	constructor(opts: HttpChannelOptions) {
		this.server = new HttpServer(opts);
		this.replyTimeoutMs = opts.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
		this.server.route("POST", "/api/message", (req) => this.postMessage(req));
		this.server.route(
			"POST",
			"/api/button",
			(req) => this.postButton(req),
			(req) => this.validSignature(req),
		);
		for (const [key, handler] of Object.entries(opts.handlers ?? {})) {
			const [method, path] = key.split(" ");
			if (method && path) this.server.route(method, path, handler);
		}
	}

	/** Register an extra route on the server. */
	route(method: string, path: string, handler: RouteHandler): void {
		this.server.route(method, path, handler);
	}

	async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
		this.onInbound = onInbound;
		await this.server.listen();
	}

	/** The bound port. */
	port(): number {
		return this.server.port();
	}

	private async postMessage(req: HttpRequest): Promise<HttpResponse> {
		const text = field(req.body, req.query, "text")?.trim();
		if (!text) return { status: 400, body: { error: "text is required" } };
		const onInbound = this.onInbound;
		if (!onInbound) return { status: 503, body: { error: "not started" } };
		const externalId = `http:${randomUUID()}`;
		const wait = !(req.query.get("wait") === "false" || (req.body as { wait?: unknown } | undefined)?.wait === false);
		const done = wait ? this.waitFor(externalId) : undefined;
		try {
			await onInbound(this.inbound(externalId, "message", text));
		} catch (err) {
			this.cancel(externalId);
			throw err;
		}
		if (!done) return { status: 202, body: { id: externalId } };
		const result = await done;
		if (!result) return { status: 504, body: { id: externalId, error: `no reply within ${Math.round(this.replyTimeoutMs / 1000)} s` } };
		return { body: { id: externalId, reply: result.text, ...(result.buttons ? { buttons: result.buttons } : {}) } };
	}

	private async postButton(req: HttpRequest): Promise<HttpResponse> {
		const data = field(req.body, req.query, "data");
		if (!data) return { status: 400, body: { error: "data is required" } };
		const onInbound = this.onInbound;
		if (!onInbound) return { status: 503, body: { error: "not started" } };
		const externalId = `http:${randomUUID()}`;
		await onInbound({ ...this.inbound(externalId, "button", data), data });
		return { status: 202, body: { id: externalId } };
	}

	private validSignature(req: HttpRequest): boolean {
		const token = this.server.token;
		const sig = req.query.get("sig");
		const data = field(req.body, req.query, "data");
		return Boolean(token && sig && data && safeEqual(sig, signButton(token, data)));
	}

	private inbound(externalId: string, kind: "message" | "button", text: string): InboundMessage {
		return { channel: ID, externalId, senderId: "owner", conversation: HTTP_CONVERSATION, kind, text, at: Date.now() };
	}

	private waitFor(externalId: string): Promise<{ text: string; buttons?: Button[][] } | undefined> {
		return new Promise((resolve) => {
			const finish = (): void => {
				const w = this.waiters.get(externalId);
				this.waiters.delete(externalId);
				if (this.lastAnswered === externalId) this.lastAnswered = undefined;
				if (w) clearTimeout(w.timer);
				resolve(w && w.parts.length > 0 ? { text: w.parts.join("\n\n"), buttons: w.buttons } : undefined);
			};
			this.waiters.set(externalId, { parts: [], resolve: finish, timer: setTimeout(finish, this.replyTimeoutMs) });
		});
	}

	private cancel(externalId: string): void {
		const w = this.waiters.get(externalId);
		if (!w) return;
		clearTimeout(w.timer);
		this.waiters.delete(externalId);
	}

	/**
	 * Deliver a reply to the request waiting for it. The first part (replyTo set) is held for a
	 * moment so the rest of a split reply, which arrives without replyTo, joins it.
	 */
	async send(msg: OutboundMessage): Promise<SendResult> {
		const externalId = `http:out:${randomUUID()}`;
		// Only an exact replyTo match joins a waiting request: a message without one belongs to nobody,
		// so concurrent requests can never receive each other's replies.
		const key = msg.replyTo && this.waiters.has(msg.replyTo) ? msg.replyTo : undefined;
		const w = key ? this.waiters.get(key) : undefined;
		if (key && w && msg.conversation === HTTP_CONVERSATION) {
			w.parts.push(msg.text);
			if (msg.buttons) w.buttons = msg.buttons;
			this.lastAnswered = key;
			clearTimeout(w.timer);
			w.timer = setTimeout(w.resolve, CONTINUATION_MS);
		}
		return { externalId };
	}

	ownerConversation(): string | undefined {
		// Nobody is listening between requests, so proactive messages cannot go here.
		return undefined;
	}

	async stop(): Promise<void> {
		for (const w of [...this.waiters.values()]) w.resolve();
		await this.server.close();
	}
}
