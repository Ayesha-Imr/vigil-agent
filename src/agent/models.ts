// Model routing: each role has an ordered list of `provider/model` candidates. The first one with
// credentials that is not cooling down wins; a provider failure cools it down and the role falls
// through to the next.

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelRole } from "../config.ts";
import type { Clock } from "../core/time.ts";

// biome-ignore lint: pi's Model type is generic over the API.
export type AnyModel = Model<any>;

export type FailureKind = "rate_limit" | "quota" | "auth" | "server" | "network" | "context" | "other";

/** Classify a provider error message; decides whether to fall back and for how long. */
export function classifyError(message: string): FailureKind {
	const m = message.toLowerCase();
	if (/context|too long|maximum context|token limit/.test(m)) return "context";
	if (/quota|usage limit|insufficient|billing|exceeded your|plan limit|credits/.test(m)) return "quota";
	if (/\b429\b|rate.?limit|too many requests|overloaded/.test(m)) return "rate_limit";
	if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid api key|no api key|expired token|log ?in again|not logged in/.test(m)) return "auth";
	if (/\b5\d\d\b|server error|bad gateway|unavailable|internal error/.test(m)) return "server";
	if (/econn|etimedout|enotfound|socket|network|fetch failed|timeout/.test(m)) return "network";
	return "other";
}

const COOLDOWN_MS: Record<FailureKind, number> = {
	rate_limit: 2 * 60_000,
	quota: 60 * 60_000,
	auth: 30 * 60_000,
	server: 60_000,
	network: 30_000,
	context: 0,
	other: 0,
};

export function key(m: AnyModel): string {
	return `${m.provider}/${m.id}`;
}

export class ModelRouter {
	private readonly runtime: ModelRuntime;
	private readonly prefs: () => Record<ModelRole, string[]>;
	private readonly clock: Clock;
	private readonly cooling = new Map<string, number>();
	/** When a model call last succeeded and how many failed since, for the outage alert. */
	lastSuccessAt: number;
	failuresSinceSuccess = 0;
	private available: readonly AnyModel[] = [];

	constructor(runtime: ModelRuntime, prefs: () => Record<ModelRole, string[]>, clock: Clock) {
		this.runtime = runtime;
		this.prefs = prefs;
		this.clock = clock;
		this.lastSuccessAt = clock.now();
	}

	succeeded(): void {
		this.lastSuccessAt = this.clock.now();
		this.failuresSinceSuccess = 0;
	}

	/** Refresh which models have usable credentials. Call after login and periodically. */
	async refresh(): Promise<void> {
		this.available = await this.runtime.getAvailable();
	}

	setAvailableForTests(models: readonly AnyModel[]): void {
		this.available = models;
	}

	/** All candidates for a role in preference order, expanded and with credentials. */
	candidates(role: ModelRole): AnyModel[] {
		const out: AnyModel[] = [];
		const seen = new Set<string>();
		for (const pref of this.prefs()[role] ?? []) {
			const [provider, id] = splitPref(pref);
			const matches =
				id === "*"
					? rankForRole(this.available.filter((m) => m.provider === provider), role)
					: this.available.filter((m) => m.provider === provider && m.id === id);
			for (const m of matches) {
				if (seen.has(key(m))) continue;
				seen.add(key(m));
				out.push(m);
			}
		}
		return out;
	}

	/** The model a role should use now, or undefined when nothing is usable. */
	pick(role: ModelRole, exclude: ReadonlySet<string> = new Set()): AnyModel | undefined {
		const now = this.clock.now();
		const all = this.candidates(role).filter((m) => !exclude.has(key(m)));
		return all.find((m) => (this.cooling.get(key(m)) ?? 0) <= now) ?? all[0];
	}

	/** Record a failure; returns whether trying another model makes sense. */
	failed(model: AnyModel, message: string): { kind: FailureKind; fallBack: boolean } {
		const kind = classifyError(message);
		this.failuresSinceSuccess++;
		const ms = COOLDOWN_MS[kind];
		if (ms > 0) {
			// Quota and auth problems are account-wide: cool the whole provider down.
			const scope = kind === "quota" || kind === "auth" ? this.available.filter((m) => m.provider === model.provider) : [model];
			for (const m of scope) this.cooling.set(key(m), this.clock.now() + ms);
		}
		return { kind, fallBack: ms > 0 };
	}

	coolingDown(): { model: string; until: number }[] {
		const now = this.clock.now();
		return [...this.cooling.entries()].filter(([, t]) => t > now).map(([model, until]) => ({ model, until }));
	}
}

function splitPref(pref: string): [string, string] {
	const i = pref.indexOf("/");
	return i === -1 ? [pref, "*"] : [pref.slice(0, i), pref.slice(i + 1)];
}

/**
 * Order a provider's models for a role without hardcoding ids: big context and reasoning for
 * workers and the concierge, cheapest first for triage and dream.
 */
function rankForRole(models: AnyModel[], role: ModelRole): AnyModel[] {
	const cost = (m: AnyModel) => (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
	const preview = (m: AnyModel) => (/preview|free|contributor|experimental/i.test(m.id) ? 1 : 0);
	const copy = [...models];
	if (role === "triage" || role === "dream") {
		copy.sort((a, b) => preview(a) - preview(b) || cost(a) - cost(b));
	} else {
		copy.sort(
			(a, b) =>
				preview(a) - preview(b) ||
				Number(Boolean(b.reasoning)) - Number(Boolean(a.reasoning)) ||
				(b.contextWindow ?? 0) - (a.contextWindow ?? 0) ||
				cost(b) - cost(a),
		);
	}
	return copy;
}
