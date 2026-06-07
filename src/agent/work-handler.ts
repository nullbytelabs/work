/**
 * The `work` uses-handler — the engine's built-in step primitives.
 *
 * `work/` is reserved for engine built-ins (the CLI is `work`). This handler
 * dispatches:
 *   - `work/agent` — the dumb agent primitive (docs/agent-primitive-and-actions.md):
 *     run a Pi agent in-guest with exactly what `with:` carries — no package format,
 *     no `instructions.md`/`task.md`, no templating, no outputs convention. The
 *     `with:` map *is* the `AgentRequest`. It is the ONLY agent execution path.
 *   - `work/checkout`, `work/install-node` — built-in actions shipped inside the
 *     engine (composite actions under `src/actions/builtin/`), run through the same
 *     `runAction` path as user-space actions.
 *
 * Richer/bespoke behavior lives one layer up in user-space actions (the
 * `action/<name>` handler) — not in the engine.
 */
import { isAbsolute, join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import type { UsesHandler, UsesContext, UsesResult } from "../runtime/types.ts";
import { resolveModel, type PiWorkflowsConfig } from "../config/index.ts";
import type { AgentRunner } from "./index.ts";
import { GuestPiRunner } from "./guest-pi-runner.ts";
import { loadBuiltinAction, runAction, BUILTIN_ACTIONS, type SubUsesDispatch } from "../actions/index.ts";

export interface WorkHandlerOptions {
  /** Provider/model config (for resolving the model a `work/agent` step runs on). */
  config?: PiWorkflowsConfig;
  /**
   * Force a specific agent runner (tests inject a mock so no inference happens).
   * When omitted, `work/agent` runs in-guest via `GuestPiRunner` — every job is a
   * gondolin sandbox, so there is no host-side runner.
   */
  runner?: AgentRunner;
  /** Router for `uses:` sub-steps inside built-in composite actions. */
  dispatch?: SubUsesDispatch;
}

const TRUNCATION_WARNING =
  "warning: agent output was truncated (finish_reason=length) — raise the model's maxTokens in config";

/**
 * Pick the agent runner. An injected runner always wins (tests). Otherwise the
 * agent runs inside the job's guest via `GuestPiRunner` (over `ctx.exec`), so the
 * loop never touches the host — exactly like a `run:` step.
 */
function selectRunner(runner: AgentRunner | undefined, ctx: UsesContext): AgentRunner {
  if (runner) return runner;
  return new GuestPiRunner({ exec: ctx.exec, hostDir: ctx.workdir, guestDir: ctx.workspacePath, emit: (c) => ctx.emit(c) });
}

/**
 * Read a workspace-relative prompt file from the host side of the staged checkout
 * (`ctx.workdir`). Rejects absolute paths and any path that escapes the workspace.
 */
async function readWorkspaceFile(workdir: string, file: string): Promise<string> {
  if (isAbsolute(file)) throw new Error(`prompt file "${file}" must be a workspace-relative path, not absolute`);
  const resolved = join(workdir, file);
  if (relative(workdir, resolved).startsWith("..")) throw new Error(`prompt file "${file}" escapes the workspace`);
  return readFile(resolved, "utf-8");
}

/** Resolve one prompt source from `with:`: an inline string, or a `<key>File`. */
async function resolvePromptSource(
  withMap: Record<string, unknown>,
  key: "instructions" | "prompt",
  workdir: string,
): Promise<string | undefined> {
  const inline = withMap[key];
  if (typeof inline === "string") return inline;
  const file = withMap[`${key}File`];
  if (typeof file === "string") return (await readWorkspaceFile(workdir, file)).trim();
  return undefined;
}

/** The `work/agent` primitive: `with:` is the AgentRequest. */
async function runWorkAgent(ctx: UsesContext, opts: WorkHandlerOptions): Promise<UsesResult> {
  const instructions = await resolvePromptSource(ctx.with, "instructions", ctx.workdir);
  const prompt = await resolvePromptSource(ctx.with, "prompt", ctx.workdir);
  if (prompt === undefined) {
    const message = `work/agent needs a prompt — set "prompt:" or "promptFile:" in with:`;
    ctx.emit({ stream: "stderr", text: message });
    return { status: "failure", stderr: message };
  }

  const modelAlias = typeof ctx.with.model === "string" ? ctx.with.model : undefined;
  const model = opts.config ? resolveModel(opts.config, modelAlias) : undefined;

  const res = await selectRunner(opts.runner, ctx).run({
    // Omitting `system` lets Pi's discovery (.pi/, AGENTS.md) supply the persona.
    ...(instructions !== undefined ? { system: instructions } : {}),
    prompt,
    cwd: ctx.workspacePath,
    ...(model ? { model } : {}),
  });

  const warning = res.finishReason === "length" ? TRUNCATION_WARNING : "";
  if (warning) ctx.emit({ stream: "stderr", text: warning });
  // One output: the final assistant message. No JSON-splitting — structured
  // fields are a user-space action's job, not the engine's.
  return { status: "success", stdout: res.text, stderr: warning, outputs: { output: res.text } };
}

/** Build the `uses: work/<builtin>` handler. */
export function createWorkHandler(opts: WorkHandlerOptions = {}): UsesHandler {
  return {
    scheme: "work",
    async run(ctx: UsesContext): Promise<UsesResult> {
      const fail = (message: string): UsesResult => {
        ctx.emit({ stream: "stderr", text: message });
        return { status: "failure", stderr: message };
      };
      try {
        const builtin = ctx.uses.trim().slice("work/".length);
        if (builtin === "agent") return await runWorkAgent(ctx, opts);
        if ((BUILTIN_ACTIONS as readonly string[]).includes(builtin)) {
          return await runAction(ctx, await loadBuiltinAction(builtin), opts.dispatch);
        }
        return fail(
          `unsupported work built-in "${ctx.uses}" — available: agent, ${BUILTIN_ACTIONS.join(", ")}`,
        );
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
}
