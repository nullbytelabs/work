/**
 * Agent layer for `uses: agent/<name>` steps.
 *
 * `AgentRunner` is the seam: the real `OpenAiAgentRunner` makes one
 * OpenAI-compatible chat-completion call (Node `fetch`, no dependency — this is
 * the `openai-completions` dialect Pi also speaks, so config carries over to a
 * full Pi-SDK runner later). Tests inject a stub runner, so the whole pipeline
 * is exercisable without inference.
 *
 * A built-in agent is a small composition: a fixed system prompt (instructions),
 * a task-prompt builder over its declared inputs, and an outputs mapping. This is
 * the pragmatic core of the agent-package design in docs/agent-uses-interface.md
 * (no tools, no manifest dirs yet).
 */
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
}

export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResult>;
}

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
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new UserFacingError("agent model response had no choices[0].message.content");
    }
    return { text };
  }
}

/** A built-in agent: fixed instructions + a task builder + an outputs mapping. */
export interface BuiltinAgent {
  name: string;
  /** System prompt. */
  instructions: string;
  /** Declared inputs (bound from the step's `with`). */
  inputs: Record<string, { required?: boolean }>;
  /** Output keys this agent produces. */
  outputs: string[];
  /** Build the task prompt from validated inputs. */
  buildPrompt(inputs: Record<string, string>): string;
  /** Map the final assistant text to declared outputs. */
  toOutputs(text: string): Record<string, string>;
}

const summarize: BuiltinAgent = {
  name: "summarize",
  instructions:
    "You are a precise summarizer. Given a block of text, reply with a single concise sentence that captures its key point. Output only the summary — no preamble, labels, or quotes.",
  inputs: { input: { required: true } },
  outputs: ["summary"],
  buildPrompt: (i) => `Summarize the following:\n\n${i.input ?? ""}`,
  toOutputs: (text) => ({ summary: text.trim() }),
};

export const BUILTIN_AGENTS: Record<string, BuiltinAgent> = { summarize };

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

/** Resolve a built-in agent by name. */
export function resolveAgent(name: string): BuiltinAgent {
  const agent = BUILTIN_AGENTS[name];
  if (!agent) {
    throw new UserFacingError(`unknown agent "${name}" (built-in agents: ${Object.keys(BUILTIN_AGENTS).join(", ")})`);
  }
  return agent;
}
