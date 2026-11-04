// Tests for the ntfy channel: headers, priority, signed action buttons and sending via fetch.

import { describe, expect, it } from "vitest";
import { signButton } from "../../src/channels/http.ts";
import { NtfyChannel, ntfyHeaders } from "../../src/channels/ntfy.ts";
import { PermanentSendError } from "../../src/channels/types.ts";

const buttons = [[{ label: "✅ Approve", data: "approve:ap_1" }, { label: "Deny", data: "deny:ap_1" }], [{ label: "Later", data: "l" }, { label: "Four", data: "4" }]];

describe("ntfyHeaders", () => {
	it("uses priority 5 for 🚨 and 3 otherwise", () => {
		expect(ntfyHeaders({ conversation: "t", text: "🚨 disk full" }, {}).Priority).toBe("5");
		expect(ntfyHeaders({ conversation: "t", text: "build done" }, {}).Priority).toBe("3");
	});

	it("omits actions without a callback URL", () => {
		expect(ntfyHeaders({ conversation: "t", text: "x", buttons }, {}).Actions).toBeUndefined();
	});

	it("maps up to three buttons to signed http actions with ASCII labels", () => {
		const h = ntfyHeaders({ conversation: "t", text: "x", buttons }, { token: "nt", callback: { publicUrl: "https://vigil.example/", token: "api" } });
		expect(h.Authorization).toBe("Bearer nt");
		const actions = h.Actions.split("; ");
		expect(actions).toHaveLength(3);
		expect(actions[0]).toBe(
			`http, "Approve", https://vigil.example/api/button?data=approve%3Aap_1&sig=${signButton("api", "approve:ap_1")}, method=POST, clear=true`,
		);
		expect(h.Actions).not.toMatch(/Bearer|token=/); // the API token itself never goes to ntfy
		expect(/^[\x20-\x7e]*$/.test(h.Actions)).toBe(true);
	});
});

describe("NtfyChannel", () => {
	it("posts to server/topic and returns the ntfy id", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fake = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ id: "abc123" }), { status: 200 });
		}) as unknown as typeof fetch;
		const ch = new NtfyChannel({ server: "https://ntfy.sh/", topic: "my-topic", fetch: fake });
		expect(ch.ownerConversation()).toBe("my-topic");
		const res = await ch.send({ conversation: "my-topic", text: "hello" });
		expect(res.externalId).toBe("my-topic:abc123");
		expect(calls[0].url).toBe("https://ntfy.sh/my-topic");
		expect(calls[0].init.body).toBe("hello");
	});

	it("throws PermanentSendError on 403 and a retryable error on 429", async () => {
		const respond = (status: number) =>
			(async () => new Response("no", { status })) as unknown as typeof fetch;
		await expect(new NtfyChannel({ server: "https://n", topic: "t", fetch: respond(403) }).send({ conversation: "t", text: "x" })).rejects.toBeInstanceOf(PermanentSendError);
		const err = await new NtfyChannel({ server: "https://n", topic: "t", fetch: respond(429) }).send({ conversation: "t", text: "x" }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(PermanentSendError);
	});
});
