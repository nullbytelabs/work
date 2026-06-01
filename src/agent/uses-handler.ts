/**
 * The `agent` uses-handler — the bridge between the durable core's generic
 * `UsesHandler` contract and the agent layer. The runtime core imports none of
 * this; the composition root (CLI / tests) builds the handler and registers it.
 *
 * Responsibilities: parse `agent/<name>`, load the package, bind the (already
 * interpolated) `with` values into the agent's inputs, resolve the model from
 * config, call the AgentRunner, and map the result to a `UsesResult`.
 */
import { join } from "node:path";
import type { UsesHandler, UsesContext, UsesResult } from "../runtime/types.ts";
import { resolveModel, type PiWorkflowsConfig } from "../config/index.ts";
import { parseAgentUses, loadAgent, buildAgentPrompt, agentOutputs, type AgentRunner } from "./index.ts";
import { PiAgentRunner } from "./pi-runner.ts";
import { GuestPiRunner } from "./guest-pi-runner.ts";

export interface AgentUsesHandlerOptions {
  /** Provider/model config (for resolving the model an agent step runs on). */
  config?: PiWorkflowsConfig;
  /**
   * Force a specific runner (tests inject a mock so no inference happens). When
   * omitted, the runner is chosen per step by where the job runs: an in-guest
   * `GuestPiRunner` for a sandboxed job (`runs-on: gondolin`), the host
   * `PiAgentRunner` for `runs-on: local`.
   */
  runner?: AgentRunner;
  /**
   * Override where agent packages are resolved from. By default packages are
   * project-local: `<projectDir>/agents/`, where `projectDir` is the running
   * workflow's own folder. Set this to pin a fixed search dir (e.g. in tests).
   */
  agentsDir?: string;
}

const TRUNCATION_WARNING =
  "warning: agent output was truncated (finish_reason=length) — raise the model's maxTokens in config";

/**
 * Pick the runner for a step. An explicitly injected runner always wins (tests).
 * Otherwise the runner follows `runs-on`: a sandboxed job runs the agent
 * **inside the guest** (`GuestPiRunner` over `ctx.exec`), `local` runs it
 * host-side (`PiAgentRunner`) — exactly mirroring how `run:` steps are placed.
 */
function selectRunner(opts: AgentUsesHandlerOptions, ctx: UsesContext): AgentRunner {
  if (opts.runner) return opts.runner;
  if (ctx.sandboxed) {
    return new GuestPiRunner({
      exec: ctx.exec,
      hostDir: ctx.workdir,
      guestDir: ctx.workspacePath,
      emit: (c) => ctx.emit(c),
    });
  }
  return new PiAgentRunner();
}

/** Build the `uses: agent/<name>` handler. */
export function createAgentUsesHandler(opts: AgentUsesHandlerOptions = {}): UsesHandler {
  return {
    scheme: "agent",
    async run(ctx: UsesContext): Promise<UsesResult> {
      try {
        const runner = selectRunner(opts, ctx);
        const { name } = parseAgentUses(ctx.uses);
        // Workflow-local resolution: agents live in an `agents/` folder beside
        // the workflow definition (its `workflowDir` — e.g. `.workflows/agents/`,
        // like a GitHub Actions local action), unless an explicit agentsDir is
        // configured. Falls back to the project root for the simple case where
        // the workflow file sits at the project root.
        const base = ctx.workflowDir ?? ctx.projectDir;
        const agentsDir = opts.agentsDir ?? (base ? join(base, "agents") : undefined);
        if (!agentsDir) {
          throw new Error(
            `cannot resolve agent "${name}": no workflow directory for this run (agent packages live in <workflow-dir>/agents/<name>/)`,
          );
        }
        const agent = await loadAgent(name, agentsDir);

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
