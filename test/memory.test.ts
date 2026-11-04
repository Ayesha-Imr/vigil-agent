// Unit tests for file memory: MEMORY.md editing, the journal, search and the core() cap.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_TEMPLATE, MEMORY_CAP_CHARS, Memory } from "../src/memory/memory.ts";

let dir: string;
let tz: string;
let mem: Memory;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vigil-mem-"));
	tz = "UTC";
	mem = new Memory(dir, () => tz);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => readFileSync(mem.memoryPath, "utf8");
const lines = () => file().split("\n");

/** The lines of a `## name` section, up to the next header. */
function section(name: string): string[] {
	const ls = lines();
	const i = ls.indexOf(`## ${name}`);
	if (i === -1) return [];
	const out: string[] = [];
	for (let j = i + 1; j < ls.length && !ls[j].startsWith("## "); j++) out.push(ls[j]);
	return out;
}

describe("setup", () => {
	it("creates MEMORY.md, HEARTBEAT.md, journal/ and notes/", () => {
		expect(existsSync(join(dir, "journal"))).toBe(true);
		expect(existsSync(join(dir, "notes"))).toBe(true);
		expect(file()).toContain("## Facts");
		expect(mem.heartbeat()).toBe(HEARTBEAT_TEMPLATE);
	});

	it("does not overwrite existing files", () => {
		writeFileSync(mem.memoryPath, "# mine\n");
		writeFileSync(mem.heartbeatPath, "watch the build\n");
		const again = new Memory(dir, () => tz);
		expect(again.core()).toBe("# mine\n");
		expect(again.heartbeat()).toBe("watch the build\n");
	});
});

describe("remember", () => {
	it("adds a bullet under Facts by default", () => {
		expect(mem.remember("The owner's dog is called Biscuit")).toEqual({ added: true });
		expect(section("Facts").filter(Boolean)).toEqual(["- The owner's dog is called Biscuit"]);
	});

	it("keeps insertion order within a section and leaves other sections alone", () => {
		mem.remember("one", "Preferences");
		mem.remember("two", "Preferences");
		mem.remember("fact", "Facts");
		expect(section("Preferences").filter(Boolean)).toEqual(["- one", "- two"]);
		expect(section("Facts").filter(Boolean)).toEqual(["- fact"]);
		expect(section("About the owner").filter(Boolean)).toEqual([]);
		expect(section("Ongoing").filter(Boolean)).toEqual([]);
		// Sections stay separated by a blank line.
		const ls = lines();
		expect(ls[ls.indexOf("## Ongoing") - 1]).toBe("");
	});

	it("inserts in a middle section before the next header", () => {
		mem.remember("Lives in Lahore", "About the owner");
		const ls = lines();
		const i = ls.indexOf("## About the owner");
		expect(ls[i + 1]).toBe("- Lives in Lahore");
		expect(ls.indexOf("## Preferences")).toBeGreaterThan(i + 1);
	});

	it("dedups the same line, ignoring case and whitespace", () => {
		expect(mem.remember("Prefers tea")).toEqual({ added: true });
		expect(mem.remember("  prefers   TEA ")).toEqual({ added: false });
		expect(mem.remember("Prefers tea", "Preferences")).toEqual({ added: false });
		expect(file().match(/prefers tea/gi)).toHaveLength(1);
	});

	it("normalises whitespace to one line", () => {
		mem.remember("multi\nline\ttext");
		expect(section("Facts")).toContain("- multi line text");
	});

	it("matches the section name case-insensitively", () => {
		mem.remember("x", "preferences");
		expect(section("Preferences")).toContain("- x");
		expect(file()).not.toContain("## preferences");
	});

	it("creates a missing section at the end", () => {
		mem.remember("vigil-agent tests", "Projects");
		mem.remember("second project", "Projects");
		const ls = lines();
		expect(ls.filter((l) => l === "## Projects")).toHaveLength(1);
		expect(section("Projects").filter(Boolean)).toEqual(["- vigil-agent tests", "- second project"]);
		expect(ls.indexOf("## Projects")).toBeGreaterThan(ls.indexOf("## Facts"));
	});

	it("creates a missing section in a file without a trailing newline", () => {
		writeFileSync(mem.memoryPath, "# Memory\n\n## Facts\n- a");
		mem.remember("b", "Other");
		expect(file()).toBe("# Memory\n\n## Facts\n- a\n\n## Other\n- b\n");
	});
});

describe("forget", () => {
	it("removes bullets containing the fragment, case-insensitively, and returns them", () => {
		mem.remember("Dog is called Biscuit");
		mem.remember("Cat is called Mango", "Preferences");
		mem.remember("Likes biscuits with tea");
		expect(mem.forget("BISCUIT").sort()).toEqual(["- Dog is called Biscuit", "- Likes biscuits with tea"]);
		expect(file()).not.toMatch(/biscuit/i);
		expect(file()).toContain("- Cat is called Mango");
	});

	it("never removes headers or prose, and ignores an empty fragment", () => {
		const before = file();
		expect(mem.forget("Facts")).toEqual([]);
		expect(mem.forget("memory")).toEqual([]);
		expect(mem.forget("   ")).toEqual([]);
		expect(file()).toBe(before);
	});
});

describe("journal", () => {
	it("appends to today's file with a header and HH:MM [kind] lines", () => {
		const t = Date.UTC(2026, 0, 5, 9, 7);
		mem.journal("note", "first   entry\nwith newline", t);
		mem.journal("job", "second", t + 61 * 60_000);
		expect(mem.journalFor("2026-01-05")).toBe("# 2026-01-05\n\n- 09:07 [note] first entry with newline\n- 10:08 [job] second\n");
		expect(readFileSync(join(dir, "journal", "2026-01-05.md"), "utf8")).toBe(mem.journalFor("2026-01-05"));
	});

	it("uses the owner's time zone for the day and the time", () => {
		tz = "Asia/Karachi";
		// 21:30 UTC on 5 Jan is 02:30 on 6 Jan in Karachi (UTC+5).
		mem.journal("note", "late", Date.UTC(2026, 0, 5, 21, 30));
		expect(mem.journalFor("2026-01-05")).toBe("");
		expect(mem.journalFor("2026-01-06")).toBe("# 2026-01-06\n\n- 02:30 [note] late\n");
	});

	it("cuts very long entries", () => {
		mem.journal("note", "x".repeat(5000), Date.UTC(2026, 0, 5, 0, 0));
		const line = mem.journalFor("2026-01-05").split("\n")[2];
		expect(line).toBe(`- 00:00 [note] ${"x".repeat(1000)}`);
	});

	it("journalFor a day without entries is empty", () => {
		expect(mem.journalFor("1999-01-01")).toBe("");
	});
});

describe("search", () => {
	it("finds terms across MEMORY.md, journal and notes", () => {
		mem.remember("Passport renewal due in March");
		mem.journal("note", "called about the passport", Date.UTC(2026, 0, 5, 10, 0));
		writeFileSync(join(dir, "notes", "travel.md"), "# Travel\n\nPassport number is in the safe.\n");
		const files = new Set(mem.search("passport").map((h) => h.file));
		expect(files).toEqual(new Set(["MEMORY.md", join("journal", "2026-01-05.md"), join("notes", "travel.md")]));
	});

	it("ranks an exact phrase above scattered terms", () => {
		writeFileSync(join(dir, "notes", "a.md"), "green things\n\n\n\n\nalso some tea\n");
		writeFileSync(join(dir, "notes", "b.md"), "\n\n\n\nShe drinks green tea every morning\n");
		const hits = mem.search("green tea");
		expect(hits[0].file).toBe(join("notes", "b.md"));
		expect(hits[0].text).toBe("She drinks green tea every morning");
		expect(hits[0].line).toBe(5);
		const scattered = hits.filter((h) => h.file === join("notes", "a.md"));
		expect(scattered.length).toBeGreaterThan(0);
		for (const h of scattered) expect(h.score).toBeLessThan(hits[0].score);
	});

	it("prefers curated memory over the journal for equal matches", () => {
		mem.journal("note", "dentist appointment booked", Date.UTC(2026, 0, 5, 10, 0));
		writeFileSync(join(dir, "notes", "health.md"), "dentist appointment booked\n");
		const hits = mem.search("dentist appointment");
		expect(hits[0].file).toBe(join("notes", "health.md"));
		expect(hits[0].score).toBeGreaterThan(hits.find((h) => h.file.startsWith("journal"))!.score);
	});

	it("ignores stop words, short words and hidden files, and respects the limit", () => {
		writeFileSync(join(dir, ".secret.md"), "zebra zebra\n");
		writeFileSync(join(dir, "notes", "z.md"), Array.from({ length: 20 }, (_, i) => `zebra ${i}`).join("\n\n\n\n"));
		expect(mem.search("the a of")).toEqual([]);
		expect(mem.search("")).toEqual([]);
		const hits = mem.search("zebra", 5);
		expect(hits).toHaveLength(5);
		expect(hits.every((h) => h.file === join("notes", "z.md"))).toBe(true);
	});

	it("returns nothing when no term matches", () => {
		expect(mem.search("xylophone")).toEqual([]);
	});
});

describe("core", () => {
	it("returns MEMORY.md as is under the cap", () => {
		expect(mem.core()).toBe(file());
	});

	it("returns exactly the cap when the file is exactly the cap", () => {
		writeFileSync(mem.memoryPath, "y".repeat(MEMORY_CAP_CHARS));
		expect(mem.core()).toBe("y".repeat(MEMORY_CAP_CHARS));
	});

	it("cuts at MEMORY_CAP_CHARS with a note when too long", () => {
		const big = `# Memory\n${"z".repeat(MEMORY_CAP_CHARS * 2)}`;
		writeFileSync(mem.memoryPath, big);
		const c = mem.core();
		expect(c.startsWith(big.slice(0, MEMORY_CAP_CHARS))).toBe(true);
		expect(c.slice(MEMORY_CAP_CHARS)).toMatch(/^\n\n\[MEMORY\.md is over 8000 chars; the rest is cut\. Consolidate it\.\]$/);
		expect(c.length).toBeLessThan(MEMORY_CAP_CHARS + 200);
	});
});
