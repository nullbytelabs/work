/**
 * The `agent` uses-handler — the bridge between the durable core's generic
 * `UsesHandler` contract and the agent layer. The runtime core imports none of
 * this; the composition root (CLI / tests) builds the handler and registers it.
 *
 * Responsibilities: parse `agent/<name>`, load the package, bind the (already
 * interpolated) `with` values into the agent's inputs, resolve the model from
 * config, call the AgentRunner, and map the result to a `UsesResult`.
 */
import type { UsesHandler, UsesContext, UsesResult } from "../runtime/types.ts";
import { resolveModel, type PiWorkflowsConfig } from "../config/index.ts";
import { parseAgentUses, loadAgent, buildAgentPrompt, agentOutputs, type AgentRunner } from "./index.ts";
import { PiAgentRunner } from "./pi-runner.ts";

export interface AgentUsesHandlerOptions {
  /** Provider/model config (for resolving the model an agent step runs on). */
  config?: PiWorkflowsConfig;
  /** Runner (default: Pi SDK). Tests inject a mock so no inference happens. */
  runner?: AgentRunner;
}

const TRUNCATION_WARNING =
  "warning: agent output was truncated (finish_reason=length) — raise the model's maxTokens in config";

/** Build the `uses: agent/<name>` handler. */
export function createAgentUsesHandler(opts: AgentUsesHandlerOptions = {}): UsesHandler {
  const runner = opts.runner ?? new PiAgentRunner();

  return {
    scheme: "agent",
    async run(ctx: UsesContext): Promise<UsesResult> {
      try {
        const { name } = parseAgentUses(ctx.uses);
        const agent = await loadAgent(name);

        // Split the well-known `model` override from the agent's declared inputs.
        let modelAlias: string | undefined;
        const inputs: Record<string, string> = {};
        for (const [k, v] of Object.entries(ctx.with)) {
          const val = typeof v === "string" ? v : String(v);
          if (k === "model") modelAlias = val;
          else inputs[k] = val;
        }
        for (const [key, spec] of Object.entries(agent.inputs)) {
          if (spec.required && !(key in inputs)) {
            throw new Error(`agent "${name}" requires input "${key}"`);
          }
        }

        const model = opts.config ? resolveModel(opts.config, modelAlias) : undefined;
        const res = await runner.run({
          system: agent.instructions,
          prompt: buildAgentPrompt(agent, inputs),
          ...(model ? { model } : {}),
        });

        const warning = res.finishReason === "length" ? TRUNCATION_WARNING : "";
        if (warning) ctx.emit({ stream: "stderr", text: warning });
        return { status: "success", stdout: res.text, stderr: warning, outputs: agentOutputs(agent, res.text) };
      } catch (err) {
        const message = (err as Error).message;
        ctx.emit({ stream: "stderr", text: message });
        return { status: "failure", stderr: message };
      }
    },
  };
}
