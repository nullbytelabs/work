/**
 * The `action` uses-handler — runs a user-space JavaScript action.
 *
 * It bridges the durable core's generic `UsesHandler` to the action layer: parse
 * `action/<name>`, load the package, validate the step's `with:` against the
 * action's declared `inputs:`, run the `main` script in-guest with the
 * GitHub-faithful `INPUT_*` / `$WORK_OUTPUT` ABI, and surface the declared
 * outputs. The runtime core imports none of this — the composition root registers
 * the handler (exactly like the agent handler).
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { UsesHandler, UsesContext, UsesResult } from "../runtime/types.ts";
import { resolveInputs, WorkflowCompileError } from "../compiler/index.ts";
import { parseActionUses, loadAction } from "./load.ts";
import { runGuestNode } from "./guest-node.ts";

export interface ActionUsesHandlerOptions {
  /**
   * Override where action packages are resolved from. By default they are
   * project-local: `<workflowDir>/actions/`. Set this to pin a fixed search dir
   * (e.g. in tests).
   */
  actionsDir?: string;
}

/** Map an input name to its `INPUT_<NAME>` env var (GitHub Actions ABI). */
function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/[^\w]/g, "_").toUpperCase()}`;
}

/** Build the `uses: action/<name>` handler (a user-space JavaScript action). */
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

        // Validate + coerce `with:` against the action's declared inputs (reusing
        // the workflow input validator). A validation error is a step failure,
        // not a thrown crash.
        let inputs: Record<string, string | number | boolean>;
        try {
          inputs = resolveInputs(action.inputs, ctx.with);
        } catch (err) {
          if (err instanceof WorkflowCompileError) return fail(`action "${name}": ${err.message}`);
          throw err;
        }

        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(inputs)) env[inputEnvName(k)] = String(v);

        const hasPackageJson = await access(join(action.dir, "package.json"))
          .then(() => true)
          .catch(() => false);

        const emit = (c: { stream: "stdout" | "stderr"; text: string }) => ctx.emit(c);
        const res = await runGuestNode(
          { exec: ctx.exec, hostDir: ctx.workdir, guestDir: ctx.workspacePath, emit },
          { srcDir: action.dir, stageName: name, main: action.main, hasPackageJson, env },
        );

        if (!res.ok) {
          return {
            status: "failure",
            stdout: res.stdout,
            stderr: res.stderr || `action "${name}" exited ${res.exitCode}`,
          };
        }

        // Surface only declared outputs (undeclared `$WORK_OUTPUT` keys are
        // ignored, declared-but-missing become ""), so action.yaml stays the
        // contract — mirroring the agent outputs convention.
        const outputs: Record<string, string> = {};
        for (const key of action.outputs) outputs[key] = res.outputs[key] ?? "";

        return { status: "success", stdout: res.stdout, stderr: res.stderr, outputs };
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
}
