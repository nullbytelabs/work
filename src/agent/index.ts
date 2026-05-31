/**
 * Agent layer for `uses: agent/<name>` steps.
 *
 * `AgentRunner` is the seam: the real `OpenAiAgentRunner` makes one
 * OpenAI-compatible chat-completion call (Node `fetch`, no dependency — this is
 * the `openai-completions` dialect Pi also speaks, so config carries over to a
 * full Pi-SDK runner later). Tests inject a stub runner, so the whole pipeline
 * is exercisable without inference.
 *
 * An agent is a **directory package** under `src/agents/<name>/`:
 *   agent.yaml       — manifest (inputs/outputs, description; model/tools later)
 *   instructions.md  — the system prompt (standing persona/policy)
 *   task.md          — the task prompt template; `{{ <input> }}` placeholders
 *                      bound from the step's `with`
 * (skills/, extension.ts are reserved for the future Pi-SDK runner.) This is the
 * package shape from docs/agent-uses-interface.md; project/user override paths
 * come later — for now we load the built-in packages shipped here.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
}

export interface AgentResult {
  text: string;
  /** Why the model stopped — "stop" (complete) or "length" (truncated at max_tokens), etc. */
  finishReason?: string;
}

export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResult>;
}

// The Pi-SDK-backed runner (default; full run + retries via session.prompt).
export { PiAgentRunner } from "./pi-runner.ts";
// The agent uses-handler — register this with the runtime (composition root).
export { createAgentUsesHandler, type AgentUsesHandlerOptions } from "./uses-handler.ts";

/** Calls an OpenAI-compatible `/chat/completions` endpoint (Fireworks/LiteLLM/etc.). */
export class OpenAiAgentRunner implements AgentRunner {
  async run(req: AgentRequest): Promise<AgentResult> {
    if (!req.model) {
      throw new UserFacingError(
        "agent step needs a model — provide a config (--config) with providers/models and a defaultModel, or set with.model",
      );
    }
    const { baseUrl, apiKey, model, maxTokens, temperature } = req.model;
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      stream: false,
    };
    if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
    if (temperature !== undefined) body["temperature"] = temperature;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new UserFacingError(`agent model request to ${url} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new UserFacingError(`agent model request failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    // stream:false → this single response is the COMPLETE result; nothing to await further.
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = json.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string") {
      throw new UserFacingError("agent model response had no choices[0].message.content");
    }
    const result: AgentResult = { text };
    if (choice?.finish_reason) result.finishReason = choice.finish_reason;
    return result;
  }
}

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

/** Where built-in agent packages live (sibling `src/agents/`). */
const AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
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

/** Load an agent package by name from `src/agents/<name>/` (cached). */
export async function loadAgent(name: string): Promise<LoadedAgent> {
  const cached = cache.get(name);
  if (cached) return cached;

  const dir = join(AGENTS_DIR, name);
  let manifestText: string;
  try {
    manifestText = await readFile(join(dir, "agent.yaml"), "utf-8");
  } catch {
    throw new UserFacingError(`unknown agent "${name}" (no package at src/agents/${name}/)`);
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
  cache.set(name, agent);
  return agent;
}

/** Build the task prompt by binding declared inputs into the `task.md` template. */
export function buildAgentPrompt(agent: LoadedAgent, inputs: Record<string, string>): string {
  if (!agent.task) return Object.values(inputs).join("\n");
  return agent.task.replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (_m, key: string) => inputs[key] ?? "");
}

/** Map the final assistant text to the agent's declared outputs (first output). */
export function agentOutputs(agent: LoadedAgent, text: string): Record<string, string> {
  const key = agent.outputs[0] ?? "output";
  return { [key]: text.trim() };
}
