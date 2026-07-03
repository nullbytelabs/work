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
import { readFile, realpath } from "node:fs/promises";
import type { UsesHandler, UsesContext, UsesResult } from "../runtime/types.ts";
import { StepInterrupted } from "../runtime/types.ts";
import { resolveModel, type WorkConfig } from "../config/index.ts";
import type { AgentRunner } from "./index.ts";
import { GuestPiRunner } from "./guest-pi-runner.ts";
import { loadBuiltinAction, runAction, BUILTIN_ACTIONS, type SubUsesDispatch } from "../actions/index.ts";

export interface WorkHandlerOptions {
  /** Provider/model config (for resolving the model a `work/agent` step runs on). */
  config?: WorkConfig;
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
 *
 * Containment is enforced on the *real* (symlink-resolved) paths, not a lexical
 * `relative()` over `join()`: the checkout is attacker-controlled (a hostile repo
 * may plant a symlink whose lexical path has no `..` yet resolves to an arbitrary
 * host file like ~/.ssh/id_rsa), and `fs.cp` stages symlinks verbatim. A lexical
 * check would pass and `readFile` would follow the link, turning a host secret
 * into the agent's prompt. So we realpath both sides and require the target to sit
 * within the workspace.
 */
async function readWorkspaceFile(workdir: string, file: string): Promise<string> {
  if (isAbsolute(file)) throw new Error(`prompt file "${file}" must be a workspace-relative path, not absolute`);
  const resolved = join(workdir, file);
  if (relative(workdir, resolved).startsWith("..")) throw new Error(`prompt file "${file}" escapes the workspace`);
  // Resolve symlinks on both the workspace root and the target, then re-check
  // containment on the real paths so a planted symlink can't escape the checkout.
  let realWorkdir: string;
  try {
    realWorkdir = await realpath(workdir);
  } catch {
    realWorkdir = workdir;
  }
  let realResolved: string;
  try {
    realResolved = await realpath(resolved);
  } catch {
    throw new Error(`prompt file "${file}" does not exist in the workspace`);
  }
  const rel = relative(realWorkdir, realResolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`prompt file "${file}" escapes the workspace`);
  }
  return readFile(realResolved, "utf-8");
}

/** Resolve the prompt from `with:`: inline `prompt:`, or `promptFile:` (a file in
 *  the checkout). The prompt carries any role/persona you want — there is no
 *  separate system-prompt input. */
async function resolvePrompt(withMap: Record<string, unknown>, workdir: string): Promise<string | undefined> {
  const inline = withMap["prompt"];
  if (typeof inline === "string") return inline;
  const file = withMap["promptFile"];
  if (typeof file === "string") return (await readWorkspaceFile(workdir, file)).trim();
  return undefined;
}

/** The `work/agent` primitive: a prompt in, the final message out. */
async function runWorkAgent(ctx: UsesContext, opts: WorkHandlerOptions): Promise<UsesResult> {
  const prompt = await resolvePrompt(ctx.with, ctx.workdir);
  if (prompt === undefined) {
    const message = `work/agent needs a prompt — set "prompt:" or "promptFile:" in with:`;
    ctx.emit({ stream: "stderr", text: message });
    return { status: "failure", stderr: message };
  }

  const modelAlias = typeof ctx.with.model === "string" ? ctx.with.model : undefined;
  const model = opts.config ? resolveModel(opts.config, modelAlias) : undefined;
  // The configured provider key (e.g. "fireworks", "anthropic") — the gen_ai.provider.name
  // for telemetry. Honest about the real provider rather than guessing in the emitter.
  const resolvedAlias = modelAlias ?? opts.config?.defaultModel;
  const provider = resolvedAlias ? opts.config?.models[resolvedAlias]?.provider : undefined;

  // No system prompt is set — Pi's own discovery (a checked-in `.pi/` persona,
  // `AGENTS.md`) supplies any standing role; the prompt carries the task.
  const res = await selectRunner(opts.runner, ctx).run({
    prompt,
    cwd: ctx.workspacePath,
    ...(model ? { model } : {}),
  });

  const warning = res.finishReason === "length" ? TRUNCATION_WARNING : "";
  if (warning) ctx.emit({ stream: "stderr", text: warning });
  // One output: the final assistant message. No JSON-splitting — structured
  // fields are a user-space action's job, not the engine's. When a model resolved,
  // carry agent telemetry (model + the loop's cumulative token usage) for observability.
  return {
    status: "success",
    stdout: res.text,
    stderr: warning,
    outputs: { output: res.text },
    ...(model
      ? {
          agent: {
            model: model.model,
            ...(provider ? { provider } : {}),
            ...(res.usage ? { usage: res.usage } : {}),
            ...(res.setupMs !== undefined ? { setupMs: res.setupMs } : {}),
            ...(res.runMs !== undefined ? { runMs: res.runMs } : {}),
          },
        }
      : {}),
  };
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
        // A target/exec tear-out must propagate (resumable interruption), not be
        // swallowed into a step failure — mirrors the run: path's durability.
        if (err instanceof StepInterrupted) throw err;
        return fail((err as Error).message);
      }
    },
  };
}
