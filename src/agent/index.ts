/**
 * Agent layer for `uses: agent/<name>` steps.
 *
 * `AgentRunner` is the seam. The production runner is `GuestPiRunner`: every job
 * runs in the gondolin sandbox, so the agent's whole loop (model calls + tools)
 * executes in-guest via the `@earendil-works/pi-coding-agent` SDK. There is no
 * host-side runner — running an agent on the host would defeat the sandbox.
 * Tests inject a stub runner, so the whole pipeline is exercisable without
 * inference.
 *
 * An agent is a **directory package** the *project* supplies (like a GitHub
 * Actions local action), resolved from `<agents-dir>/<name>/`:
 *   agent.yaml       — manifest (inputs/outputs, description; model/tools later)
 *   instructions.md  — the system prompt (standing persona/policy)
 *   task.md          — the task prompt template; `{{ <input> }}` placeholders
 *                      bound from the step's `with`
 * (skills/, extension.ts are reserved for future agent skills/extensions.) This
 * is the currently-shipped `agent/<name>` package shape; the direction for richer
 * agents (a dumb `work/agent` primitive + user-space actions) is in
 * docs/agent-primitive-and-actions.md. Packages are NOT shipped in
 * the engine — they live in the project (the agent uses-handler points
 * `loadAgent` at `<projectDir>/agents/`). Remote `@ref` sourcing
 * (github/gitlab/codeberg) and project/user override search paths come later,
 * and stay inside the agent layer — the durable core never learns about them.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { UserFacingError } from "../errors.ts";
import type { ResolvedModel } from "../config/index.ts";

export interface AgentRequest {
  /** System prompt (the agent's standing persona/policy). */
  system: string;
  /** Task prompt for this invocation (built from bound inputs). */
  prompt: string;
  /** Resolved model; optional so a stub runner can ignore it. */
  model?: ResolvedModel;
  /**
   * Working directory the agent runs in — the job's staged workspace (its
   * checkout). The agent gets the full toolset rooted here, so it operates on
   * the real files directly. The runner does not police what it does in there.
   * Defaults to `process.cwd()` when omitted.
   */
  cwd?: string;
}

export interface AgentResult {
  text: string;
  /** Why the model stopped — "stop" (complete) or "length" (truncated at max_tokens), etc. */
  finishReason?: string;
}

export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResult>;
}

// The in-guest runner (every job is sandboxed) + the env var its model key arrives under.
export { GuestPiRunner, GUEST_MODEL_KEY_ENV, type GuestPiRunnerDeps } from "./guest-pi-runner.ts";
// The agent uses-handler — register this with the runtime (composition root).
export { createAgentUsesHandler, type AgentUsesHandlerOptions } from "./uses-handler.ts";
// Per-job sandbox egress for agent steps (allow-all egress + model-host-scoped key).
export { makeAgentEgressResolver, type AgentJobNetwork } from "./egress.ts";

/** A loaded agent package. */
export interface LoadedAgent {
  name: string;
  /** System prompt (from instructions.md). */
  instructions: string;
  /** Task prompt template (from task.md); `{{ name }}` placeholders, or "". */
  task: string;
  /** Declared inputs (bound from the step's `with`). */
  inputs: Record<string, { required: boolean }>;
  /** Declared output keys (the final message fills the first). */
  outputs: string[];
}

// Cache keyed by the resolved package directory (resolution is project-relative,
// so the same name in different projects must not collide).
const cache = new Map<string, LoadedAgent>();

/** Parse a `uses:` value into an agent name. Only the `agent/<name>[@ref]` scheme today. */
export function parseAgentUses(uses: string): { name: string; ref?: string } {
  const m = /^agent\/([a-z0-9][a-z0-9-]*)(?:@(.+))?$/i.exec(uses.trim());
  if (!m) {
    throw new UserFacingError(`unsupported uses: "${uses}" — expected agent/<name>[@ref]`);
  }
  const out: { name: string; ref?: string } = { name: m[1]! };
  if (m[2]) out.ref = m[2];
  return out;
}

/**
 * Load an agent package `<agentsDir>/<name>/` (cached by resolved path).
 * `agentsDir` is supplied by the caller (the uses-handler resolves it from the
 * workflow's project directory) — packages are project-local, not shipped here.
 */
export async function loadAgent(name: string, agentsDir: string): Promise<LoadedAgent> {
  const dir = join(agentsDir, name);
  const cached = cache.get(dir);
  if (cached) return cached;

  let manifestText: string;
  try {
    manifestText = await readFile(join(dir, "agent.yaml"), "utf-8");
  } catch {
    throw new UserFacingError(`unknown agent "${name}" (no package at ${dir})`);
  }

  const manifest = (parseYaml(manifestText) ?? {}) as {
    inputs?: Record<string, { required?: boolean } | null>;
    outputs?: string[] | Record<string, unknown>;
  };
  const instructions = (await readFile(join(dir, "instructions.md"), "utf-8").catch(() => "")).trim();
  if (!instructions) throw new UserFacingError(`agent "${name}" is missing a non-empty instructions.md`);
  const task = (await readFile(join(dir, "task.md"), "utf-8").catch(() => "")).trim();

  const inputs: Record<string, { required: boolean }> = {};
  for (const [k, v] of Object.entries(manifest.inputs ?? {})) {
    inputs[k] = { required: Boolean(v && (v as { required?: boolean }).required) };
  }
  const outputs = Array.isArray(manifest.outputs)
    ? manifest.outputs
    : Object.keys(manifest.outputs ?? {});

  const agent: LoadedAgent = { name, instructions, task, inputs, outputs };
  cache.set(dir, agent);
  return agent;
}

/** Build the task prompt by binding declared inputs into the `task.md` template. */
export function buildAgentPrompt(agent: LoadedAgent, inputs: Record<string, string>): string {
  if (!agent.task) return Object.values(inputs).join("\n");
  return agent.task.replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (_m, key: string) => inputs[key] ?? "");
}

/**
 * Map the final assistant text to the agent's declared outputs.
 *
 * Two shapes, chosen by a backward-compatible convention so every existing
 * agent keeps working byte-for-byte:
 *
 *  - **Single-output (the original behavior).** An agent that declares one (or
 *    zero) output gets its whole final message as that one output. This is the
 *    common case — e.g. `summarize` returns a prose sentence, not JSON — and
 *    must never change, so it stays the default/fallback path.
 *
 *  - **Multi-output (the JSON convention).** When an agent declares 2+ outputs
 *    AND its final message (trimmed) parses to a JSON *object*, we treat that
 *    object as the structured result: each *declared* output name is filled from
 *    the matching key. This lets a synthesis stage emit `severity`,
 *    `root_cause`, `confidence`, … as separate `${{ steps.* }}` values. We only
 *    read declared keys (undeclared JSON keys are ignored, declared-but-missing
 *    keys become ""), so the manifest stays the contract — the agent can't
 *    smuggle in extra outputs.
 *
 * The multi-output path is opt-in by *both* conditions, and never errors: if a
 * 2+-output agent returns non-JSON (or a JSON array/number/string/null rather
 * than an object — bad prompt, model didn't comply), we fall back to
 * first-output-gets-everything. The author still gets a usable result and a clear
 * signal to fix their agent's prompt, rather than a hard failure mid-pipeline.
 *
 * The change is purely additive: we do NOT touch `buildAgentPrompt` or the
 * instructions. Authors instruct their agent to emit JSON themselves — that's a
 * docs concern, not engine behavior.
 */
export function agentOutputs(agent: LoadedAgent, text: string): Record<string, string> {
  const trimmed = text.trim();

  // Multi-output path: only when 2+ outputs are declared. (One declared output
  // can never benefit from JSON splitting, so we never even parse in that case —
  // a single-output agent returning a JSON-looking string keeps it verbatim.)
  if (agent.outputs.length >= 2) {
    const obj = parseJsonObject(trimmed);
    if (obj) {
      const out: Record<string, string> = {};
      for (const key of agent.outputs) {
        const value = obj[key];
        // Missing declared key → ""; scalars via String; objects/arrays
        // re-serialized so the value round-trips as a usable string output.
        out[key] =
          value === undefined
            ? ""
            : value !== null && typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
      }
      return out;
    }
    // Fall through: 2+ outputs but the text wasn't a JSON object → fallback below.
  }

  // Single-output / fallback path (the original behavior): the whole trimmed
  // message becomes the first declared output (or "output" if none declared).
  const key = agent.outputs[0] ?? "output";
  return { [key]: trimmed };
}

/**
 * Parse `text` as JSON and return it only if it's a plain object. Anything that
 * throws, or that parses to an array/number/string/boolean/null, returns
 * `undefined` so the caller takes the verbatim fallback path. (Arrays are
 * `typeof "object"`, so we exclude them explicitly.)
 */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}
