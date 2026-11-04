// Unit tests for watchers: the pure text helpers and checkOne/checkDue with a fake fetcher.

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MINUTE, ManualClock } from "../src/core/time.ts";
import { feedItems, htmlToText, lineDiff, type Watcher, Watchers } from "../src/core/watchers.ts";
import { Db } from "../src/store/db.ts";

describe("htmlToText", () => {
	it("drops scripts, styles and tags, keeps visible text", () => {
		const html = `<html><head><style>body { color: red }</style><script>var x = "<b>hi</b>";</script></head>
<body><h1>Price</h1>
<p>Now <b>$39</b>&nbsp;only</p>
<SCRIPT type="text/javascript">track()</SCRIPT></body></html>`;
		const text = htmlToText(html);
		expect(text).not.toMatch(/color|track|var x|<|>/);
		expect(text).toContain("Price");
		expect(text).toContain("Now $39 only");
	});

	it("decodes common entities", () => {
		expect(htmlToText("Tom &amp; Jerry &lt;3 &gt; &quot;cats&quot; &#39;n&apos; dogs")).toBe(`Tom & Jerry <3 > "cats" 'n' dogs`);
	});

	it("collapses spaces and blank lines and trims", () => {
		// Lines keep a single surrounding space; lineDiff trims lines, so that does not count as change.
		expect(htmlToText("  <div>a</div>   \n\n\n  <div>b</div>  ")).toBe("a \n b");
		expect(htmlToText("a\t\t  b")).toBe("a b");
	});

	it("markup-only churn gives the same text", () => {
		expect(htmlToText(`<p class="a">Hello <i>world</i></p>`)).toBe(htmlToText(`<p class="b" data-x="1">Hello <em>world</em></p>`));
	});

	// Regression test (fixed bug): entities are decoded in sequence, &amp; first, so `&amp;lt;` (the literal text "&lt;")
	// is decoded twice and becomes "<". Fix: decode in one pass, e.g.
	// .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_, e) => MAP[e]), or decode &amp; last.
	it("decodes each entity once (&amp;lt; is the literal text &lt;)", () => {
		expect(htmlToText("x &amp;lt; y")).toBe("x &lt; y");
	});
});

describe("feedItems", () => {
	const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Blog</title><link>https://blog.example/</link>
  <item>
    <title><![CDATA[First & <b>best</b>]]></title>
    <link>https://blog.example/1</link>
    <guid isPermaLink="false">post-1</guid>
  </item>
  <item>
    <title>Second post</title>
    <link>https://blog.example/2</link>
  </item>
</channel></rss>`;

	const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Releases</title>
  <link href="https://example.org/"/>
  <entry>
    <title type="html">v1.2.0 released</title>
    <link rel="alternate" href="https://example.org/r/1.2.0"/>
    <id>tag:example.org,2026:1.2.0</id>
    <updated>2026-01-05T10:00:00Z</updated>
  </entry>
  <entry>
    <title>v1.1.0</title>
    <link href="https://example.org/r/1.1.0"/>
    <id>tag:example.org,2026:1.1.0</id>
  </entry>
</feed>`;

	it("parses RSS items, using guid, then link, as the id", () => {
		expect(feedItems(rss)).toEqual([
			{ id: "post-1", title: "First & best", link: "https://blog.example/1" },
			{ id: "https://blog.example/2", title: "Second post", link: "https://blog.example/2" },
		]);
	});

	it("parses Atom entries with href links and ids", () => {
		expect(feedItems(atom)).toEqual([
			{ id: "tag:example.org,2026:1.2.0", title: "v1.2.0 released", link: "https://example.org/r/1.2.0" },
			{ id: "tag:example.org,2026:1.1.0", title: "v1.1.0", link: "https://example.org/r/1.1.0" },
		]);
	});

	it("returns nothing for non-feeds and skips empty items", () => {
		expect(feedItems("<html><body>nope</body></html>")).toEqual([]);
		expect(feedItems("<rss><item></item></rss>")).toEqual([]);
	});

	it("falls back to the title as id", () => {
		expect(feedItems("<rss><item><title>Only a title</title></item></rss>")).toEqual([{ id: "Only a title", title: "Only a title", link: "" }]);
	});
});

describe("lineDiff", () => {
	it("lists added then removed lines, ignoring order and whitespace", () => {
		expect(lineDiff("a\nb\nc", "c\n  b \nd")).toBe("+ d\n- a");
	});

	it("is empty when only order or blank lines change", () => {
		expect(lineDiff("a\nb", "b\n\n a\n")).toBe("");
	});

	it("is bounded by max lines and says how many were hidden", () => {
		const before = Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n");
		const after = Array.from({ length: 30 }, (_, i) => `new ${i}`).join("\n");
		const out = lineDiff(before, after, 40).split("\n");
		expect(out).toHaveLength(41);
		expect(out.filter((l) => l.startsWith("+ "))).toHaveLength(30);
		expect(out.filter((l) => l.startsWith("- "))).toHaveLength(10);
		expect(out[40]).toBe("(20 more changed lines)");
	});

	it("cuts long lines to 300 chars", () => {
		const out = lineDiff("", "x".repeat(1000));
		expect(out).toBe(`+ ${"x".repeat(300)}`);
	});

	it("property: at most max+1 lines, each at most 302 chars, and nothing for equal inputs", () => {
		const line = fc.string({ maxLength: 400 });
		const text = fc.array(line, { maxLength: 80 }).map((ls) => ls.join("\n"));
		fc.assert(
			fc.property(text, text, fc.integer({ min: 0, max: 50 }), (a, b, max) => {
				const out = lineDiff(a, b, max);
				const lines = out === "" ? [] : out.split("\n");
				expect(lines.length).toBeLessThanOrEqual(max + 1);
				for (const l of lines.slice(0, max)) expect(l.length).toBeLessThanOrEqual(302);
				expect(lineDiff(a, a, max)).toBe("");
			}),
		);
	});
});

describe("Watchers", () => {
	let db: Db;
	let clock: ManualClock;
	let pages: Map<string, string | Error>;
	let fetches: string[];
	let w: Watchers;

	beforeEach(() => {
		db = new Db(":memory:");
		clock = new ManualClock();
		pages = new Map();
		fetches = [];
		w = new Watchers(db, clock, async (url) => {
			fetches.push(url);
			const p = pages.get(url);
			if (p instanceof Error) throw p;
			if (p === undefined) throw new Error("HTTP 404");
			return p;
		});
	});

	afterEach(() => db.close());

	const triggers = () => db.all<{ source: string; kind: string; strength: string; external_id: string; payload: string }>("SELECT * FROM triggers ORDER BY id");
	const fresh = (x: Watcher) => w.get(x.id)!;

	function urlWatcher(): Watcher {
		pages.set("https://shop.example/item", "<p>Price: $45</p>");
		return w.create({ name: "price", kind: "url", target: "https://shop.example/item", everyMinutes: 30, instruction: "tell me below $40" });
	}

	it("create clamps the interval to at least 5 minutes", () => {
		const x = w.create({ name: "n", kind: "url", target: "u", everyMinutes: 1, instruction: "i" });
		expect(x.every_minutes).toBe(5);
		expect(x.last_value).toBeNull();
		expect(w.list().map((y) => y.id)).toEqual([x.id]);
		expect(w.remove(x.id)).toBe(true);
		expect(w.remove(x.id)).toBe(false);
	});

	it("the first check records a baseline and makes no Trigger", async () => {
		const x = urlWatcher();
		expect(await w.checkOne(x)).toBeUndefined();
		const after = fresh(x);
		expect(after.last_value).toBe("Price: $45");
		expect(after.last_checked_at).toBe(clock.now());
		expect(triggers()).toEqual([]);
	});

	it("an unchanged check makes no Trigger", async () => {
		const x = urlWatcher();
		await w.checkOne(x);
		clock.advance(30 * MINUTE);
		pages.set(x.target, `<div class="new-markup">Price: <span>$45</span></div>`);
		expect(await w.checkOne(fresh(x))).toBeUndefined();
		expect(triggers()).toEqual([]);
		expect(fresh(x).last_checked_at).toBe(clock.now());
	});

	it("a change makes exactly one inferred watch Trigger with a diff summary", async () => {
		const x = urlWatcher();
		await w.checkOne(x);
		pages.set(x.target, "<p>Price: $39</p>");
		const c = await w.checkOne(fresh(x));
		expect(c).toBeDefined();
		expect(c!.summary).toBe("+ Price: $39\n- Price: $45");
		const t = triggers();
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ source: "watch", kind: "watch", strength: "inferred" });
		expect(t[0].external_id).toMatch(new RegExp(`^${x.id}:\\d+:[0-9a-f]{12}:[0-9a-f]{8}$`));
		expect(JSON.parse(t[0].payload)).toEqual({ watcherId: x.id, summary: c!.summary });
		expect(c!.triggerId).toBe(db.get<{ id: number }>("SELECT id FROM triggers")!.id);
		expect(fresh(x).last_value).toBe("Price: $39");
		// And checking again with the new value is quiet.
		expect(await w.checkOne(fresh(x))).toBeUndefined();
		expect(triggers()).toHaveLength(1);
	});

	it("the same change content is not recorded twice (same hash), e.g. a replayed check", async () => {
		const x = urlWatcher();
		await w.checkOne(x);
		const stale = fresh(x); // last_value = $45
		pages.set(x.target, "<p>Price: $39</p>");
		expect(await w.checkOne(stale)).toBeDefined();
		// The same check runs again from the same stale row: the Trigger key dedups it.
		expect(await w.checkOne(stale)).toBeUndefined(); // the compare-and-swap on last_value refuses it
		expect(triggers()).toHaveLength(1);
	});

	// Regression test (fixed bug): the Trigger key is `${watcher.id}:${sha256(new snapshot)}` (watchers.ts:177), so once a
	// page has been in state B, every later change back to B is swallowed as a duplicate forever.
	// A status page flapping up -> down -> up -> down reports the first outage only; a price
	// dropping below 40 a second time is never reported. Fix: key the Trigger on something unique
	// per real transition, e.g. include the hash of the previous snapshot and the check time
	// (`${w.id}:${now}:${hash}`), or keep a per-watcher change counter.
	it("a page that returns to an earlier state is reported again", async () => {
		const x = urlWatcher();
		await w.checkOne(x); // baseline: up ($45)
		pages.set(x.target, "<p>Price: $39</p>");
		expect(await w.checkOne(fresh(x))).toBeDefined(); // drop
		pages.set(x.target, "<p>Price: $45</p>");
		expect(await w.checkOne(fresh(x))).toBeDefined(); // back up
		pages.set(x.target, "<p>Price: $39</p>");
		expect(await w.checkOne(fresh(x))).toBeDefined(); // drops again: must be reported
	});

	it("a change that only reorders lines updates the value but makes no Trigger", async () => {
		pages.set("u", "<p>a</p>\n<p>b</p>");
		const x = w.create({ name: "n", kind: "url", target: "u", everyMinutes: 5, instruction: "i" });
		await w.checkOne(x);
		pages.set("u", "<p>b</p>\n<p>a</p>");
		expect(await w.checkOne(fresh(x))).toBeUndefined();
		expect(fresh(x).last_value).toBe("b \n a");
		expect(triggers()).toEqual([]);
	});

	it("a fetch error is recorded in last_error and keeps the baseline", async () => {
		const x = urlWatcher();
		await w.checkOne(x);
		pages.set(x.target, new Error("HTTP 503"));
		clock.advance(30 * MINUTE);
		expect(await w.checkOne(fresh(x))).toBeUndefined();
		const after = fresh(x);
		expect(after.last_error).toBe("HTTP 503");
		expect(after.last_value).toBe("Price: $45");
		expect(after.last_checked_at).toBe(clock.now());
		expect(triggers()).toEqual([]);
		// A later success clears the error.
		pages.set(x.target, "<p>Price: $45</p>");
		await w.checkOne(fresh(x));
		expect(fresh(x).last_error).toBeNull();
	});

	it("long error messages are cut", async () => {
		pages.set("u", new Error("e".repeat(2000)));
		const x = w.create({ name: "n", kind: "url", target: "u", everyMinutes: 5, instruction: "i" });
		await w.checkOne(x);
		expect(fresh(x).last_error).toHaveLength(500);
	});

	it("a feed watcher reports only new items", async () => {
		const feed = (ids: number[]) =>
			`<rss><channel>${ids.map((i) => `<item><title>Post ${i}</title><link>https://b/${i}</link><guid>g${i}</guid></item>`).join("")}</channel></rss>`;
		pages.set("f", feed([1, 2]));
		const x = w.create({ name: "blog", kind: "feed", target: "f", everyMinutes: 60, instruction: "new posts" });
		await w.checkOne(x);
		expect(fresh(x).last_value).toBe("g1\tPost 1\thttps://b/1\ng2\tPost 2\thttps://b/2");
		pages.set("f", feed([3, 1, 2]));
		const c = await w.checkOne(fresh(x));
		expect(c?.summary).toBe("new: Post 3 https://b/3");
		// An item that disappears is a change but has nothing new to say: no Trigger.
		pages.set("f", feed([3, 1]));
		expect(await w.checkOne(fresh(x))).toBeUndefined();
		expect(triggers()).toHaveLength(1);
	});

	it("a command watcher runs the command through sh", async () => {
		const x = w.create({ name: "cmd", kind: "command", target: "echo hello", everyMinutes: 5, instruction: "i" });
		expect(await w.checkOne(x)).toBeUndefined();
		expect(fresh(x).last_value).toBe("hello");
		expect(fresh(x).last_error).toBeNull();
		await db.run("UPDATE watchers SET target = ? WHERE id = ?", "echo hello; echo world", x.id);
		const c = await w.checkOne(fresh(x));
		expect(c?.summary).toBe("+ world");
		expect(fetches).toEqual([]);
	});

	it("a failing command is recorded as an error", async () => {
		const x = w.create({ name: "cmd", kind: "command", target: "echo oops >&2; exit 3", everyMinutes: 5, instruction: "i" });
		await w.checkOne(x);
		const after = fresh(x);
		expect(after.last_value).toBeNull();
		expect(after.last_error).toMatch(/oops/);
	});

	it("checkDue checks only due, enabled watchers", async () => {
		const x = urlWatcher(); // every 30 min
		pages.set("v", "v1");
		const y = w.create({ name: "other", kind: "url", target: "v", everyMinutes: 60, instruction: "i" });
		const z = w.create({ name: "off", kind: "url", target: "v", everyMinutes: 5, instruction: "i" });
		db.run("UPDATE watchers SET enabled = 0 WHERE id = ?", z.id);

		expect(await w.checkDue()).toEqual([]); // baselines
		expect(fetches.sort()).toEqual([x.target, "v"].sort());
		fetches = [];

		clock.advance(29 * MINUTE);
		expect(await w.checkDue()).toEqual([]);
		expect(fetches).toEqual([]);

		clock.advance(MINUTE);
		pages.set(x.target, "<p>Price: $39</p>");
		const changes = await w.checkDue();
		expect(fetches).toEqual([x.target]);
		expect(changes.map((c) => c.watcher.id)).toEqual([x.id]);
		expect(fresh(y).last_checked_at).toBe(clock.now() - 30 * MINUTE);
	});

	it("checkDue does not run two passes at once", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const slow = new Watchers(db, clock, async () => {
			await gate;
			return "x";
		});
		slow.create({ name: "n", kind: "url", target: "u", everyMinutes: 5, instruction: "i" });
		const first = slow.checkDue();
		expect(await slow.checkDue()).toEqual([]);
		release();
		await first;
	});
});
