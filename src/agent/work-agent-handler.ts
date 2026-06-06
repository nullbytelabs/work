/**
 * The `work` uses-handler — the built-in `work/agent` primitive.
 *
 * This is the dumb primitive from docs/agent-primitive-and-actions.md: it runs a
 * Pi agent in-guest with exactly what you pass in `with:` — no package format, no
 * `instructions.md`/`task.md` filenames, no `{{ }}` templating, no outputs JSON
 * convention. It is `createAgentUsesHandler` minus `loadAgent`/`buildAgentPrompt`/
 * `agentOutputs`: the `with:` map *is* the `AgentRequest`.
 *
 * `work/` is reserved for engine built-ins (the CLI is `work`); `work/agent` is
 * the first. Rich, versioned, testable behavior lives one layer up, in user-space
 * actions (the `action/<name>` handler) — not in the engine.
 */
import { isAbsolute, join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import type { UsesHandler, UsesContext, UsesResult } from "../runtime/types.ts";
import { resolveModel, type PiWorkflowsConfig } from "../config/index.ts";
import type { AgentRunner } from "./index.ts";
import { selectRunner, TRUNCATION_WARNING } from "./uses-handler.ts";

export interface WorkAgentHandlerOptions {
  /** Provider/model config (for resolving the model the step runs on). */
  config?: PiWorkflowsConfig;
  /**
   * Force a specific runner (tests inject a mock so no inference happens). When
   * omitted, the agent runs in-guest via `GuestPiRunner` — every job is a
   * gondolin sandbox, so there is no host-side runner.
   */
  runner?: AgentRunner;
}

/** Parse a `work/<builtin>` value; only `work/agent` is supported today. */
function parseWorkUses(uses: string): { builtin: string } {
  const rest = uses.trim().slice("work/".length);
  return { builtin: rest };
}

/**
 * Read a workspace-relative prompt file from the host side of the staged
 * checkout (`ctx.workdir`). Rejects absolute paths and any path that escapes the
 * workspace — the prompt source must be a checked-in file under the checkout.
 */
async function readWorkspaceFile(workdir: string, file: string): Promise<string> {
  if (isAbsolute(file)) {
    throw new Error(`prompt file "${file}" must be a workspace-relative path, not absolute`);
  }
  const resolved = join(workdir, file);
  const rel = relative(workdir, resolved);
  if (rel.startsWith("..")) {
    throw new Error(`prompt file "${file}" escapes the workspace`);
  }
  return readFile(resolved, "utf-8");
}

/**
 * Resolve one prompt source from `with:`: an inline string, or a `<key>File`
 * pointing at a workspace file. Returns undefined when neither is present.
 */
async function resolvePromptSource(
  withMap: Record<string, unknown>,
  key: "instructions" | "prompt",
  workdir: string,
): Promise<string | undefined> {
  const inline = withMap[key];
  if (typeof inline === "string") return inline;
  const fileKey = `${key}File`;
  const file = withMap[fileKey];
  if (typeof file === "string") return (await readWorkspaceFile(workdir, file)).trim();
  return undefined;
}

/** Build the `uses: work/agent` handler (the built-in primitive). */
export function createWorkAgentHandler(opts: WorkAgentHandlerOptions = {}): UsesHandler {
  return {
    scheme: "work",
    async run(ctx: UsesContext): Promise<UsesResult> {
      const emitFail = (message: string): UsesResult => {
        ctx.emit({ stream: "stderr", text: message });
        return { status: "failure", stderr: message };
      };
      try {
        const { builtin } = parseWorkUses(ctx.uses);
        if (builtin !== "agent") {
          return emitFail(`unsupported work built-in "${ctx.uses}" — only work/agent is available`);
        }

        const instructions = await resolvePromptSource(ctx.with, "instructions", ctx.workdir);
        const prompt = await resolvePromptSource(ctx.with, "prompt", ctx.workdir);
        if (prompt === undefined) {
          return emitFail(`work/agent needs a prompt — set "prompt:" or "promptFile:" in with:`);
        }

        const modelAlias = typeof ctx.with.model === "string" ? ctx.with.model : undefined;
        const model = opts.config ? resolveModel(opts.config, modelAlias) : undefined;

        const runner = selectRunner(opts.runner, ctx);
        const res = await runner.run({
          // Omitting `system` lets Pi's discovery (.pi/, AGENTS.md) supply the persona.
          ...(instructions !== undefined ? { system: instructions } : {}),
          prompt,
          cwd: ctx.workspacePath,
          ...(model ? { model } : {}),
        });

        const warning = res.finishReason === "length" ? TRUNCATION_WARNING : "";
        if (warning) ctx.emit({ stream: "stderr", text: warning });
        // One output: the final assistant message. No JSON-splitting convention —
        // structured fields are a user-space action's job, not the engine's.
        return { status: "success", stdout: res.text, stderr: warning, outputs: { output: res.text } };
      } catch (err) {
        return emitFail((err as Error).message);
      }
    },
  };
}
