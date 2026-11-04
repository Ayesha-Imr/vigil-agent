// Unit tests for model routing: error classification, candidates/ranking, cooldown and fallback.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import type { ModelRole } from "../src/config.ts";
import { type AnyModel, classifyError, type FailureKind, key, ModelRouter } from "../src/agent/models.ts";
import { MINUTE, ManualClock } from "../src/core/time.ts";

function model(provider: string, id: string, o: Partial<{ reasoning: boolean; contextWindow: number; input: number; output: number }> = {}): AnyModel {
	return {
		id,
		name: id,
		provider,
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning: o.reasoning ?? false,
		input: ["text"],
		cost: { input: o.input ?? 0, output: o.output ?? 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: o.contextWindow ?? 100_000,
		maxTokens: 8000,
	} as unknown as AnyModel;
}

const ids = (ms: AnyModel[]) => ms.map(key);

describe("classifyError", () => {
	const cases: [string, FailureKind][] = [
		["429 Too Many Requests", "rate_limit"],
		["Rate limit reached for requests", "rate_limit"],
		["rate-limit exceeded, retry later", "rate_limit"],
		["Overloaded", "rate_limit"],
		["You exceeded your current quota, please check your plan and billing details.", "quota"],
		["insufficient_quota", "quota"],
		["You've hit your usage limit. Upgrade to Pro", "quota"],
		["Your credit balance is too low; buy more credits", "quota"],
		["401 Unauthorized", "auth"],
		["403 Forbidden", "auth"],
		["Invalid API key provided", "auth"],
		["No API key for provider opencode-go", "auth"],
		["OAuth token expired: please login again", "auth"],
		["500 Internal Server Error", "server"],
		["502 Bad Gateway", "server"],
		["503 Service Unavailable", "server"],
		["server error", "server"],
		["fetch failed", "network"],
		["connect ECONNREFUSED 127.0.0.1:443", "network"],
		["getaddrinfo ENOTFOUND api.example.com", "network"],
		["socket hang up", "network"],
		["ETIMEDOUT", "network"],
		["This model's maximum context length is 128000 tokens", "context"],
		["prompt is too long: 210000 tokens > 200000 maximum", "context"],
		["Invalid tool schema", "other"],
		["", "other"],
	];
	it.each(cases)("%j -> %s", (msg, kind) => {
		expect(classifyError(msg)).toBe(kind);
	});

	it("is case-insensitive", () => {
		expect(classifyError("RATE LIMIT")).toBe("rate_limit");
		expect(classifyError("QUOTA EXCEEDED")).toBe("quota");
	});

	// Regression test (fixed bug): the status-code patterns have no word boundaries (models.ts:17-21), so digits inside a
	// request id, a byte count or a duration select the wrong kind. A plain server error that
	// carries a request id containing "401"/"403" is classified `auth`, which cools down the WHOLE
	// provider for 30 minutes instead of one model for 1 minute; "after 5000ms" reads as a 5xx.
	// Fix: anchor the codes, e.g. /\b429\b/, /\b40[13]\b/, /\b5\d\d\b/.
	it("digits inside a request id are not status codes", () => {
		expect(
			classifyError(
				"The server had an error while processing your request. (Please include the request ID req_7f4013ab9c in your message.)",
			),
		).not.toBe("auth");
	});
	it("a duration is not a 5xx status", () => {
		expect(classifyError("request timeout after 5000ms")).toBe("network");
	});
});

describe("ModelRouter", () => {
	let clock: ManualClock;
	let prefs: Record<ModelRole, string[]>;
	let router: ModelRouter;

	const codexBig = model("openai-codex", "gpt-big", { reasoning: true, contextWindow: 400_000, input: 5, output: 20 });
	const codexMini = model("openai-codex", "gpt-mini", { reasoning: true, contextWindow: 200_000, input: 0.5, output: 2 });
	const codexPlain = model("openai-codex", "gpt-plain", { reasoning: false, contextWindow: 1_000_000, input: 1, output: 1 });
	const codexPreview = model("openai-codex", "gpt-next-preview", { reasoning: true, contextWindow: 2_000_000, input: 0, output: 0 });
	const goKimi = model("opencode-go", "kimi", { reasoning: true, contextWindow: 256_000, input: 0.6, output: 2.5 });
	const goGlm = model("opencode-go", "glm", { reasoning: true, contextWindow: 128_000, input: 0.3, output: 1.2 });
	const goFree = model("opencode-go", "glm-free", { reasoning: true, contextWindow: 128_000, input: 0, output: 0 });
	const nested = model("openrouter", "anthropic/claude-x", { reasoning: true });
	const all = [codexBig, codexMini, codexPlain, codexPreview, goKimi, goGlm, goFree, nested];

	beforeEach(() => {
		clock = new ManualClock();
		prefs = {
			concierge: ["openai-codex/*", "opencode-go/*"],
			worker: ["openai-codex/*", "opencode-go/*"],
			triage: ["opencode-go/*", "openai-codex/*"],
			dream: ["opencode-go/*", "openai-codex/*"],
		};
		router = new ModelRouter({} as ModelRuntime, () => prefs, clock);
		router.setAvailableForTests(all);
	});

	describe("candidates", () => {
		it("ranks a provider's models for concierge/worker: non-preview, reasoning, big context, then pricier", () => {
			expect(ids(router.candidates("concierge"))).toEqual([
				"openai-codex/gpt-big",
				"openai-codex/gpt-mini",
				"openai-codex/gpt-plain",
				"openai-codex/gpt-next-preview",
				"opencode-go/kimi",
				"opencode-go/glm",
				"opencode-go/glm-free",
			]);
			expect(ids(router.candidates("worker"))).toEqual(ids(router.candidates("concierge")));
		});

		it("ranks cheapest first for triage/dream, preview/free last", () => {
			expect(ids(router.candidates("triage"))).toEqual([
				"opencode-go/glm",
				"opencode-go/kimi",
				"opencode-go/glm-free",
				"openai-codex/gpt-plain",
				"openai-codex/gpt-mini",
				"openai-codex/gpt-big",
				"openai-codex/gpt-next-preview",
			]);
			expect(ids(router.candidates("dream"))).toEqual(ids(router.candidates("triage")));
		});

		it("breaks a context tie on cost (pricier first) for workers", () => {
			const a = model("p", "a", { reasoning: true, contextWindow: 100, input: 1 });
			const b = model("p", "b", { reasoning: true, contextWindow: 100, input: 3 });
			router.setAvailableForTests([a, b]);
			prefs.worker = ["p/*"];
			expect(ids(router.candidates("worker"))).toEqual(["p/b", "p/a"]);
		});

		it("an explicit id comes first and is not repeated by a later wildcard", () => {
			prefs.concierge = ["opencode-go/glm", "openai-codex/gpt-mini", "openai-codex/*", "opencode-go/*"];
			expect(ids(router.candidates("concierge"))).toEqual([
				"opencode-go/glm",
				"openai-codex/gpt-mini",
				"openai-codex/gpt-big",
				"openai-codex/gpt-plain",
				"openai-codex/gpt-next-preview",
				"opencode-go/kimi",
				"opencode-go/glm-free",
			]);
		});

		it("a bare provider name means provider/*", () => {
			prefs.triage = ["opencode-go"];
			expect(ids(router.candidates("triage"))).toEqual(["opencode-go/glm", "opencode-go/kimi", "opencode-go/glm-free"]);
		});

		it("model ids may contain slashes", () => {
			prefs.worker = ["openrouter/anthropic/claude-x"];
			expect(ids(router.candidates("worker"))).toEqual(["openrouter/anthropic/claude-x"]);
		});

		it("only models with credentials (available) are candidates", () => {
			prefs.worker = ["nope/*", "openai-codex/does-not-exist", "opencode-go/kimi"];
			expect(ids(router.candidates("worker"))).toEqual(["opencode-go/kimi"]);
			router.setAvailableForTests([]);
			expect(router.candidates("worker")).toEqual([]);
			expect(router.pick("worker")).toBeUndefined();
		});

		it("a role without preferences has no candidates", () => {
			delete (prefs as Partial<Record<ModelRole, string[]>>).dream;
			expect(router.candidates("dream")).toEqual([]);
		});

		it("does not reorder the available list", () => {
			const before = ids([...all]);
			router.candidates("concierge");
			router.candidates("triage");
			router.setAvailableForTests(all);
			expect(ids(all)).toEqual(before);
		});
	});

	describe("pick / failed / cooldown", () => {
		it("picks the first candidate", () => {
			expect(key(router.pick("concierge")!)).toBe("openai-codex/gpt-big");
			expect(key(router.pick("triage")!)).toBe("opencode-go/glm");
		});

		it("honours exclude", () => {
			expect(key(router.pick("concierge", new Set(["openai-codex/gpt-big"]))!)).toBe("openai-codex/gpt-mini");
		});

		it("a rate limit cools down only that model and falls back to the next", () => {
			const r = router.failed(codexBig, "429 Too Many Requests");
			expect(r).toEqual({ kind: "rate_limit", fallBack: true });
			expect(key(router.pick("concierge")!)).toBe("openai-codex/gpt-mini");
			expect(router.coolingDown()).toEqual([{ model: "openai-codex/gpt-big", until: clock.now() + 2 * MINUTE }]);
			clock.advance(2 * MINUTE - 1);
			expect(key(router.pick("concierge")!)).toBe("openai-codex/gpt-mini");
			clock.advance(1);
			expect(key(router.pick("concierge")!)).toBe("openai-codex/gpt-big");
			expect(router.coolingDown()).toEqual([]);
		});

		it("a server error cools for 1 minute, a network error for 30 s", () => {
			router.failed(codexBig, "502 Bad Gateway");
			router.failed(codexMini, "fetch failed");
			const until = Object.fromEntries(router.coolingDown().map((c) => [c.model, c.until]));
			expect(until).toEqual({ "openai-codex/gpt-big": clock.now() + MINUTE, "openai-codex/gpt-mini": clock.now() + 30_000 });
			expect(key(router.pick("concierge")!)).toBe("openai-codex/gpt-plain");
		});

		it.each(["You exceeded your current quota", "401 Unauthorized"])("%j cools down the whole provider", (msg) => {
			const r = router.failed(codexMini, msg);
			expect(r.fallBack).toBe(true);
			const cooling = router.coolingDown().map((c) => c.model).sort();
			expect(cooling).toEqual(["openai-codex/gpt-big", "openai-codex/gpt-mini", "openai-codex/gpt-next-preview", "openai-codex/gpt-plain"]);
			// Concierge falls through to the other provider.
			expect(key(router.pick("concierge")!)).toBe("opencode-go/kimi");
			// The other provider is untouched.
			expect(key(router.pick("triage")!)).toBe("opencode-go/glm");
		});

		it("quota cools for an hour, auth for 30 minutes", () => {
			router.failed(codexBig, "quota exceeded");
			clock.advance(59 * MINUTE);
			expect(key(router.pick("concierge")!).startsWith("opencode-go/")).toBe(true);
			clock.advance(MINUTE);
			expect(key(router.pick("concierge")!)).toBe("openai-codex/gpt-big");

			router.failed(goGlm, "invalid api key");
			clock.advance(30 * MINUTE - 1);
			expect(key(router.pick("triage")!)).toBe("openai-codex/gpt-plain");
			clock.advance(1);
			expect(key(router.pick("triage")!)).toBe("opencode-go/glm");
		});

		it.each(["maximum context length exceeded", "Invalid tool schema"])("%j does not fall back or cool down", (msg) => {
			const r = router.failed(codexBig, msg);
			expect(r.fallBack).toBe(false);
			expect(router.coolingDown()).toEqual([]);
			expect(key(router.pick("concierge")!)).toBe("openai-codex/gpt-big");
		});

		it("when every candidate is cooling down, pick still returns the first one", () => {
			router.failed(codexBig, "quota");
			router.failed(goKimi, "quota");
			expect(key(router.pick("concierge")!)).toBe("openai-codex/gpt-big");
		});

		it("a later failure extends the cooldown", () => {
			router.failed(codexBig, "429");
			clock.advance(MINUTE);
			router.failed(codexBig, "429");
			expect(router.coolingDown()).toEqual([{ model: "openai-codex/gpt-big", until: clock.now() + 2 * MINUTE }]);
		});

		it("refresh() reads the runtime's available models", async () => {
			const r = new ModelRouter({ getAvailable: async () => [goKimi] } as unknown as ModelRuntime, () => prefs, clock);
			expect(r.candidates("concierge")).toEqual([]);
			await r.refresh();
			expect(ids(r.candidates("concierge"))).toEqual(["opencode-go/kimi"]);
		});
	});
});
