// An optional sandbox for the agent's shell: bubblewrap runs every bash command with a read-only
// root, vigil's own state hidden, SSH and GPG keys hidden, and only the session's own directories
// writable. This turns the gate's credential rules from regexes on command text into a real
// boundary. Network stays on: workers need it, and outward actions still go through approvals.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BashSpawnHook } from "@earendil-works/pi-coding-agent";

export type SandboxMode = "auto" | "bwrap" | "off";

let probed: boolean | undefined;

/** Whether bubblewrap is installed and can create a sandbox here (user namespaces allowed). */
export function bwrapWorks(): boolean {
	if (probed !== undefined) return probed;
	try {
		execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "--", "true"], { stdio: "ignore", timeout: 5000 });
		probed = true;
	} catch {
		probed = false;
	}
	return probed;
}

export function sandboxEnabled(mode: SandboxMode): boolean {
	if (mode === "off") return false;
	if (mode === "bwrap") {
		if (!bwrapWorks()) throw new Error("sandbox is set to bwrap, but bubblewrap is missing or cannot create namespaces here");
		return true;
	}
	return bwrapWorks();
}

/** Quote a string for a POSIX shell. */
export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface SandboxSpec {
	/** vigil's home: hidden, except the writable directories below that live inside it. */
	home: string;
	/** Directories the command may write (the session's cwd, /tmp, vigil's work dirs). */
	writable: string[];
	/** Directories that stay visible but read-only although they are inside the hidden home. */
	readable?: string[];
}

/** The bubblewrap arguments for a spec, in mount order (later mounts cover earlier ones). */
export function bwrapArgs(spec: SandboxSpec, cwd: string): string[] {
	const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--unshare-ipc", "--die-with-parent"];
	const hide = [spec.home, join(homedir(), ".ssh"), join(homedir(), ".gnupg"), join(homedir(), ".pi")].filter(existsSync);
	const under = (p: string) => hide.some((h) => p === h || p.startsWith(`${h}/`));
	// 1. Writable places outside the hidden ones (such as /tmp, which may contain vigil's home).
	for (const w of spec.writable) if (existsSync(w) && !under(w)) args.push("--bind", w, w);
	// 2. Hide, after those binds, so a writable parent cannot expose a hidden child.
	for (const h of hide) args.push("--tmpfs", h);
	// 3. Re-expose what the agent may see or write inside the hidden places.
	for (const r of spec.readable ?? []) if (existsSync(r) && under(r)) args.push("--ro-bind", r, r);
	for (const w of spec.writable) if (existsSync(w) && under(w)) args.push("--bind", w, w);
	args.push("--chdir", cwd);
	return args;
}

/** A pi bash spawn hook that runs each command inside the sandbox. */
export function sandboxHook(spec: SandboxSpec): BashSpawnHook {
	return (ctx) => {
		// The session's own directory is writable, unless it is vigil's home itself (the concierge).
		const writable = [...new Set([...spec.writable, ...(ctx.cwd === spec.home ? [] : [ctx.cwd])])];
		const args = bwrapArgs({ ...spec, writable }, ctx.cwd);
		return { ...ctx, command: `bwrap ${args.map(shq).join(" ")} -- bash -c ${shq(ctx.command)}` };
	};
}
