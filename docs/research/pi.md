I could not create `/home/user/refs/REPORT-pi.md`: the harness blocked writing a report file from a subagent. The full report is below so you can save it to that path; nothing was written there.

**Summary of the most important findings**
1. **Two harnesses.** `pi-coding-agent`'s `AgentSession` SDK is the stable one: JSONL sessions, extensions, skills, OAuth in `auth.json`, RPC. `@earendil-works/pi-durable` 1.5.0 is published but marked "Experimental": crash-safe storage, durable `sleepUntil` timers, background subagents, and its own extension API that cannot load pi extensions or packages.
2. **Versions on npm.** All `@earendil-works` packages are at `latest` 1.5.0 (2026-11-02): pi-ai, pi-agent-core, pi-coding-agent, pi-tui, pi-mcp, pi-codemode, pi-schema, pi-telemetry, pi-durable, pi-env. Chord is published as `@earendil-works/chord` (not `pi-chord`). Releases come about weekly, and minor versions contain breaking changes, so pin exact versions.
3. **SDK basics.** `createAgentSession({cwd, agentDir, modelRuntime, model, thinkingLevel, customTools, resourceLoader, sessionManager, settingsManager})`, then `session.subscribe`, `prompt`, `steer`, `followUp`, `sendCustomMessage(..., {triggerTurn})`, `compact`. Treat `agent_settled` as "done", not `agent_end`. My probe at `/home/user/refs/sdk-probe/src/probe.ts` typechecks against the published 1.5.0 types and runs as far as the model call.
4. **Two SDK traps.** Extensions' `session_start` handlers never run unless you call `session.bindExtensions({...})`; you can pass your own `uiContext` there to route extension dialogs to chat. And passing `agentDir` does not move sessions: they still go to `~/.pi/agent/sessions/--<cwd>--/` unless you give `SessionManager` a `sessionDir` or set `PI_CODING_AGENT_DIR`.
5. **ChatGPT subscription.** Provider `openai-codex` ("OpenAI Codex (legacy)", chatgpt.com/backend-api) supports **device-code login for headless servers**. Programmatically: `modelRuntime.login("openai-codex","oauth",{prompt:p=>"device_code", notify})`, and the user opens auth.openai.com/codex/device. The newer `openai` provider's "Sign in with ChatGPT" is browser-only, though you can paste the redirect URL back. Bundled Codex models: gpt-5.6-luna/sol/terra, gpt-6-astra/luna/sol, gpt-6.1-sol/terra (500K context).
6. **OpenCode Go.** Provider `opencode-go`, API key only (`OPENCODE_API_KEY` or an `auth.json` `api_key` entry), base URL `opencode.ai/inference/go/...`. Models include kimi-k3, glm-5.3, deepseek-v4-pro and qwen3.8-max.
7. **Auth file.** `~/.pi/agent/auth.json`, one entry per provider, e.g. `{"openai-codex":{"type":"oauth","access","refresh","expires","accountId"}}`. It is lock-protected, and `"key":"!cmd"` fetches a key from a secret manager. There is no `pi auth login` and no RPC login; `pi auth check --json` verifies readiness.
8. **RPC and JSON modes.** JSONL on stdin/stdout. A `prompt` success means accepted, not finished, so wait for `agent_settled`. Never split the stream with Node `readline`. `RpcClient` is exported.
9. **Extensions.** Loaded with jiti, so no build step. About 40 hook events: `tool_call` can block, `before_agent_start` can rewrite the system prompt, `context` can filter messages, `agent_before_settle` can request a continuation. Packages install via npm or git.
10. **Skills.** Pi implements the Agent Skills `SKILL.md` spec. It discovers `~/.pi/agent/skills`, `.pi/skills` and `~/.agents/skills`, but not `~/.claude/skills`.
11. **pi-chat is Discord + Telegram, not Slack.** It is a pi extension: one pi process per channel in tmux, a Gondolin VM sandbox per channel, a JSONL job log with resume cursor, `memory.md` injection, and an encrypted secret exchange. Its `LiveConnection` adapter interface is reusable for new channels.
12. **OpenClaw no longer uses pi as its runtime.** "pi" is now a deprecated alias for its built-in `openclaw` runtime; only pi-tui remains as a dependency. Worth borrowing: one gateway daemon, a plugin per channel (baileys for WhatsApp, grammy for Telegram, bolt for Slack), DM pairing, and heartbeats replaced by scheduled automation jobs.
13. **Examples.** There is a subagent example (spawns `pi --mode json -p` child processes) and a plan-mode example. There is no cron example; the closest are `file-trigger.ts` and pi-durable's `sleepUntil` reminder.
14. **Other gotchas.** Node ≥ 22.19, ESM only, TypeScript needs `skipLibCheck: true`. The SDK does not load codemode, tool_search or MCP automatically. Non-interactive runs skip project `.pi` resources unless `defaultProjectTrust` is `"always"`. Use `PI_OFFLINE` and `PI_TELEMETRY=0` to stop network calls. Pi has no permission system, so sandbox it.
15. **My recommendation.** Build vigil on the coding-agent SDK with N sessions in one process, write the scheduler and job store in vigil itself, reuse pi-chat's adapter interfaces, and treat pi-durable as a later option.

Other files: probe code is in `/home/user/refs/sdk-probe/src/probe.ts`, with a `tsconfig.json` beside it. Reference clones are `/home/user/refs/pi-chat` and `/home/user/refs/openclaw`. I created a `~/.pi` directory while running the probe and then deleted it.

---

# pi agent harness: engineering report for vigil

Research date: 2026-11-04. Sources:
- `/home/user/refs/pi`: monorepo at commit `707888e` (2026-11-04). All packages are at `1.5.0` with an `[Unreleased]` changelog section, so the checkout is slightly ahead of npm.
- `/home/user/refs/sdk-probe`: `npm i @earendil-works/pi-coding-agent --ignore-scripts`, which installed `1.5.0`. The probe example (`src/probe.ts`) **typechecks** with TS 5.9.3 and runs as far as the model call.
- `/home/user/refs/pi-chat`: `earendil-works/pi-chat` at `9adbd29`.
- `/home/user/refs/openclaw`: `openclaw/openclaw` at `dc13ca6`, cloned shallow. The GitHub API refused access to it, but `git clone` worked.

Labels: **[verified]** means I ran it or read it in source. **[doc]** means it is stated in the docs but I did not exercise it. **[unverified]** means it is my inference.

---

## 1. Architecture and published packages

### 1.1 Packages (monorepo `packages/*`, all `"type": "module"`, `engines.node >= 22.19.0`)

| Dir | npm name | npm `latest` | Role |
|---|---|---|---|
| `packages/ai` | `@earendil-works/pi-ai` | 1.5.0 (`legacy-node20`: 0.74.2) | Multi-provider LLM API: providers, OAuth flows, model catalog, credential store |
| `packages/agent` | `@earendil-works/pi-agent-core` | 1.5.0 (`legacy-node20`: 0.74.2) | `Agent` class plus the agent loop (tool calling, state, events). Built on pi-ai |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | 1.5.0 (`legacy-node20`: 0.74.2) | The `pi` CLI and the **SDK** (`createAgentSession`), sessions, extensions, skills, RPC/JSON modes |
| `packages/tui` | `@earendil-works/pi-tui` | 1.5.0 | Terminal UI library |
| `packages/mcp` | `@earendil-works/pi-mcp` | 1.5.0 | Standalone MCP client (stdio and Streamable HTTP). No deps on the official SDK |
| `packages/codemode` | `@earendil-works/pi-codemode` | 1.5.0 | QuickJS/WASM sandbox where model-written JS calls tools (`CodemodeSandbox`) |
| `packages/schema` | `@earendil-works/pi-schema` | 1.5.0 | JSON Schema builders and an eval-free validator. Tool args are validated with it as of 1.5.0 |
| `packages/telemetry` | `@earendil-works/pi-telemetry` | 1.5.0 | Vendor-neutral spans and metrics contracts |
| `packages/durable` | `@earendil-works/pi-durable` | **1.5.0 (published)**, marked "Experimental" | A *separate* durable agent harness: crash-safe conversations, tasks, sleeps, subagents |
| `packages/chord` | `@earendil-works/chord` (**not** `pi-chord`) | 1.5.0 | Object runtime across processes: contracts, documents, store, plugins with hot reload, HTTP, workers |
| `packages/env` | `@earendil-works/pi-env` | 1.5.0 | Remote `ExecutionEnv` for pi-durable. Deploys a Rust daemon over SSH |
| `packages/evals` | `@earendil-works/pi-evals` | private | Evals |
| `apps/p2` | `p2` | private | Prototype web UI on durable and chord. README: "It will be gone soon … Do not build on it" |

Other relevant npm packages under the scope: `@earendil-works/gondolin` 0.14.0 (micro-VM sandbox, used by pi-chat), `pi-web-ui` 0.75.3, `pi-protocol` 1.1.0, `pi-client` 1.1.0, and `pi-session-backend-sqlite-node` 0.99.2. I did not inspect the last four. `@mariozechner/pi-coding-agent` (0.73.1) is **deprecated** in favour of `@earendil-works/*`.

Release cadence (npm `time`): 1.0.4 on 10-05, 1.1.0 on 10-07, 1.2.0 on 10-12, 1.3.0 on 10-15, 1.4.0 on 10-21, 1.5.0 on 11-02. That is roughly weekly, and **minor versions contain breaking changes**: 1.5.0 changed tool-argument validation, for example. Pin exact versions.

### 1.2 Dependency graph

```
pi-coding-agent ──► pi-agent-core ──► pi-ai ──► pi-schema, pi-telemetry
        ├──► pi-tui, pi-mcp, pi-codemode            (published deps of 1.5.0, verified in node_modules)
        └── NOT durable / chord / env
pi-durable ──► chord, pi-ai, pi-codemode, pi-schema, pi-telemetry   (independent harness, own extension API)
pi-env ──► pi-durable
apps/p2 ──► durable + chord (prototype)
```

The important consequence for vigil is that **there are two harnesses**:
1. **coding-agent's `AgentSession`**. This is mature. It has JSONL sessions, the extension API, skills, packages, RPC, and `auth.json` OAuth.
2. **pi-durable's `Harness`**. This is experimental. It has SQLite/JSONL storage, crash recovery, durable sleeps and timers, and task graphs. Its extension and tool model (`defineExtension`, `defineTool` from pi-durable) is different and does **not** load pi-coding-agent extensions or packages.

---

## 2. TypeScript SDK (`@earendil-works/pi-coding-agent`)

Docs: `packages/coding-agent/docs/sdk.md`. Examples: `packages/coding-agent/examples/sdk/01..14-*.ts`. Main source: `src/core/sdk.ts`, `src/core/agent-session.ts`, `src/core/session-manager.ts`, `src/core/model-runtime.ts`.

### 2.1 Key exports (verified in `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`)

- Session factory: `createAgentSession`, `createAgentSessionServices`, `createAgentSessionFromServices`, `createAgentSessionRuntime`, and `AgentSessionRuntime` (new, switch, fork, import).
- State: `AgentSession`, `SessionManager`, `SettingsManager`, `ModelRuntime`, `ModelRegistry`, `DefaultResourceLoader`, `ResourceLoader`, `getAgentDir`.
- Tools: `defineTool`, `createReadTool`, `createBashTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, `createLsTool`, `createCodingTools`, `createReadOnlyTools`, `create*ToolDefinition`, and `withFileMutationQueue`.
- Extensions: types `ExtensionAPI`, `ExtensionFactory`, `InlineExtension`, `ToolDefinition`; functions `createExtensionRuntime`, `discoverAndLoadExtensions`.
- Built-in extensions (not auto-loaded in SDK sessions): `createCodemodeExtension`, `createToolSearchExtension`, `createMcpExtension`.
- Modes: `RpcClient`, `runRpcMode`, `runPrintMode`, `main`, `InteractiveMode`, type `JsonAgentSessionEvent`.
- Compaction utilities: `compact`, `shouldCompact`, `estimateTokens`, `generateSummary`, and others.
- Skills: `loadSkills`, `loadSkillsFromDir`, `formatSkillsForPrompt`.
- Auth helper: `readStoredCredential(providerId, authPath?)`.
- The package also has a `./rpc-entry` export (the bundled RPC entry).

`CreateAgentSessionOptions` (from `dist/core/sdk.d.ts`):
```ts
cwd?, agentDir?, modelRuntime?, model?, thinkingLevel?, scopedModels?,
noTools?: "all" | "builtin", tools?: string[], excludeTools?: string[],
customTools?: ToolDefinition[], resourceLoader?, sessionManager?, settingsManager?, sessionStartEvent?
// returns { session, extensionsResult, modelFallbackMessage? }
```

Main `AgentSession` methods (from `dist/core/agent-session.d.ts`):
- Prompting and queues: `prompt(text, {images, streamingBehavior, expandPromptTemplates, source})`, `steer()`, `followUp()`, `sendUserMessage()`, `sendCustomMessage(msg, {triggerTurn, deliverAs})`, `clearQueue()`, `abort()`, `waitForIdle()`.
- Events: `subscribe(listener)`. Extension wiring: `bindExtensions(bindings)`. Teardown: `dispose()`.
- Model and thinking: `setModel()`, `cycleModel()`, `setThinkingLevel()`.
- Compaction: `compact(customInstructions?)`, `setAutoCompactionEnabled()`. Retries: `setAutoRetryEnabled()`.
- Tools: `setActiveToolsByName()`, `getAllTools()`.
- Shell: `executeBash()`.
- Session tree: `navigateTree()`, `setSessionName()`.
- Introspection: `getSessionStats()`, `getContextUsage()`, `getLastAssistantText()`.
- Getters: `messages`, `model`, `isStreaming`, `isIdle`, `sessionFile`, `sessionId`, `systemPrompt`.

### 2.2 Semantics that matter for a daemon

- `prompt()` resolves when the run finishes, including retries. If the session is already streaming, `prompt()` **rejects** unless you pass `streamingBehavior: "steer" | "followUp"` [doc, sdk.md].
- `agent_end` does **not** mean the session is idle. Retries, compaction, and queued follow-ups can come after it. Use the **`agent_settled`** event (`{aborted}`) as the "Pi will not continue" signal [doc].
- `message_end` carries the authoritative message. `message_update` is the streaming delta (`event.assistantMessageEvent.type === "text_delta"`).
- **`session.bindExtensions({...})` must be called for extensions' `session_start` handlers to run.** The CLI modes call it (`modes/print-mode.ts:83`, `modes/rpc/rpc-mode.ts:323`). `createAgentSession()` does not. Source, `agent-session.ts:3380`:
  ```ts
  async bindExtensions(bindings: ExtensionBindings): Promise<void> {
      ...
      this._applyExtensionBindings(this._extensionRunner);
      await this._extensionRunner.emit(this._sessionStartEvent);
  ```
  `ExtensionBindings = { uiContext?, mode?, commandContextActions?, abortHandler?, shutdownHandler?, onError? }`. The default mode is `"print"` (`agent-session.ts:478`). `ctx.hasUI` is `uiContext !== noOpUIContext` (`extensions/runner.ts:628`). **A vigil host can supply its own `ExtensionUIContext`** (`select`, `confirm`, `input`, `notify`, `setStatus`, …), so that extension approval dialogs are routed to Telegram or Discord.
- Multiple `AgentSession`s can run in one process. Docs mention "in-process subagents", and `PI_CODEMODE_MAX_WORKERS` defaults to 2 [doc].
- After `AgentSessionRuntime.newSession()`, `switchSession()`, or `fork()`, subscriptions belong to the old session. Re-subscribe and re-run `bindExtensions` (example `13-session-runtime.ts`).

### 2.3 Custom tools

There are two routes:
- `customTools: [defineTool({...})]` passed to `createAgentSession`. No extension file is needed [verified, typechecks].
- `pi.registerTool()` inside an extension. This can also be called at runtime, for example in `session_start` or a command handler.

Tool shape (`docs/extensions.md` "Tool Definition"):
```ts
pi.registerTool({
  name: "my_tool", label: "My Tool", description: "What this tool does (shown to LLM)",
  promptSnippet: "...", promptGuidelines: ["Use my_tool when ..."],
  parameters: Type.Object({ action: StringEnum(["list","add"] as const), text: Type.Optional(Type.String()) }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [{ type: "text", text: "Done" }], details: { /* persisted, used for state reconstruction */ } };
  },
});
```
- Schemas are validated as plain JSON Schema by pi-schema, with coercion (numeric strings become numbers, and so on). `Type.Refine`, codecs, and custom `Format.Set` are **ignored** as of 1.5.0.
- Tools run in parallel by default. File-mutating tools should wrap their work in `withFileMutationQueue(absPath, fn)`.
- Store state in the result's `details` and rebuild it from `ctx.sessionManager.getBranch()` on `session_start` and `session_tree`.

### 2.4 Model and provider selection

```ts
const modelRuntime = await ModelRuntime.create({ authPath, modelsPath });   // defaults: <agentDir>/auth.json, models.json
modelRuntime.getModel("openai-codex", "gpt-6.1-terra");     // Model | undefined (no auth check)
await modelRuntime.getAvailable();                           // models that have usable credentials
await modelRuntime.setRuntimeApiKey("anthropic", key);       // non-persistent override
await modelRuntime.login(providerId, "oauth" | "api_key", interaction, { getDeviceId?, agentName? });
await modelRuntime.logout(providerId);
```
- You can pass `model` and `thinkingLevel` (`off|minimal|low|medium|high|xhigh|max`) to `createAgentSession`. You can also call `session.setModel()` later.
- Settings `defaultProvider` and `defaultModel` live in `settings.json`.

### 2.5 Extensions, skills, and resources in the SDK

```ts
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir,
  additionalExtensionPaths: ["./ext.ts", "builtin:mcp"],
  extensionFactories: [(pi) => { pi.on("agent_settled", ...) }],   // inline extensions
});
await resourceLoader.reload();   // must be called before createAgentSession
```
- Without overrides, `DefaultResourceLoader` discovers the following:
  - extensions from `<agentDir>/extensions` and `.pi/extensions`;
  - skills from `<agentDir>/skills`, `.pi/skills`, `~/.agents/skills`, and `.agents/skills`;
  - prompts, themes, settings `packages` and `extensions`;
  - context files (`AGENTS.md` and `CLAUDE.md`, walking up from cwd);
  - `SYSTEM.md` and `APPEND_SYSTEM.md`.
- To control discovery completely, implement the `ResourceLoader` interface (example `12-full-control.ts`). It needs `getExtensions`, `getSkills`, `getPrompts`, `getThemes`, `getAgentsFiles`, `getSystemPrompt`, `getAppendSystemPrompt`, `extendResources`, `reload`, and a few more.
- **The SDK does not load the CLI's built-in `codemode`, `tool_search`, or MCP extensions.** Add `createMcpExtension()` and the others via `extensionFactories`, then call `bindExtensions()`, because MCP connects on `session_start` (sdk.md, example `14-codemode-mcp.ts`).

### 2.6 Session persistence

- Format: JSONL tree. Each entry has `id`, `parentId`, `timestamp`. The header looks like `{"type":"session","version":3,"id","timestamp","cwd"}`. See `docs/session-format.md`.
- Default location: `~/.pi/agent/sessions/--<cwd with / \ : replaced by ->--/<timestamp>_<session-id>.jsonl` (`session-manager.ts:588-598`). It can be overridden with `PI_CODING_AGENT_SESSION_DIR`, `--session-dir`, or the `sessionDir` setting.
- The file is written **lazily**. I verified that only the directory exists before the first assistant message.
- `SessionManager` statics (d.ts):
  - `create(cwd, sessionDir?, opts?)`
  - `open(path, sessionDir?, cwdOverride?)`
  - `continueRecent(cwd, sessionDir?)`
  - `inMemory(cwd?, opts?, entries?)`
  - `forkFrom(src, targetCwd, sessionDir?)`
  - `findById(cwd, id, sessionDir?)`
  - `list(cwd, sessionDir?)`
  - `listAll(sessionDir?)`
- `NewSessionOptions` lets the caller supply an ID (the CLI equivalent is `--session-id`, which accepts `[A-Za-z0-9._-]`). A stable key per chat channel, such as `telegram-12345`, fits this well [doc: cli.md].
- `SessionManager` is the source of truth for context. Assigning `session.agent.state.messages` does **not** change what is persisted [doc].
- **Gotcha [verified]:** passing `agentDir` to `createAgentSession` does **not** move sessions. `SessionManager.create/continueRecent(cwd)` without `sessionDir` uses `getDefaultAgentDir()`, which is `PI_CODING_AGENT_DIR` or else `~/.pi/agent`. Pass `sessionDir` explicitly, or set `PI_CODING_AGENT_DIR`.

### 2.7 Compaction

- Auto-compaction triggers when `contextTokens > contextWindow - reserveTokens`. Defaults: `reserveTokens` 16384, `keepRecentTokens` 20000 (`docs/compaction.md`).
- Settings: `compaction: {enabled, reserveTokens, keepRecentTokens, modelOverrides: {"provider/model": {...}}}`.
- Reasons are `"manual" | "threshold" | "overflow"`. On overflow, Pi compacts and retries the prompt.
- Manual: `session.compact(instructions?)`, or RPC `{"type":"compact"}`.
- Extension hooks:
  - `session_before_compact` can return `{cancel:true}` or `{compaction:{summary, firstKeptEntryId, tokensBefore}}`. This allows a custom summarizer, which is useful for writing long-term memory before history is cut.
  - `session_compact` and `session_compact_failed` report the outcome.
- Example: `examples/extensions/custom-compaction.ts`.
- The original entries are never deleted; compaction adds a summary entry.

### 2.8 Minimal working example (typechecked against the published 1.5.0 `.d.ts`)

File: `/home/user/refs/sdk-probe/src/probe.ts`. Test results:
- `npx tsc -p .` passes. This needs `skipLibCheck: true`; see Gotchas.
- `node src/probe.ts` runs up to `prompt()` and then throws `No API key found for openai-codex`. That error is expected because no credentials were configured.

```ts
import { type AgentSessionEvent, createAgentSession, DefaultResourceLoader, defineTool, getAgentDir,
  ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";   // typebox 1.x ships as a dependency of pi-coding-agent

const agentDir = process.env.VIGIL_AGENT_DIR ?? getAgentDir();
const cwd = process.env.VIGIL_WORKSPACE ?? process.cwd();
const modelRuntime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });

if (process.argv.includes("--login-codex")) {             // headless device-code login (see §5)
  await modelRuntime.login("openai-codex", "oauth", {
    prompt: async (p) => (p.type === "select" ? "device_code" : ""),
    notify: (e) => { if (e.type === "device_code") console.error(`Open ${e.verificationUri} and enter ${e.userCode}`); },
  });
}
const model = modelRuntime.getModel("openai-codex", "gpt-6.1-terra") ?? modelRuntime.getModel("opencode-go", "kimi-k3");
if (!model) throw new Error("model not found");

const remember = defineTool({
  name: "remember", label: "Remember", description: "Store a durable fact in vigil memory",
  parameters: Type.Object({ fact: Type.String() }),
  async execute(_id, params) { return { content: [{ type: "text", text: `stored: ${params.fact}` }], details: { fact: params.fact } }; },
});

const resourceLoader = new DefaultResourceLoader({ cwd, agentDir,
  extensionFactories: [(pi) => { pi.on("agent_settled", async (e) => console.error("[settled]", e.aborted)); }] });
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd, agentDir, modelRuntime, model, thinkingLevel: "medium", customTools: [remember], resourceLoader,
  sessionManager: SessionManager.continueRecent(cwd, `${agentDir}/sessions`),   // pass sessionDir explicitly!
  settingsManager: SettingsManager.create(cwd, agentDir),
});
await session.bindExtensions({});                           // fires session_start
const off = session.subscribe((ev: AgentSessionEvent) => {
  if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") process.stdout.write(ev.assistantMessageEvent.delta);
});
try { await session.prompt("Say hi and remember that my name is Ada."); console.log(session.getLastAssistantText()); }
finally { off(); session.dispose(); }
```

For proactive and scheduled triggers from host code, use one of these:
- `session.sendCustomMessage({customType:"vigil-cron", content:"...", display:true}, {triggerTurn:true})`
- `session.prompt(text, {streamingBehavior:"followUp"})` when the session may be busy.

---

## 3. RPC, print, and JSON modes

Docs: `cli.md`, `cli-integration.md`, `rpc.md`, `rpc-commands.md`, `json.md`, `rpc-extension-ui.md`. Types: `src/modes/rpc/rpc-types.ts`. Client: `src/modes/rpc/rpc-client.ts`.

### Modes overview

| Mode | Invocation | Notes |
|---|---|---|
| Print | `pi -p "..."` (also chosen automatically when stdin or stdout is not a TTY) | Final text on stdout. Nonzero exit on `error`/`aborted`/`length` stop reasons |
| JSON | `pi --mode json "..."` | JSONL: a session header, then events. One-shot. A failed response does **not** set a nonzero exit code |
| RPC | `pi --mode rpc [--no-session]` | Long-lived. JSONL commands on stdin, responses and events on stdout. `@file` arguments are rejected |

Useful flags:
- Model: `--provider`, `--model provider/id:thinking`, `--thinking`, `--api-key`.
- Sessions: `--session <path|id>`, `--session-id <id>` (opens or creates), `-c/--continue`, `--fork`, `--session-dir`, `--no-session`, `-n`.
- Tools: `-t/--tools read,bash` or `+codemode,-write`, `-xt`, `-nt`.
- Resources: `-e <ext|npm:pkg|builtin:mcp>`, `-ne`, `--skill`, `-ns`, `--no-mcp`, `-nc`.
- Prompts: `--system-prompt`, `--append-system-prompt`.
- Trust: `-a/--approve` trusts the project.
- Network: `--offline`.

Other subcommands:
- `pi auth check|print-api-key|print-bearer-token --provider X [--json]`
- `pi mcp add|list|login|logout`
- `pi install|remove|update|list|config`

### RPC protocol

- Commands are `{"id"?, "type": ...}`. Responses are `{"id","type":"response","command","success","data"|"error"}`. Unparseable input produces `{"type":"response","command":"parse","success":false}`.
- `prompt` returns `data.disposition` = `"started" | "queued" | "handled"`. **Success means accepted, not completed.** Wait for the `agent_settled` event. While the agent is streaming, `prompt` needs `streamingBehavior: "steer"|"followUp"`.
- Commands: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`.
- **There is no `login` command.** Auth has to exist beforehand (see §5).
- Events are the same shapes as JSON mode:
  - lifecycle: `agent_start`, `agent_end{messages,willRetry}`, `agent_settled{aborted}`, `turn_start`, `turn_end`;
  - messages: `message_start`, `message_update{usage, assistantMessageEvent}` (delta-only, with `partial` stripped), `message_end`;
  - tools: `tool_execution_start|update|end{durationMs}`;
  - state: `queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed`;
  - compaction and retry: `compaction_start|end`, `auto_retry_start|end`, `summarization_retry_*`;
  - RPC-only: `bash_execution_update` and `extension_error`.
- Extension UI subprotocol:
  - Pi sends `extension_ui_request` with method `select|confirm|input|editor`, and the client answers with `extension_ui_response` using the same id.
  - Fire-and-forget methods: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.
- Framing: split on LF only. **Do not use Node `readline`**, because it also splits on U+2028/U+2029, which are valid inside JSON strings.
- Shutdown: close stdin, or send SIGTERM or SIGHUP. Both together are safe. A second signal exits immediately. An extension can call `ctx.shutdown()`.
- `RpcClient({cliPath, cwd, env, provider, model, args})` provides `start()`, `onEvent()`, `promptAndWait()`, and `stop()` (`examples/rpc-client.ts`).
- Child processes run by the `bash` tool get `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`. The CLI and RPC entry points set `AI_AGENT=pi` and `PI_CODING_AGENT=true`. **The SDK does not set these** [doc].

---

## 4. Extensions, packages, and skills

### 4.1 Loading

- An extension is a TS or JS module with `export default function (pi: ExtensionAPI) {}`. The factory may be async, and Pi awaits it. Modules are loaded with **jiti**, so no build step is needed.
- Locations:
  - `~/.pi/agent/extensions/*.ts`
  - `*/index.ts`
  - `*/package.json` with a `pi.extensions` field
  - `.pi/extensions/...` (project-local; requires project trust)
  - settings `extensions: [paths]` and `packages: ["npm:@x/y@1.0.0", "git:github.com/u/r@v1"]`
  - `-e` on the CLI
  - `builtin:<name>`
- Pi maps imports of `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, and `typebox` (and the legacy `@mariozechner/*` and `@sinclair/typebox` names) to its own copies. Packages should list these as `peerDependencies: "*"`, never as `dependencies`.
- **Do not start timers, sockets, or watchers in the factory.** Start them in `session_start` and close them in `session_shutdown` (extensions.md "Long-lived resources and shutdown").

### 4.2 Events (`pi.on(name, handler)`)

**Startup and resources**
- `project_trust`
- `resources_discover`: can add skill, prompt, and theme paths.
- `mcp_servers_change`

**Session**
- `session_start{reason: startup|reload|new|resume|fork}`
- `session_info_changed`
- `session_before_switch`, `session_before_fork`: can cancel.
- `session_before_compact`, `session_compact`, `session_compact_failed`
- `session_before_tree`, `session_tree`
- `session_shutdown{reason}`

**Agent**
- `before_agent_start`: can inject a message and/or rewrite the system prompt through `systemPromptOptions.sections`.
- `agent_start`, `agent_end`
- `agent_before_settle`: can append entries and request `continue: true`, which supports self-continuation loops.
- `agent_settled`
- `turn_start`, `turn_end`: can append entries and request continuation.
- `message_start`, `message_update`, `message_end`: `message_end` handlers chain transforms.
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `ui_prompt_start`, `ui_prompt_end`

**Provider and model**
- `context`: rewrite the messages sent to the model.
- `context_with_system`
- `before_provider_headers`
- `before_provider_request`: replace the payload.
- `after_provider_response`
- `provider_stream_event`
- `cache_warming_decision`
- `model_select`, `thinking_level_select`

**Tools and input**
- `tool_call`: return `{block:true, reason}` or mutate `event.input`. Narrow the type with `isToolCallEventType("bash", e)`.
- `tool_result`: rewrite the result.
- `user_bash`
- `input`: intercept, transform, or handle user input.

### 4.3 `ExtensionAPI` methods

- Registration:
  - `registerTool`, `registerCommand(name, {description, handler(args, ctx)})`, `registerShortcut`, `registerFlag`
  - `registerProvider(name, config)` with OAuth or dynamic `refreshModels`; `unregisterProvider`
  - `registerVirtualModel`, a model router (e.g. `openai-codex/auto`); see `examples/extensions/jev-router.ts`
  - `registerMcpServer`
  - renderers and Markdown transformers
- Messaging:
  - `sendMessage(custom, {triggerTurn, deliverAs: steer|followUp|nextTurn})`
  - `sendUserMessage(content, {deliverAs, expandPromptTemplates})`
  - `appendEntry(customType, data)`: persisted but **not** sent to the LLM.
- Session: `setSessionName`, `setLabel`.
- Tools and model: `getActiveTools`, `getAllTools`, `setActiveTools`, `setModel`, `setThinkingLevel`.
- Utilities: `exec(cmd, args)`, `events` (an inter-extension bus; see `createEventBus`), `getSettings`.

`ctx` (`ExtensionContext`) provides:
- `ui`, `mode` (`tui|rpc|json|print`), `hasUI`, `cwd`
- `sessionManager`, `modelRegistry`, `model`
- `signal`, `isIdle()`, `abort()`, `shutdown()`
- `getContextUsage()`, `compact()`, `getSystemPrompt()`

Command contexts also get `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, and `reload`.

UI per mode:
- RPC: dialogs work.
- JSON and print: `hasUI = false`, and the UI is a no-op.

### 4.4 Packages (`docs/packages.md`)

- Install with `pi install npm:@x/y@1.0.0 | git:github.com/u/r@v1 | ./local`. Personal installs are written to `~/.pi/agent/settings.json`; `-l` writes to the project's `.pi/settings.json`.
- Manifest: `package.json` `"pi": {extensions, skills, prompts, themes, changelogPath}`, with the `"pi-package"` keyword for the gallery. Without a manifest, Pi uses the conventional dirs `extensions/`, `skills/`, `prompts/`, and `themes/`.
- Settings can filter what loads from a package: `{source, extensions:["!x"], skills:[]}`.

### 4.5 Skills (`docs/skills.md`)

- The docs say: "Pi implements the Agent Skills specification". **So the format is compatible with `SKILL.md`.** A skill is a directory with a `SKILL.md` that has YAML frontmatter: `name` (lowercase, hyphens, ≤64 chars), `description` (≤1024 chars, required, otherwise the skill is not loaded), `license`, `compatibility`, `metadata`, `allowed-tools`, and `disable-model-invocation`.
- Progressive disclosure: only the name, description, and path go into the system prompt. The model reads `SKILL.md` itself when it needs it. Users can force a skill with `/skill:name args`.
- Discovered locations: `~/.pi/agent/skills/`, `.pi/skills/`, `~/.agents/skills/`, `.agents/skills/` (walking up to the repo root), plus packages and `--skill`.
- `~/.claude/skills` is **not** a default location [verified via grep of `skills.ts` and `package-manager.ts`]. Add it through settings or `--skill`.
- The name does not have to match the directory name.

---

## 5. Providers and auth: ChatGPT/Codex subscription and OpenCode Go

### 5.1 Auth storage

- File: **`<agentDir>/auth.json`**, which defaults to `~/.pi/agent/auth.json` (`PI_CODING_AGENT_DIR` overrides it). The SDK can set it with `ModelRuntime.create({authPath})`.
- Implementation: `packages/coding-agent/src/core/auth-storage.ts`, specifically `FileAuthStorageBackend`, `AuthStorage`, and `ReadOnlyAuthStorage`. It uses **proper-lockfile** to serialize read-modify-write, so token refresh is safe across processes on one host.
- Format: one credential per provider id (`packages/ai/src/auth/types.ts`):
  ```ts
  interface ApiKeyCredential { type: "api_key"; key?: string; env?: Record<string,string> }   // key may be "!shell command"
  interface OAuthCredential  { type: "oauth"; access: string; refresh: string; expires: number; [k: string]: unknown }
  ```
  For example:
  ```json
  { "openai-codex": {"type":"oauth","access":"<jwt>","refresh":"...","expires":1730000000000,"accountId":"..."},
    "opencode-go":  {"type":"api_key","key":"sk-..."} }
  ```
- A stored credential takes precedence over environment variables for that provider. A failed OAuth refresh never falls back to an env key (pi-ai README, "Credential Store").

### 5.2 ChatGPT Plus/Pro subscription: two providers

| Provider id | Name in the catalog | Endpoint | OAuth flow | Headless? |
|---|---|---|---|---|
| **`openai-codex`** | "OpenAI Codex (legacy)", login label "OpenAI (ChatGPT Plus/Pro)" | `https://chatgpt.com/backend-api`, API `openai-codex-responses` | `packages/ai/src/auth/oauth/openai-codex.ts`. Client `app_EMoamEEZ73f0CkXaXp7hrann`; PKCE browser flow with callback `http://localhost:1455/auth/callback`, **or device code** | **Yes, device code** |
| **`openai`** (with OAuth) | "OpenAI (ChatGPT subscription)" / "Sign in with ChatGPT" | `https://api.openai.com/v1` (Responses API), scope `... chatgpt.tokens.use.direct` | `auth/oauth/openai-chatgpt.ts`. Dynamic client registration, `ext_agent_host_id=urn:uuid:<deviceId>` from settings `deviceId`, callback `127.0.0.1:1455` | Browser only. When the callback cannot reach the process, **paste the redirect URL** |

- Changelog: 'Renamed the inherited OpenAI Codex provider to "OpenAI Codex (legacy)"; Sign in with ChatGPT on the OpenAI provider supersedes it.' Both are still shipped in 1.5.0.
- The `openai` provider with an OAuth credential filters out classifier models; the Decisions API needs an API key.

Codex device-code flow (source):
```ts
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;   // user opens https://auth.openai.com/codex/device
...
const method = await interaction.prompt({ type: "select", message: "Select OpenAI Codex login method:",
  options: [{ id: "browser", ... }, { id: "device_code", label: "Device code login (headless)" }] });
```
- The stored credential is `{type:"oauth", access, refresh, expires, accountId}`, where `accountId` is the JWT claim `https://api.openai.com/auth.chatgpt_account_id`.
- `toAuth` returns `{apiKey: access}`. Refresh uses `grant_type=refresh_token` against `https://auth.openai.com/oauth/token`.

`openai-codex` model ids in the bundled 1.5.0 catalog (`pi-ai/dist/providers/data/openai-codex.json`; the runtime overlays newer pi.dev catalog data):
- 272K context: `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`
- 500K context: `gpt-6.1-sol`, `gpt-6.1-terra`

### 5.3 OpenCode Go

- Provider id **`opencode-go`** ("OpenCode Go") in `packages/ai/src/providers/opencode-go.ts`. Auth is **API key only**: `envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"])`. There is no OAuth.
- The same `OPENCODE_API_KEY` env var also serves `opencode` (OpenCode Zen).
- Each request gets an `x-opencode-session: <sessionId>` header (`opencode-headers.ts`).
- Base URLs: `https://opencode.ai/inference/go/{anthropic,openai/v1,google/v1beta}`.
- Bundled models:
  - anthropic-messages API: `claude-haiku-5-5`, `minimax-m3`, `qwen3.7-plus`, `qwen3.8-flash`, `qwen3.8-max`
  - openai-completions API: `deepseek-v4-pro`, `deepseek-v4.1-flash`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `hy3`, `hy4-preview`, `kimi-k2.7-code`, `kimi-k3`, `kimi-k3.1-pro`, `longcat-2.0`, `mimo-v2.5`, `mimo-v2.5-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `minimax-m3.1-flash`, `step-5-preview`, `beam-free`, `iceman-contributor-free`
  - openai-responses API: `gpt-5.6-luna`, `gpt-6-luna`, `grok-4.7`, `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`
  - google API: `gemini-4-argon`

### 5.4 Logging in on a headless server

1. **ChatGPT subscription via device code (recommended).** Either:
   - Run `pi` once over SSH (TUI), then `/login`, choose OpenAI Codex, then "Device code login (headless)". Or:
   - Do it programmatically: `modelRuntime.login("openai-codex","oauth",{prompt, notify})`. Answer the `select` prompt with `"device_code"` and relay `notify({type:"device_code", userCode, verificationUri})` to the user, for example over Telegram. [I verified the code path in source and confirmed `login()` exists in the published d.ts. I did **not** run it live.]
2. **"Sign in with ChatGPT" (`openai` provider).** Open the URL on any browser and paste the final `http://127.0.0.1:1455/auth/callback?...` URL back into Pi. `PI_OAUTH_CALLBACK_HOST` changes the bind host. Port 1455 is shared with the Codex CLI, and a busy port makes this login fail.
3. **Copy `auth.json`** from a logged-in machine. It is a plain JSON file, as shown above. **Caveat [unverified]:** OAuth refresh tokens rotate. If two machines refresh the same token independently, one of them will be invalidated. Give each host its own login.
4. **OpenCode Go:** set `OPENCODE_API_KEY`, or write `{"opencode-go":{"type":"api_key","key":"..."}}`, or use `"key":"!cmd"` to fetch it from a secret manager (the output is cached for the process lifetime).
5. Check readiness non-interactively with `pi auth check --provider openai-codex --json`. Exit codes: 0 ready, 1 not_ready, 2 invalid.

Other env vars:
- `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`
- `PI_OFFLINE`: disables catalog refresh and version checks.
- `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY=0`, `PI_CACHE_RETENTION=long`
- `HTTP(S)_PROXY`
- Provider keys are listed in `docs/providers.md`.

---

## 6. pi-durable and chord: are they useful for an always-on daemon?

**`@earendil-works/pi-durable` 1.5.0 is published but marked "Experimental. The API changes without notice."**

What it offers (`packages/durable/README.md`, 973 lines; spec in `docs/spec.md`, 6.5K lines):
- `Harness.open(storage, {models, registry, onWake?, identity?, telemetry?}, context)`, then `harness.root()`, which returns a `Conversation`. `conversation.submit({type:"input", content, requestId})` returns a `Submission`, and `.wait()` gives `done` or `unanswered`.
- **Crash safety.** Everything is committed before it is shown. `harness.resume()` continues interrupted runs. A request that was in flight when the process died counts as a failed attempt. `settings.restartLimit` (default 5) stops crash loops. `requestId` makes submissions idempotent across restarts.
- **Durable sleeps and timers.** A task phase can call `runtime.sleepUntil(ts, nextCheckpoint)`. The sleep is persisted and survives restarts, and Pi's scheduler wakes the task. This is effectively a durable cron and reminder primitive; see the `app.reminder` example in the README. There is also an `onWake` callback for evictable hosts such as Cloudflare Durable Objects.
- Tasks and task graphs: child tasks, `waiting` state, `failFast`.
- Subagents: conversations owned by a task. `background: true` subagents survive a parent abort (examples `21-subagent-foreground.ts`, `22-subagent-background.ts`).
- `watch()` gives live views for UIs. `ConversationTranscript` handles windowing.
- Hooks: `beforeTool`, `afterRun` (example `32-tests-after-edits.ts`).
- Storage backends: `MemoryStorage`, SQLite (`@earendil-works/pi-durable/storage/sqlite/node`, `openNodeSqliteStorage(file)`, WAL), JSONL (keeps the whole history in memory, so it is "not for long-running agents"), IndexedDB, and a Cloudflare DO.
- "One process owns a storage at a time; there is no cross-process locking."
- Its own `defineExtension({tools, sections, hooks, wraps, tasks})` and `CodingTools` (`read`, `write`, `edit`, `bash`) from `@earendil-works/pi-durable/tools`. It uses pi-ai `createModels({credentials})`, and you inject a `CredentialStore` yourself.
- **It does not read pi's `auth.json` automatically.** pi-coding-agent does not export its `AuthStorage` class publicly; only `readStoredCredential` is exported. You would have to write a small `CredentialStore` over `auth.json` [inferred from exports].

**`@earendil-works/chord` 1.5.0** is an object and plugin runtime for multi-process apps, with hot reload, a store, HTTP, and workers (`chord/http`, `chord/workers`, `chord/app`). It is a substrate for apps like p2, not an agent feature.

**`@earendil-works/pi-env`** runs durable's tools on a remote box through an SSH-deployed Rust daemon.

**Assessment for vigil [opinion]:**
- pi-durable has exactly the primitives an always-on agent needs: durable timers, crash recovery, idempotent submissions, and background subagents.
- But it is experimental, has its own extension API, and cannot use the pi package and extension ecosystem, `auth.json` OAuth helpers, or the pi-chat extension.
- Pragmatic path: build vigil on **pi-coding-agent's SDK** (stable surface, JSONL sessions, extensions, skills, OAuth), and implement the scheduler and job store in vigil itself (SQLite plus a cron library), triggering with `session.sendCustomMessage(..., {triggerTurn:true})` or `prompt(..., {streamingBehavior:"followUp"})`.
- Consider pi-durable later, or for a single subsystem, once it stabilizes.
- apps/p2 is a reference for durable plus chord as a server, but it is explicitly throwaway.

---

## 7. pi-chat (`earendil-works/pi-chat`)

**What it is.** `pi-chat` (package `pi-chat` 0.1.0, Apache-2.0 per the latest commit) is a **pi extension package** (`"pi": {"extensions": ["./index.ts"]}`). It is not published on npm under `@earendil-works`. It bridges **Discord and Telegram**, not Slack, despite what the pi README implies. Each connected channel gets its own pi session, running in a **Gondolin micro-VM** (`@earendil-works/gondolin` ^0.7.0, which needs QEMU).

Install it with `pi install /path/to/pi-chat` or `pi -e`.

Its peer deps use the legacy names (`@mariozechner/pi-coding-agent`, `@sinclair/typebox`). These resolve only through pi's module alias mapping, so it only works when loaded as an extension.

**Architecture** (about 5.2K LOC):
- `index.ts` (1467 lines): the extension. It registers commands `/chat-config`, `/chat-connect`, `/chat-disconnect`, `/chat-status`, `/chat-list`, `/chat-spawn-all`, `/chat-workers`, `/chat-open-all`, `/chat-kill-all`, `/chat-new`. It also registers tools `chat_history`, `chat_attach`, `chat_request_secret`, `chat_workers`, and overrides `read`, `write`, `edit`, and `bash` to route into the VM via `createReadTool(GONDOLIN_WORKSPACE, {operations: await sandbox.createReadOperations()})`.
- `src/live/{telegram,discord}.ts`: transports.
  - Telegram is raw Bot API `getUpdates` long polling via `fetch`, with offset as the resume cursor.
  - Discord uses `discord.js` with intents Guilds, GuildMessages, and MessageContent.
- The transport contract is `src/live/types.ts`:
  ```ts
  interface LiveConnection { conversation; disconnect(); sendImmediate(text, replyTo?); send(text, attachmentPaths?, signal?, replyTo?);
    startTyping(status?); stopTyping(); syncPreview(markdown, done?): Promise<string[]>; clearPreview(); setReplyTo(id) }
  interface LiveConnectionHandlers { onMessage(input: InboundMessageInput, checkpoint?); onCaughtUp(); onError(e); onDisconnect?() }
  ```
- `src/runtime.ts` (`ConversationRuntime`): a per-channel append-only `channel.jsonl` log with these record types: `inbound`, `outbound`, `checkpoint`, `job_queued`, `job_completed`, `job_failed`, `error`. It also holds a job queue (mention or DM triggers) and a `.lock` file.
- `src/render/*`: streaming Markdown and chunking, adapted from the Vercel Chat SDK. It edits a preview message in place.
- `src/gondolin.ts`: VM lifecycle. Secrets are injected only into outbound HTTP to allow-listed hosts. `src/secrets.ts` implements encrypted secret exchange (RSA-OAEP plus AES-GCM via a `pi.dev/secret` page).
- Multi-channel is handled by **one pi process per channel in tmux** (`/chat-spawn-all`). Each worker writes a status snapshot to `~/.pi/agent/chat/worker-status/` every 15 seconds.
- Storage: `~/.pi/agent/chat/{config.json, accounts/<a>/shared/{memory.md,skills/}, accounts/<a>/channels/<c>/{channel.jsonl, workspace/{memory.md,skills/,incoming/,.secrets/,SYSTEM.md}, gondolin/}}`.

**How it drives pi.** The pattern is worth copying:
- `tryDispatch()`: when `ctx.isIdle()`, take the next job and call `pi.sendUserMessage(next.prompt)`.
- `before_agent_start`: append to the system prompt the chat-mode instructions, the account and channel `memory.md`, the skills list, and `SYSTEM.md`.
- `context`: filter out its own `chat-context` custom messages.
- `tool_call`: during a chat turn, block every tool outside an allowlist.
- `agent_end`: extract the final assistant text and stopReason, `liveConnection.send(...)` with a 120-second timeout, mark the job completed or failed, then `tryDispatch()` again. **Note:** it uses `agent_end`. Current pi docs recommend `agent_settled` for "final idle".
- Remote control words in chat (`stop`, `status`, `compact`, `new`) map to `ctx.abort()`, `ctx.compact()`, and `pi.sendUserMessage("/chat-new", {deliverAs:"followUp"})`.

**Reusable for vigil:**
- The `LiveConnection` and `LiveConnectionHandlers` interfaces. Telegram and Discord adapters already exist; WhatsApp, for example via Baileys as OpenClaw does, would be one more implementation.
- The JSONL chat log with a checkpoint cursor and job records gives crash-safe catch-up.
- The memory-file injection pattern (account and channel `memory.md`).
- The secret-exchange flow.
- Streaming preview rendering.

It is **not** designed as a single-process multi-channel gateway: it uses tmux workers and one channel per pi process. vigil would probably host N `AgentSession`s in one process through the SDK and reuse the adapter code.

---

## 8. OpenClaw (`openclaw/openclaw`)

I read a shallow clone at `dc13ca6`. Package `openclaw` is at 2026.10.10 and requires Node 24.22+ or 26.12+.

- **It no longer embeds pi.** `docs/agent-runtime-architecture.md` says: "OpenClaw owns the built-in agent runtime … No external agent framework packages remain." The built-in runtime id is `openclaw`, and "The legacy alias `pi` normalizes to `openclaw`", deprecated since v2026.5.22. It forked and internalized the pi runtime. Pi-derived concepts remain, such as `src/agents/sessions/{session-manager,package-manager,resource-loader}.ts`, `packages/agent-core` (`@openclaw/agent-core`), and an `"openclaw": {extensions, skills, prompts, themes}` manifest. The only remaining pi dependency is `@earendil-works/pi-tui` 1.4.0.
- Key ideas that apply to vigil:
  - **Gateway**: a local control plane (daemon) for sessions, tools, events, and channel connections. CLI, TUI, Control UI, and companion apps connect to it. The CLI includes `openclaw onboard --install-daemon` and `openclaw gateway status`.
  - **Channels**: one plugin per service. WhatsApp uses `baileys`, Telegram uses `grammy`, Slack uses `@slack/bolt`, and Discord uses `discord-api-types` plus `ws`. There are 20+ more, including Signal, iMessage, Matrix, Teams, and Google Chat.
  - **Pairing and allowlists**: unknown DM senders must be paired (`openclaw pairing approve <channel> <code>`), and inbound messages are treated as untrusted. There is also bot-loop protection (`docs/channels/bot-loop-protection.md`).
  - **Heartbeats were retired** and replaced by ordinary **automation jobs**. `docs/gateway/heartbeat.md` says "Heartbeat monitoring now uses ordinary automation jobs". `openclaw automations create <when> --session main --system-event "..." --wake now`. Jobs have their own schedule, prompt, scratch, model, session, delivery target (channel, webhook, or none), and run history. Triggers include cron, webhooks, and Gmail PubSub. A legacy `HEARTBEAT.md` was migrated into jobs. Source is in `src/cron/` (`active-hours.ts`, `default-proactive-job.ts`, and others).
  - Swappable "harnesses", for example `codex` and `claude-cli` backends, selected per model or provider through `agentRuntime.id`.

---

## 9. Subagent, plan-mode, and cron examples in `packages/coding-agent/examples`

- `extensions/subagent/`: a `subagent` tool that **spawns separate `pi` processes** with `["--mode","json","-p","--no-session", "--model", ...]`. It parses JSONL events, streams parallel tasks, and kills children on abort. Agent definitions live in `agents/{scout,planner,reviewer,worker}.md` (installed to `~/.pi/agent/agents` or `.pi/agents`). Workflow prompt templates: `implement.md` (scout, then planner, then worker), `scout-and-plan.md`, `implement-and-review.md`.
- `extensions/plan-mode/`: a Claude Code-style read-only `/plan` command with step tracking. It uses `setActiveTools` and `tool_call` blocking.
- `extensions/handoff.ts`: `/handoff <goal>` moves context into a new focused session.
- **There is no cron or scheduler example.** The closest examples:
  - `extensions/file-trigger.ts`: `fs.watch` in `session_start`, then `pi.sendMessage({...}, {triggerTurn:true})`. This is the pattern for external triggers into a live session.
  - `extensions/send-user-message.ts`, `event-bus.ts`, `reload-runtime.ts`, `shutdown-command.ts`, `trigger-compact.ts`, `custom-compaction.ts`, `git-checkpoint.ts`, `permission-gate.ts`, `protected-paths.ts`, `ssh.ts` (pluggable remote tool operations), `gondolin/` (VM tools), `structured-output.ts` (`terminate: true`), `jev-router.ts` (a virtual-model router).
- SDK examples `01`–`14` (§2), plus `rpc-client.ts` and `rpc-extension-ui.ts`.
- In pi-durable: examples `21`/`22` (subagents), `26-plan-mode.ts`, and the `sleepUntil` reminder task in the README, which is the closest thing to a durable cron.

---

## 10. Gotchas for headless and daemon use

1. **Node ≥ 22.19.0 is required** by every package's `engines`. Node 20 users get the dist-tag `legacy-node20` = 0.74.2. This box has Node v22.23.4. OpenClaw needs Node 24 or later, which is irrelevant here.
2. **ESM only.** `exports` has only `"import"` conditions, so there is no CJS. Use `"type":"module"` or `.mts`. Top-level await works.
3. **TypeScript:**
   - The published `.d.ts` import JSON without import attributes, so with TS 5.9 and `module: NodeNext` you **must use `skipLibCheck: true`**. That produced 43 errors otherwise [verified].
   - Upstream builds with TS 7.0 targeting ES2024.
   - Import `Type` from `typebox`. The npm `pi-ai` no longer re-exports TypeBox.
   - Use `@earendil-works/pi-ai/compat` for `getModel(provider, id)` (example 12).
4. **Install** with `npm i --ignore-scripts`; lifecycle scripts are not needed. The `pi` bin is `dist/bundle/cli.js`. Dependencies are pinned exactly, and `@silvia-odwyer/photon-node` provides WASM image processing.
5. **Session dir pitfall:** `agentDir` does not relocate sessions. Pass `sessionDir` to `SessionManager.*` or set `PI_CODING_AGENT_DIR` [verified].
6. **Call `session.bindExtensions({...})`.** Without it, extensions' `session_start` handlers (MCP connect, timers, state restore) never run in the SDK [verified in source]. Supply `uiContext` to route extension dialogs. Otherwise `hasUI` is false and dialogs are no-ops.
7. The SDK does **not** auto-load the `codemode`, `tool_search`, or MCP built-ins, and does not set `AI_AGENT` or `PI_CODING_AGENT` env markers.
8. **Busy sessions:** `prompt()` while streaming throws unless `streamingBehavior` is set. Use `agent_settled`, not `agent_end`, to detect idle. Serialize per-session input in the gateway.
9. **Project trust:** the default `defaultProjectTrust: "ask"` means non-interactive runs **skip** project-local `.pi` extensions, settings, and packages. Context files like `AGENTS.md` still load. Set `"always"` in `<agentDir>/settings.json`, or pass `-a` on the CLI, for a workspace you control.
10. **Network on startup:** Pi refreshes the model catalog from pi.dev and checks for new versions. Use `PI_OFFLINE=1` or `PI_SKIP_VERSION_CHECK`, and `PI_TELEMETRY=0` for install telemetry and attribution headers. **This is the default in interactive mode; [unverified] whether the SDK triggers the refresh as well.**
11. **OAuth on servers:**
    - Codex device code works headlessly.
    - "Sign in with ChatGPT" needs a browser callback on `127.0.0.1:1455`, or a pasted URL, and fails if the port is busy (for example with the Codex CLI).
    - Refresh-token rotation makes sharing one `auth.json` across hosts fragile [unverified].
    - `auth.json` contains secrets; keep it at mode 0600 [doc: "Keep it private"].
12. **No permission system.** Pi runs with the process's privileges. Sandbox with Docker, Gondolin, or OpenShell (`docs/containerization.md`), or add a `tool_call` gate extension (`examples/extensions/permission-gate.ts`, `protected-paths.ts`).
13. **Extension factories run even in invocations that never start a session**, such as `pi --help` or `pi install`. Start resources in `session_start` and close them in `session_shutdown`.
14. **RPC clients:** never use Node `readline` for stdout framing, and always drain stdout to avoid backpressure stalls. RPC has no login command.
15. **Breaking changes in minor releases** (for example 1.5.0's tool-schema validation and grep `readFile` removal in Unreleased). Pin `1.5.0` exactly and read `packages/coding-agent/CHANGELOG.md` before bumping.
16. `pi-durable` JSONL storage keeps all history in memory, so use SQLite for long-running work. It has no cross-process locking, so a single owner process is required.