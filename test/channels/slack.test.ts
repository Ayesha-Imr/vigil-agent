// Unit tests for the Slack channel's pure parts: event → InboundMessage mapping, Block Kit
// buttons, markup conversion, refs and error classification. No network, no Bolt app.

import { describe, expect, it } from "vitest";
import {
	classifySlackError,
	escapeSlack,
	fromSlackAction,
	fromSlackMessage,
	fromSlackReaction,
	parseSlackRef,
	type SlackMessageEvent,
	slackBlocks,
	slackEmoji,
	slackToPlain,
} from "../../src/channels/slack.ts";
import { PermanentSendError } from "../../src/channels/types.ts";

const dm = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
	type: "message",
	channel: "D0123ABC",
	channel_type: "im",
	user: "U0OWNER",
	text: "hello",
	ts: "1730000000.000100",
	...over,
});

describe("fromSlackMessage", () => {
	it("maps a DM to a message keyed channel:ts", () => {
		expect(fromSlackMessage(dm())).toEqual({
			channel: "slack",
			externalId: "D0123ABC:1730000000.000100",
			senderId: "U0OWNER",
			conversation: "D0123ABC",
			kind: "message",
			text: "hello",
			replyTo: undefined,
			attachments: undefined,
			at: 1730000000000,
		});
	});

	it("points a threaded reply at the thread root", () => {
		expect(fromSlackMessage(dm({ ts: "1730000005.000200", thread_ts: "1730000000.000100" }))?.replyTo).toBe("D0123ABC:1730000000.000100");
		// The root itself carries thread_ts == ts once it has replies; that is not a reply.
		expect(fromSlackMessage(dm({ thread_ts: "1730000000.000100" }))?.replyTo).toBeUndefined();
	});

	it("drops channels, bots, edits and empty messages", () => {
		expect(fromSlackMessage(dm({ channel_type: "channel", channel: "C1" }))).toBeUndefined();
		expect(fromSlackMessage(dm({ bot_id: "B1" }))).toBeUndefined();
		expect(fromSlackMessage(dm({ subtype: "message_changed" }))).toBeUndefined();
		expect(fromSlackMessage(dm({ user: undefined }))).toBeUndefined();
		expect(fromSlackMessage(dm({ text: "" }))).toBeUndefined();
	});

	it("lists files as attachments with notes", () => {
		const msg = fromSlackMessage(
			dm({
				subtype: "file_share",
				text: "see this",
				files: [
					{ name: "a.png", mimetype: "image/png", url_private_download: "https://files.slack.com/files-pri/T1-F1/download/a.png" },
					{ name: "r.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/files-pri/T1-F2/r.pdf" },
				],
			}),
		);
		expect(msg?.text).toBe("see this\n[photo attached]\n[document attached: r.pdf]");
		expect(msg?.attachments).toEqual([
			{ kind: "photo", ref: "https://files.slack.com/files-pri/T1-F1/download/a.png", name: "a.png", mimeType: "image/png" },
			{ kind: "document", ref: "https://files.slack.com/files-pri/T1-F2/r.pdf", name: "r.pdf", mimeType: "application/pdf" },
		]);
	});

	it("unescapes Slack markup", () => {
		expect(fromSlackMessage(dm({ text: "a &lt; b &amp;&amp; <https://x.com|x> <@U2>" }))?.text).toBe("a < b && x (https://x.com) @U2");
	});
});

describe("slackToPlain / escapeSlack", () => {
	it("round-trips the escaped characters and flattens links", () => {
		expect(slackToPlain(escapeSlack("1 < 2 & 3 > 2"))).toBe("1 < 2 & 3 > 2");
		expect(slackToPlain("<https://example.com>")).toBe("https://example.com");
		expect(slackToPlain("<mailto:a@b.c|a@b.c>")).toBe("a@b.c (mailto:a@b.c)");
		expect(slackToPlain("<#C123|general> <!here>")).toBe("general !here");
	});
});

describe("fromSlackAction", () => {
	it("maps a button press to kind button with the message as replyTo", () => {
		const msg = fromSlackAction({
			type: "block_actions",
			user: { id: "U0OWNER", username: "ayesha" },
			channel: { id: "D0123ABC" },
			message: { ts: "1730000001.000300" },
			actions: [{ type: "button", action_id: "approve:ap_1", value: "approve:ap_1", text: { text: "Approve" }, action_ts: "1730000009.123456" }],
		});
		expect(msg).toMatchObject({
			channel: "slack",
			kind: "button",
			senderId: "U0OWNER",
			senderName: "ayesha",
			conversation: "D0123ABC",
			text: "Approve",
			data: "approve:ap_1",
			replyTo: "D0123ABC:1730000001.000300",
			at: 1730000009123,
		});
		expect(msg?.externalId).toContain("1730000009.123456");
	});

	it("uses the value over a de-duplicated action_id and falls back to the container", () => {
		const msg = fromSlackAction({
			type: "block_actions",
			user: { id: "U1" },
			container: { channel_id: "D9", message_ts: "1.000001" },
			actions: [{ type: "button", action_id: "x#2", value: "x" }],
		});
		expect(msg?.data).toBe("x");
		expect(msg?.text).toBe("x");
		expect(msg?.replyTo).toBe("D9:1.000001");
	});

	it("ignores non-button actions and other payloads", () => {
		expect(fromSlackAction({ type: "block_actions", user: { id: "U1" }, channel: { id: "D1" }, actions: [{ type: "static_select", action_id: "s" }] })).toBeUndefined();
		expect(fromSlackAction({ type: "view_submission", user: { id: "U1" }, actions: [] })).toBeUndefined();
	});
});

describe("fromSlackReaction", () => {
	it("maps a reaction in a DM with replyTo channel:ts and a real emoji", () => {
		const msg = fromSlackReaction({
			type: "reaction_added",
			user: "U0OWNER",
			reaction: "thumbsdown",
			item: { type: "message", channel: "D0123ABC", ts: "1730000001.000300" },
			event_ts: "1730000020.000001",
		});
		expect(msg).toMatchObject({ kind: "reaction", text: "👎", data: "👎", replyTo: "D0123ABC:1730000001.000300", conversation: "D0123ABC" });
	});

	it("ignores reactions outside DMs and on files", () => {
		const base = { type: "reaction_added" as const, user: "U1", reaction: "+1", event_ts: "1.1" };
		expect(fromSlackReaction({ ...base, item: { type: "message", channel: "C1", ts: "1.2" } })).toBeUndefined();
		expect(fromSlackReaction({ ...base, item: { type: "file" } })).toBeUndefined();
	});

	it("names emoji the core understands and keeps others as :name:", () => {
		expect(slackEmoji("+1::skin-tone-3")).toBe("👍");
		expect(slackEmoji("no_bell")).toBe("🔕");
		expect(slackEmoji("partyparrot")).toBe(":partyparrot:");
	});
});

describe("slackBlocks", () => {
	const b = (n: number) => ({ label: `b${n}`, data: `d${n}` });

	it("returns nothing for plain text", () => {
		expect(slackBlocks("hi", undefined)).toBeUndefined();
		expect(slackBlocks("hi", [[]])).toBeUndefined();
	});

	it("puts escaped text in a section and buttons in actions blocks of at most 5", () => {
		const blocks = slackBlocks("Run <rm>?", [Array.from({ length: 7 }, (_, i) => b(i)), [b(9)]]);
		expect(blocks?.[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "Run &lt;rm&gt;?" } });
		const actions = blocks?.slice(1) as { type: string; elements: { action_id: string; value: string; text: { text: string } }[] }[];
		expect(actions.map((a) => a.type)).toEqual(["actions", "actions", "actions"]);
		expect(actions.map((a) => a.elements.length)).toEqual([5, 2, 1]);
		expect(actions[0].elements[0]).toEqual({ type: "button", text: { type: "plain_text", text: "b0", emoji: true }, action_id: "d0", value: "d0" });
	});

	it("keeps action ids unique, splits long text and refuses oversized data", () => {
		const blocks = slackBlocks("x ".repeat(4000), [[{ label: "A", data: "same" }, { label: "B", data: "same" }]]);
		const sections = blocks?.filter((bl) => bl.type === "section") ?? [];
		expect(sections.length).toBeGreaterThan(1);
		const actions = blocks?.find((bl) => bl.type === "actions") as { elements: { action_id: string; value: string }[] };
		expect(actions.elements.map((e) => e.action_id)).toEqual(["same", "same#2"]);
		expect(actions.elements.map((e) => e.value)).toEqual(["same", "same"]);
		expect(() => slackBlocks("x", [[{ label: "x", data: "d".repeat(256) }]])).toThrow(PermanentSendError);
	});
});

describe("parseSlackRef", () => {
	it("parses channel:ts", () => {
		expect(parseSlackRef("D0123ABC:1730000000.000100")).toEqual({ channel: "D0123ABC", ts: "1730000000.000100" });
		expect(parseSlackRef("D1:notats")).toBeUndefined();
		expect(parseSlackRef("action:D1:1.2")).toBeUndefined();
	});
});

describe("classifySlackError", () => {
	const platform = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), { code: "slack_webapi_platform_error", data: { ok: false, error } });

	it("treats a gone channel or user as permanent", () => {
		for (const e of ["not_in_channel", "channel_not_found", "is_archived", "account_inactive"]) {
			expect(classifySlackError(platform(e))).toBeInstanceOf(PermanentSendError);
		}
	});

	it("retries rate limits, auth trouble and network errors", () => {
		const limited = classifySlackError(platform("ratelimited"));
		expect(limited).not.toBeInstanceOf(PermanentSendError);
		expect(limited.message).toContain("rate limited");
		const rejected = classifySlackError(Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: 30 }));
		expect(rejected).not.toBeInstanceOf(PermanentSendError);
		expect(rejected.message).toContain("retry after 30 s");
		expect(classifySlackError(platform("invalid_auth"))).not.toBeInstanceOf(PermanentSendError);
		expect(classifySlackError(Object.assign(new Error("socket hang up"), { code: "slack_webapi_request_error" }))).not.toBeInstanceOf(PermanentSendError);
		expect(classifySlackError("weird")).toBeInstanceOf(Error);
	});
});
