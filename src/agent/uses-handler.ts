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
import { GuestPiRunner } from "./guest-pi-runner.ts";

export interface AgentUsesHandlerOptions {
  /** Provider/model config (for resolving the model an agent step runs on). */
  config?: PiWorkflowsConfig;
  /**
   * Force a specific runner (tests inject a mock so no inference happens). When
   * omitted, the agent runs in-guest via `GuestPiRunner` — every job is a
   * gondolin sandbox, so there is no host-side runner.
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
 * Otherwise the agent runs **inside the job's guest** via `GuestPiRunner` (over
 * `ctx.exec`) — every job is a gondolin sandbox, so the agent loop never touches
 * the host, exactly like a `run:` step.
 */
function selectRunner(opts: AgentUsesHandlerOptions, ctx: UsesContext): AgentRunner {
  if (opts.runner) return opts.runner;
  return new GuestPiRunner({
    exec: ctx.exec,
    hostDir: ctx.workdir,
    guestDir: ctx.workspacePath,
    emit: (c) => ctx.emit(c),
  });
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
          // The agent runs in the job's workspace (host workdir for `local`, the
          // guest mount for a sandbox) — both surface as `workspacePath`.
          cwd: ctx.workspacePath,
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
