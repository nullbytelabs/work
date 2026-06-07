/**
 * The composite-action runner — Strategy B from docs/agent-primitive-and-actions.md.
 *
 * A composite action (`runs.using: composite`) is a step bundle: each inner step is
 * a `run:` command, a `uses: work/agent`, or a `uses:` of another action. The whole
 * action runs as the caller's **single** durable `uses:` checkpoint; this runner is
 * the mini step-loop inside it. It preserves runtime `with:` (an inner `uses:` step
 * may pass `${{ steps.prev.outputs.x }}`), which is why it's a runtime handler
 * rather than compile-time inlining.
 *
 * Reuse: `interpolate(text, { inputs, steps })` (the same expression engine the core
 * runtime uses) resolves `${{ inputs.* }}` / `${{ steps.*.outputs.* }}`, and
 * `parseOutputFile` parses an inner `run:` step's `$WORK_OUTPUT`.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { interpolate, type ExprContext, type OutputBag, type ResolvedInputs } from "../compiler/index.ts";
import { parseOutputFile } from "../runtime/index.ts";
import type { UsesContext, UsesResult } from "../runtime/types.ts";
import type { CompositeStep, LoadedAction } from "./load.ts";

/** Run a `uses:` sub-step by routing to the registered handler for its scheme. */
export type SubUsesDispatch = (ctx: UsesContext) => Promise<UsesResult>;

/** Map an input name to its `INPUT_<NAME>` env var (GitHub Actions ABI). Composite
 *  `run:` steps reference `${{ inputs.x }}`, but we also expose `INPUT_*` so scripts
 *  can use shell-quoted env vars (safer than interpolating values into the command). */
function inputEnv(inputs: ResolvedInputs): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.replace(/[^\w]/g, "_").toUpperCase()}`] = String(v);
  return env;
}

/** Run the composite action's steps, returning the action's mapped outputs. */
export async function runComposite(
  ctx: UsesContext,
  action: LoadedAction,
  inputs: ResolvedInputs,
  dispatch: SubUsesDispatch,
): Promise<UsesResult> {
  const stepOutputs: Record<string, OutputBag> = {};
  const exprCtx = (): ExprContext => ({ inputs, steps: stepOutputs });
  const baseEnv = inputEnv(inputs);

  let n = 0;
  for (const step of action.steps ?? []) {
    n++;
    const label = step.name ?? step.run ?? step.uses ?? `step ${n}`;
    const bag = step.run !== undefined
      ? await runCompositeRun(ctx, step, exprCtx(), baseEnv, n)
      : await runCompositeUses(ctx, step, exprCtx(), dispatch);

    if (step.id) stepOutputs[step.id] = { outputs: bag.outputs };
    if (!bag.ok) {
      return { status: "failure", stdout: bag.stdout, stderr: bag.stderr || `composite step "${label}" failed` };
    }
  }

  // Map declared outputs (the `value:` expressions) through interpolation.
  const outputs: Record<string, string> = {};
  for (const [k, expr] of Object.entries(action.outputValues ?? {})) {
    outputs[k] = interpolate(expr, exprCtx());
  }
  return { status: "success", outputs };
}

interface StepBag {
  ok: boolean;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
}

/** A composite `run:` step: interpolate, exec in-guest, capture `$WORK_OUTPUT`. */
async function runCompositeRun(
  ctx: UsesContext,
  step: CompositeStep,
  expr: ExprContext,
  baseEnv: Record<string, string>,
  n: number,
): Promise<StepBag> {
  const command = interpolate(step.run!, expr);
  const env: Record<string, string> = { ...baseEnv };
  for (const [k, v] of Object.entries(step.env ?? {})) env[k] = interpolate(v, expr);

  const outName = `.work-output-composite-${n}`;
  const hostOutFile = join(ctx.workdir, outName);
  env["WORK_OUTPUT"] = `${ctx.workspacePath}/${outName}`;
  await rm(hostOutFile, { force: true });

  const run = await ctx.exec(command, { env, onOutput: (c) => ctx.emit(c) });
  const outputs = run.ok ? parseOutputFile(await readFile(hostOutFile, "utf-8").catch(() => "")) : {};
  return { ok: run.ok, stdout: run.stdout, stderr: run.stderr, outputs };
}

/** A composite `uses:` sub-step: interpolate `with`, dispatch to its handler. */
async function runCompositeUses(
  ctx: UsesContext,
  step: CompositeStep,
  expr: ExprContext,
  dispatch: SubUsesDispatch,
): Promise<StepBag> {
  const withMap: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.with ?? {})) withMap[k] = typeof v === "string" ? interpolate(v, expr) : v;

  const subCtx: UsesContext = { ...ctx, uses: step.uses!, with: withMap };
  const res = await dispatch(subCtx);
  return {
    ok: res.status === "success",
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    outputs: res.outputs ?? {},
  };
}
