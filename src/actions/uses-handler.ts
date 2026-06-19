/**
 * The `action` uses-handler — runs a user-space action (JavaScript or composite).
 *
 * It bridges the durable core's generic `UsesHandler` to the action layer: parse
 * `action/<name>`, load the package, validate the step's `with:` against the
 * action's declared `inputs:`, then run it. A **node** action runs its `main`
 * script in-guest with the GitHub-faithful `INPUT_*` / `$WORK_OUTPUT` ABI; a
 * **composite** action runs its step bundle via the composite runner. The runtime
 * core imports none of this — the composition root registers the handler.
 *
 * `runAction` is the shared entry both this handler and the built-in `work/*`
 * actions use, so a built-in is just a bundled action run through the same path.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { UsesHandler, UsesContext, UsesResult } from "../runtime/types.ts";
import { StepInterrupted } from "../runtime/types.ts";
import { resolveInputs, WorkflowCompileError } from "../compiler/index.ts";
import { parseActionUses, loadAction, type LoadedAction } from "./load.ts";
import { runGuestNode } from "./guest-node.ts";
import { runComposite, type SubUsesDispatch } from "./composite.ts";

export interface ActionUsesHandlerOptions {
  /**
   * Override where action packages are resolved from. By default they are
   * project-local: `<workflowDir>/actions/`. Set this to pin a fixed search dir
   * (e.g. in tests).
   */
  actionsDir?: string;
  /** Router for `uses:` sub-steps inside composite actions (work/agent, nested actions). */
  dispatch?: SubUsesDispatch;
}

/** Map an input name to its `INPUT_<NAME>` env var (GitHub Actions ABI). */
function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/[^\w]/g, "_").toUpperCase()}`;
}

/**
 * Run an already-loaded action: validate `with:` against its inputs, then dispatch
 * by kind. Shared by the `action/<name>` handler and the built-in `work/*` actions.
 */
export async function runAction(
  ctx: UsesContext,
  action: LoadedAction,
  dispatch?: SubUsesDispatch,
): Promise<UsesResult> {
  const fail = (message: string): UsesResult => {
    ctx.emit({ stream: "stderr", text: message });
    return { status: "failure", stderr: message };
  };

  // Validate + coerce `with:` against the action's declared inputs (reusing the
  // workflow input validator). A validation error is a step failure, not a crash.
  let inputs: Record<string, string | number | boolean>;
  try {
    inputs = resolveInputs(action.inputs, ctx.with);
  } catch (err) {
    if (err instanceof WorkflowCompileError) return fail(`action "${action.name}": ${err.message}`);
    throw err;
  }

  if (action.kind === "composite") {
    if (!dispatch) return fail(`composite action "${action.name}" has no sub-step dispatcher`);
    return runComposite(ctx, action, inputs, dispatch);
  }

  // node action: stage the dir, npm install if needed, run `main` in-guest.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) env[inputEnvName(k)] = String(v);

  const hasPackageJson = await access(join(action.dir, "package.json"))
    .then(() => true)
    .catch(() => false);

  const res = await runGuestNode(
    { exec: ctx.exec, hostDir: ctx.workdir, guestDir: ctx.workspacePath, emit: (c) => ctx.emit(c) },
    { srcDir: action.dir, stageName: action.name, main: action.main!, hasPackageJson, env },
  );

  if (!res.ok) {
    return { status: "failure", stdout: res.stdout, stderr: res.stderr || `action "${action.name}" exited ${res.exitCode}` };
  }

  // Surface only declared outputs (undeclared `$WORK_OUTPUT` keys are ignored,
  // declared-but-missing become ""), so action.yaml stays the contract.
  const outputs: Record<string, string> = {};
  for (const key of action.outputs) outputs[key] = res.outputs[key] ?? "";
  return { status: "success", stdout: res.stdout, stderr: res.stderr, outputs };
}

/** Build the `uses: action/<name>` handler (a user-space action). */
export function createActionUsesHandler(opts: ActionUsesHandlerOptions = {}): UsesHandler {
  return {
    scheme: "action",
    async run(ctx: UsesContext): Promise<UsesResult> {
      const fail = (message: string): UsesResult => {
        ctx.emit({ stream: "stderr", text: message });
        return { status: "failure", stderr: message };
      };
      try {
        const { name } = parseActionUses(ctx.uses);
        const base = ctx.workflowDir ?? ctx.projectDir;
        const actionsDir = opts.actionsDir ?? (base ? join(base, "actions") : undefined);
        if (!actionsDir) {
          return fail(
            `cannot resolve action "${name}": no workflow directory for this run (actions live in <workflow-dir>/actions/<name>/)`,
          );
        }
        const action = await loadAction(name, actionsDir);
        return await runAction(ctx, action, opts.dispatch);
      } catch (err) {
        // A target/exec tear-out stays a resumable interruption — don't swallow it.
        if (err instanceof StepInterrupted) throw err;
        return fail((err as Error).message);
      }
    },
  };
}
