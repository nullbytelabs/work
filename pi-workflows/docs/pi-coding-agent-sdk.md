# Pi Coding Agent SDK (TypeScript) — Reference

> Source of truth: the official Pi docs at https://pi.dev/docs/latest. All API names, signatures, and config fields below are quoted from those pages (primarily the SDK, Custom Models, Custom Providers, Providers, and Settings docs). Anything that could not be confirmed from the docs is explicitly marked **UNVERIFIED — needs confirmation**.

## 1. What Pi actually is (and what the "SDK" is)

Pi ("Pi Coding Agent", by Earendil Inc.) is a terminal coding agent. The npm package `@earendil-works/pi-coding-agent` ships **both** the CLI (`pi`) **and** a TypeScript SDK. The SDK gives you in-process, type-safe access to the same agent engine the TUI uses.

Architecturally there are several packages referenced in the docs:
- `@earendil-works/pi-coding-agent` — main entry point (the SDK you import).
- `@earendil-works/pi-agent-core` — the core `Agent` class (`session.agent` is an instance of this).
- `@earendil-works/pi-ai` — the model/provider layer: `getModel()`, `Model`, streaming types, `OAuthCredentials`, `calculateCost`, etc.

There are **three** ways to drive Pi programmatically:
1. **SDK** (in-process, what you want for an embedded workflow engine) — `createAgentSession()`.
2. **RPC mode** (subprocess, JSONL over stdin/stdout) — `pi --mode rpc` or `runRpcMode()`.
3. **JSON event stream / print mode** (single-shot structured events) — `runPrintMode()`.

For embedding Pi as the agent/model layer inside an in-process durable workflow engine, the **SDK** is the right surface. RPC mode is the right surface if you want process isolation / language independence (e.g., each durable step spawns its own `pi` subprocess) — which is also the natural fit when steps run inside a Gondolin sandbox.

---

## 2. Installation & initialization

### Install

```bash
npm install @earendil-works/pi-coding-agent
```

The SDK is bundled in the main package — no separate install. (Global CLI install is `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.)

**Package version: UNVERIFIED — needs confirmation.** The docs don't pin a version; check `npm view @earendil-works/pi-coding-agent version` for the exact current release.

### Minimal initialization (quick start, verbatim from docs)

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

// Set up credential storage and model registry
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

The truly minimal form is `const { session } = await createAgentSession();` — it falls back to `DefaultResourceLoader` with standard discovery, default model resolution, and default tools.

---

## 3. Core agent/session API

### `createAgentSession(options?) → Promise<CreateAgentSessionResult>`

The main factory for a single `AgentSession`. Return shape:

```typescript
interface CreateAgentSessionResult {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;   // { extensions, errors, runtime }
  modelFallbackMessage?: string;            // set if the session's saved model couldn't be restored
}
```

### `AgentSession` (the primary object you interact with)

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Model control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // In-place tree navigation within the current session file
  navigateTree(targetId: string, options?: {
    summarize?: boolean; customInstructions?: string;
    replaceInstructions?: boolean; label?: string;
  }): Promise<{ editorText?: string; cancelled: boolean }>;

  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): void;
}
```

Key behaviors:
- `prompt()` resolves **only after the full accepted run finishes**, including retries. This is the natural "await the step" primitive.
- Session-*replacement* operations (new/resume/fork/import) are **not** on `AgentSession`; they live on `AgentSessionRuntime` (see §9).

### Prompting & message queueing

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

- One-shot, when idle: `await session.prompt("...")`.
- During streaming you MUST say how to queue: `streamingBehavior: "steer"` (interrupt/redirect after current tool calls) or `"followUp"` (deliver after the agent stops). Calling `prompt()` mid-stream without `streamingBehavior` throws.
- `preflightResult(true|false)` fires once per `prompt()` before it resolves: `true` = accepted/queued/handled, `false` = preflight rejected before acceptance. Post-acceptance failures come through the event/message stream, not via `preflightResult(false)`.

### The underlying `Agent` (`session.agent`, from `@earendil-works/pi-agent-core`)

```typescript
const state = session.agent.state;
// state.messages: AgentMessage[]          - conversation history
// state.model: Model
// state.thinkingLevel: ThinkingLevel
// state.systemPrompt: string
// state.tools: AgentTool[]
// state.streamingMessage?: AgentMessage   - current partial assistant message
// state.errorMessage?: string             - latest assistant error

session.agent.state.messages = messages;   // replace (copies top-level array) - branching/restore
session.agent.state.tools = tools;         // replace tools
await session.agent.waitForIdle();         // wait for agent to finish processing
```

---

## 4. Events / streaming

Subscribe with `session.subscribe(listener)`; it returns an unsubscribe function. Event union (`AgentSessionEvent`), with the documented `event.type` values:

- `message_update` — streaming deltas. Inspect `event.assistantMessageEvent.type`:
  - `"text_delta"` → `event.assistantMessageEvent.delta` (assistant text)
  - `"thinking_delta"` → reasoning output (when thinking enabled)
- `message_start` / `message_end` — message lifecycle.
- `tool_execution_start` — `event.toolName`.
- `tool_execution_update` — streaming tool output.
- `tool_execution_end` — `event.isError` boolean.
- `agent_start` / `agent_end` — `agent_end` carries `event.messages` (new messages from the run).
- `turn_start` / `turn_end` — one LLM response + its tool calls. `turn_end` has `event.message` (assistant response) and `event.toolResults`.
- `queue_update` — `event.steering`, `event.followUp`.
- `compaction_start` / `compaction_end`.
- `auto_retry_start` / `auto_retry_end`.

Canonical streaming snippet:

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta")
        process.stdout.write(event.assistantMessageEvent.delta);
      break;
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.isError ? "error" : "success"}`);
      break;
    case "turn_end":
      // event.message (assistant), event.toolResults
      break;
    case "agent_end":
      // event.messages = new messages this run
      break;
  }
});
```

> Tool calls surface both as streaming events (`tool_execution_*`) and structurally inside the assistant message content blocks (`toolCall` blocks) and `turn_end.toolResults`.

---

## 5. Models & pointing Pi at LiteLLM (the part that matters most for this engine)

Two distinct concerns: (a) how a `Model` object is selected/passed to a session in code, and (b) how a provider's base URL / API key / API dialect is configured so requests actually hit your LiteLLM proxy.

### 5a. Selecting a model in code

```typescript
import { getModel } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Built-in model lookup (does NOT verify an API key exists)
const opus = getModel("anthropic", "claude-opus-4-5");

// Any model by provider/id, including custom models from models.json
const custom = modelRegistry.find("my-provider", "my-model");

// Only models that have valid API keys configured
const available = await modelRegistry.getAvailable();
```

Model resolution order when no `model` is passed: (1) restore from session, (2) settings default (`defaultProvider`/`defaultModel`), (3) first available model. A `Model` is identified by **provider + id**.

### 5b. Pointing Pi at a LiteLLM (OpenAI-compatible) proxy — the key mechanism

LiteLLM exposes an **OpenAI-compatible** endpoint (`/v1/chat/completions`, served at e.g. `http://localhost:4000/v1`) and you authenticate with a single LiteLLM virtual/master key. Pi's `openai-completions` API type is exactly that dialect. Configure it as a **custom provider** via `~/.pi/agent/models.json` (file-based) **or** programmatically via an extension's `pi.registerProvider()`.

A single LiteLLM key fanning out to many providers maps cleanly to **one Pi provider** (pointed at the LiteLLM base URL with the LiteLLM key) whose `models[]` array lists each LiteLLM "model name" configured in your LiteLLM `config.yaml`. Pi sends `model: "<id>"` to LiteLLM and LiteLLM routes it.

#### Option A — `models.json` (recommended for the engine's config)

```json
{
  "providers": {
    "litellm": {
      "baseUrl": "http://localhost:4000/v1",
      "api": "openai-completions",
      "apiKey": "$LITELLM_API_KEY",
      "authHeader": true,
      "models": [
        { "id": "gpt-4o",          "name": "GPT-4o (via LiteLLM)" },
        { "id": "claude-sonnet-4", "name": "Claude Sonnet 4 (via LiteLLM)" },
        { "id": "gemini-2.5-pro",  "name": "Gemini 2.5 Pro (via LiteLLM)",
          "reasoning": true, "input": ["text", "image"],
          "contextWindow": 200000, "maxTokens": 16384 }
      ]
    }
  }
}
```

Notes grounded in the docs:
- `baseUrl`, `api`, and `apiKey` are required when you define `models`. Only `id` is strictly required *per model*; everything else has defaults (`name`=`id`, `reasoning`=false, `input`=`["text"]`, `contextWindow`=128000, `maxTokens`=16384, `cost`=all zeros).
- `authHeader: true` adds `Authorization: Bearer <apiKey>` automatically — what you want for LiteLLM's standard auth.
- `apiKey` resolution supports literal (`"sk-..."`), env interpolation (`"$LITELLM_API_KEY"` / `"${VAR}"`), and shell command (`"!op read 'op://...'"`). `$$` = literal `$`, `$!` = literal `!`.
- The file reloads each time `/model` opens; editable mid-session without restart.

**Compat flags for LiteLLM (likely needed):** Many OpenAI-compatible servers/proxies don't understand the `developer` role or `reasoning_effort`. Whether your specific LiteLLM deployment needs these is **UNVERIFIED — needs confirmation** (test it), but the knobs are:

```json
{
  "providers": {
    "litellm": {
      "baseUrl": "http://localhost:4000/v1",
      "api": "openai-completions",
      "apiKey": "$LITELLM_API_KEY",
      "authHeader": true,
      "compat": {
        "supportsDeveloperRole": false,    // send system prompt as `system`, not `developer`
        "supportsReasoningEffort": false,  // omit reasoning_effort
        "supportsUsageInStreaming": true,  // stream_options: { include_usage: true }
        "maxTokensField": "max_tokens"     // vs max_completion_tokens
      },
      "models": [ { "id": "...", "reasoning": true } ]
    }
  }
}
```

Provider-level `compat` applies to all models; model-level `compat` overrides per model (they merge). Full `compat` field list (openai-completions branch): `supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `maxTokensField` (`"max_completion_tokens"|"max_tokens"`), `requiresToolResultName`, `requiresAssistantAfterToolResult`, `requiresThinkingAsText`, `requiresReasoningContentOnAssistantMessages`, `thinkingFormat`, `cacheControlFormat`, `supportsStrictMode`, `supportsLongCacheRetention`, `openRouterRouting`, `vercelGatewayRouting`. Per-model thinking control uses `thinkingLevelMap`.

#### Option B — override a built-in provider's base URL (route through LiteLLM without redefining models)

```json
{ "providers": { "anthropic": { "baseUrl": "https://my-litellm.example.com/v1" } } }
```

#### Option C — programmatic registration via extension (`pi.registerProvider`)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("litellm", {
    name: "LiteLLM Proxy",
    baseUrl: "http://localhost:4000/v1",
    apiKey: "$LITELLM_API_KEY",
    authHeader: true,
    api: "openai-completions",
    models: [
      { id: "gpt-4o", name: "GPT-4o", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 16384 },
    ],
  });
}
```

The factory may be `async` — useful to **discover LiteLLM's model list dynamically** by fetching `GET http://localhost:4000/v1/models` and mapping `data[]` into `models`. `pi.unregisterProvider("litellm")` removes it. When `models` is provided it **replaces** all models for that provider.

#### Recommended pattern for this engine

One `litellm` provider (base URL + LiteLLM key, `api: "openai-completions"`, `authHeader: true`) registered programmatically via an inline extension factory, with its model list either hard-configured or fetched from `/v1/models`. Workflow steps then select with `modelRegistry.find("litellm", "<id>")`.

> **UNVERIFIED:** docs imply only `modelRegistry.find()` returns custom (non-built-in) provider models; `getModel()` is documented as finding *built-in* models only. Use `find()` for the `litellm` provider.

### API key precedence (for injecting the LiteLLM key)

1. Runtime overrides via `authStorage.setRuntimeApiKey(provider, key)` (not persisted).
2. Stored credentials in `~/.pi/agent/auth.json`.
3. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).
4. Fallback resolver for custom provider keys from `models.json`.

For an embedded engine, the most controllable injection:

```typescript
authStorage.setRuntimeApiKey("litellm", process.env.LITELLM_API_KEY!); // not written to disk
```

There is **no built-in `LITELLM_API_KEY` env var** — you supply it via `apiKey: "$LITELLM_API_KEY"` interpolation, `setRuntimeApiKey`, or `auth.json`.

---

## 6. Tooling (function calling, file edit, shell, MCP)

### Built-in tools

Names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Default-enabled: `read`, `bash`, `edit`, `write`.

```typescript
await createAgentSession({ tools: ["read", "grep", "find", "ls"] });   // read-only
await createAgentSession({ tools: ["read", "bash", "grep"] });          // pick specific
await createAgentSession({ excludeTools: ["ask_question"] });           // remove named
```

- `noTools: "all"` disables everything; `noTools: "builtin"` disables defaults but keeps extension/custom tools.
- The `edit` tool returns `details.diff` (TUI) and `details.patch` (standard unified patch — use this in SDK consumers).
- When you pass a custom `cwd`, built-in tools are bound to that cwd. Exported tool factories: `createCodingTools`, `createReadOnlyTools`, `createReadTool`, `createBashTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, `createLsTool`.

### Custom tools (`defineTool`)

```typescript
import { Type } from "typebox";
import { createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({ input: Type.String({ description: "Input value" }) }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
});

await createAgentSession({ customTools: [myTool] });
```

This is the natural integration point for exposing **workflow-engine-native operations** to the agent as tools — e.g. `read_artifact(stepId)`, `emit_output(key, value)`, `get_matrix_value()`.

### MCP

**UNVERIFIED — needs confirmation.** The pages fetched (SDK, Providers, Custom Models/Providers, Settings, index) don't mention MCP directly. If present, it's most likely under **Extensions** (`/docs/latest/extensions`). Check that doc.

---

## 7. ResourceLoader, extensions, skills, prompts, context files

`createAgentSession()` uses a `ResourceLoader` to supply extensions, skills, prompt templates, themes, and context files. Default is `DefaultResourceLoader`.

```typescript
import { DefaultResourceLoader, getAgentDir, createAgentSession } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  systemPromptOverride: () => "You are a helpful assistant.",
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [ (pi) => { pi.on("agent_start", () => {}); } ],
});
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader });
```

Overrides available: `systemPromptOverride`, `skillsOverride` (`Skill` type), `promptsOverride` (`PromptTemplate`), `agentsFilesOverride` (virtual `AGENTS.md`). Extensions can share an event bus via `createEventBus()`.

---

## 8. Concurrency, cancellation, timeouts, durability/checkpoints

The most important section for embedding Pi in a durable, GitHub-Actions-style engine.

### Cancellation (verified)
- `session.abort(): Promise<void>` — abort the current operation.
- `session.abortCompaction(): void`; `session.dispose(): void` — cleanup.
- Providers honor an `AbortSignal` (`options?.signal?.aborted`) — cancellation propagates to the request layer.

### Timeouts (verified via Settings)
Configured through `SettingsManager` / `settings.json`:
- `retry.provider.timeoutMs` — provider/SDK request timeout.
- `httpIdleTimeoutMs` — HTTP idle timeout (default 300000; 0 disables).
- `websocketConnectTimeoutMs` — WS handshake (default 15000).
- `retry.provider.maxRetryDelayMs` — max server-requested delay before failing (default 60000).

```typescript
import { SettingsManager } from "@earendil-works/pi-coding-agent";
const settingsManager = SettingsManager.inMemory({
  retry: { enabled: true, maxRetries: 2, provider: { timeoutMs: 600000, maxRetries: 0 } },
  compaction: { enabled: false },
});
await createAgentSession({ settingsManager, /* ... */ });
```

> Keep `retry.provider.maxRetries` at `0` unless needed — provider-level retries can swallow out-of-quota errors before Pi's own agent-level retry sees them.

### Retry (verified)
Agent-level auto-retry on transient errors: `retry.enabled` (default true), `retry.maxRetries` (3), `retry.baseDelayMs` (2000, exponential). Observable via `auto_retry_start`/`auto_retry_end`. Because `prompt()` only resolves after retries complete, your durable step's "await" already absorbs transient retries.

### Concurrency (partly verified)
- Each `AgentSession` is a single conversational unit; one active run at a time. There is **no documented "run N prompts in parallel on one session"**.
- For concurrency across workflow steps: **multiple independent sessions** (each `createAgentSession()`), or **multiple subprocesses** via RPC mode. Spawning sub-agents is an explicit listed use case.
- **Thread-safety of sharing `AuthStorage`/`ModelRegistry` across many concurrent sessions: UNVERIFIED.** They appear designed to be shared, but no explicit concurrency contract is documented.

### Durability / checkpoints (strongest fit, mostly verified)
Pi's **session tree** is the built-in durability/checkpoint mechanism:

- **Persistence:** `SessionManager.create(cwd)` writes a JSONL session file (`session.sessionFile`, `session.sessionId`). `SessionManager.inMemory()` ephemeral. `SessionManager.open(path)`, `SessionManager.continueRecent(cwd)`.
- **Tree model:** entries linked by `id`/`parentId`. `getEntries()`, `getTree()`, `getPath()`, `getLeafEntry()`, `getEntry(id)`, `getChildren(id)`.
- **Labels (checkpoints):** `getLabel(id)`, `appendLabelChange(id, "checkpoint")`.
- **Branching:** `branch(entryId)`, `branchWithSummary(id, "...")`, `createBranchedSession(leafId)`.
- **State restore in code:** `session.agent.state.messages = messages`.
- **Replacement/resume/fork:** via `AgentSessionRuntime` (§9).
- **Compaction:** `session.compact(...)`, auto-compaction settings, on-overflow auto-recovery.

**Mapping to the engine:** treat the JSONL session file as the durable record for an agent-backed step. Use `appendLabelChange(id, "...")` to mark step boundaries, `getLeafEntry()`/`getPath()` to read current state, and `fork(entryId, { position: "at" })` to replay/branch deterministically from a checkpoint after a crash/restart.

> **No documented mid-LLM-turn suspend/resume.** A `prompt()` runs to completion (incl. tool calls + retries) then resolves. Durability lives at the session/message-tree granularity, between prompts. Read `/docs/latest/session-format` for exact JSONL entry schemas before building checkpoint logic. **Mid-run suspend/resume: UNVERIFIED / likely unsupported.**

---

## 9. `AgentSessionRuntime` (session replacement layer)

Use when the engine needs to swap the active session (resume/fork/new) and rebuild cwd-bound state.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices, createAgentSessionRuntime,
  createAgentSessionServices, getAgentDir, SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services, diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(), agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runtime.newSession();
await runtime.switchSession("/path/to/session.jsonl");
await runtime.fork("entry-id");
await runtime.fork("entry-id", { position: "at" }); // clone path
```

Gotchas (verified): `runtime.session` **changes** after `newSession()/switchSession()/fork()/importFromJsonl()` — re-subscribe listeners and re-bind extensions (`runtime.session.bindExtensions(...)`) each time.

---

## 10. Run modes (higher-level helpers)

- `new InteractiveMode(runtime, opts)` then `await mode.run()` — full TUI.
- `runPrintMode(runtime, { mode, initialMessage, initialImages, messages })` — single-shot. Good for a "stateless step" model. JSON event output at `/docs/latest/json`.
- `runRpcMode(runtime)` — JSON-RPC over stdin/stdout for subprocess integration. Or `pi --mode rpc --no-session`. Protocol at `/docs/latest/rpc`.

Choice: **SDK** for type safety / same process / direct agent state / programmatic tools; **RPC mode** for process isolation or language-agnostic clients. For a durable engine wanting crash isolation per step (or running inside a Gondolin VM), RPC-per-subprocess is a legitimate alternative to in-process SDK.

---

## 11. Auth & config surface (summary)

- **Config/state dir:** `~/.pi/agent/` (`getAgentDir()`): `settings.json`, `models.json`, `auth.json`, `sessions/`, `extensions/`, `skills/`, `prompts/`.
- **Project dir:** `.pi/` under cwd, plus `AGENTS.md` context files walked up from cwd.
- **`auth.json`:** `{ "<provider>": { "type": "api_key", "key": "<literal|$ENV|!cmd>" } }`, `0600`. Auth file beats env vars.
- **Built-in provider env vars:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, plus Azure/Bedrock/Cloudflare/Vertex. **No built-in LiteLLM var.**
- **Settings via SDK:** `SettingsManager.create(cwd?, agentDir?)` or `SettingsManager.inMemory(settings?)`. `applyOverrides({...})`. Call `await settingsManager.flush()` at durability boundaries.
- **Useful env vars:** `PI_CODING_AGENT_SESSION_DIR`, `PI_SKIP_VERSION_CHECK=1`, `PI_OFFLINE=1` / `--offline` (disable all startup network ops — relevant for hermetic/sandboxed runs).

---

## 12. TypeScript exports worth knowing

```typescript
// Factories / runtime
createAgentSession, createAgentSessionRuntime, AgentSessionRuntime
createAgentSessionServices, createAgentSessionFromServices

// Auth & models
AuthStorage, ModelRegistry
getModel  // from @earendil-works/pi-ai

// Resource loading
DefaultResourceLoader, type ResourceLoader, createEventBus

// Tools
defineTool
createCodingTools, createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool,
createGrepTool, createFindTool, createLsTool

// Sessions & settings
SessionManager, SettingsManager, getAgentDir

// Types
type CreateAgentSessionOptions, CreateAgentSessionResult
type ExtensionFactory, ExtensionAPI
type ToolDefinition, Tool
type Skill, PromptTemplate
type CreateAgentSessionRuntimeFactory
```

Other types in signatures: `AgentSession`, `Agent`, `AgentMessage`, `AgentSessionEvent`, `Model`, `ThinkingLevel` (`"off"|"minimal"|"low"|"medium"|"high"|"xhigh"`), `ModelCycleResult`, `CompactionResult`, `PromptOptions`, `ImageContent`, `InputSource`, `LoadExtensionsResult`.

`AssistantMessage` shape (for parsing tool calls structurally):
```typescript
interface AssistantMessage {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; /* ... */ }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >;
  usage: { input; output; cacheRead; cacheWrite; totalTokens; cost };
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}
```

---

## 13. Copy-paste snippets for the engine

### (a) Initialize the SDK with shared auth/registry + LiteLLM key
```typescript
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";

const authStorage   = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
authStorage.setRuntimeApiKey("litellm", process.env.LITELLM_API_KEY!); // not persisted
```

### (b) One-shot agent task (await to completion)
```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage, modelRegistry,
  tools: ["read", "grep", "bash"],
});
await session.prompt("Summarize the README and list TODOs.");
const finalMessages = session.messages;   // full transcript after completion
session.dispose();
```

### (c) Point Pi at a LiteLLM proxy programmatically, then run
```typescript
import {
  createAgentSession, DefaultResourceLoader, getAgentDir,
  ModelRegistry, AuthStorage, SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const authStorage   = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const loader = new DefaultResourceLoader({
  cwd: process.cwd(), agentDir: getAgentDir(),
  extensionFactories: [
    async (pi: ExtensionAPI) => {
      pi.registerProvider("litellm", {
        name: "LiteLLM Proxy",
        baseUrl: "http://localhost:4000/v1",
        apiKey: "$LITELLM_API_KEY",
        authHeader: true,
        api: "openai-completions",
        // compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, // if needed
        models: [
          { id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000, maxTokens: 16384 },
        ],
      });
    },
  ],
});
await loader.reload();

const model = modelRegistry.find("litellm", "claude-sonnet-4");
if (!model) throw new Error("LiteLLM model not registered");

const { session } = await createAgentSession({
  model, authStorage, modelRegistry,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});
await session.prompt("Hello via LiteLLM.");
```

---

## 14. Open questions to confirm before building

1. **Current package version** and API stability across releases.
2. **`getModel` vs `modelRegistry.find` for custom providers** — use `find()` for `litellm`.
3. **MCP support** — check `/docs/latest/extensions`.
4. **Whether your LiteLLM deployment needs `compat.supportsDeveloperRole:false` / `supportsReasoningEffort:false`** — test.
5. **Concurrency contract** — sharing one `AuthStorage`/`ModelRegistry` across many simultaneous sessions.
6. **Mid-run durable suspend/resume** — appears unsupported; confirm via Session Format doc.
7. **Exact session JSONL entry schemas** — `/docs/latest/session-format`.
8. **`runPrintMode` JSON schema & RPC protocol** — `/docs/latest/json`, `/docs/latest/rpc`.

## 15. Sources
- SDK: https://pi.dev/docs/latest/sdk
- Docs index: https://pi.dev/docs/latest
- Custom Models (`models.json`, OpenAI-compatible/LiteLLM config): https://pi.dev/docs/latest/models
- Custom Providers (`pi.registerProvider`, streaming, OAuth): https://pi.dev/docs/latest/custom-provider
- Providers (auth env vars, `auth.json`, resolution order): https://pi.dev/docs/latest/providers
- Settings (retry/compaction/timeouts/sessions): https://pi.dev/docs/latest/settings
- Recommended further reading: `/docs/latest/session-format`, `/docs/latest/extensions`, `/docs/latest/rpc`, `/docs/latest/json`
