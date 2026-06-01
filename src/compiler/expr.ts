/**
 * `${{ ... }}` expression interpolation — context-aware and two-phase.
 *
 * Supported contexts:
 *   - `inputs.<name>`               (resolved at COMPILE time)
 *   - `matrix.<axis>`               (resolved at COMPILE time, per matrix leg)
 *   - `needs.<job>.outputs.<name>`  (resolved at RUNTIME, after the dep finishes)
 *   - `steps.<id>.outputs.<key>`    (resolved at RUNTIME, within the job)
 *
 * When the relevant context isn't supplied (e.g. `needs` at compile time), the
 * expression is **left intact** for a later phase rather than erroring. An
 * unknown root (`github`, …) always errors — never silently passes.
 */
import { WorkflowCompileError } from "./compile.ts";

export interface OutputBag {
  outputs: Record<string, string>;
}

export interface ExprContext {
  inputs?: Record<string, string | number | boolean>;
  /** Resolved matrix cell for the current leg; only present in a matrix job. */
  matrix?: Record<string, string | number | boolean>;
  needs?: Record<string, OutputBag>;
  steps?: Record<string, OutputBag>;
}

const EXPR = /\$\{\{\s*([^}]*?)\s*\}\}/g;

export function interpolate(template: string, ctx: ExprContext): string {
  return template.replace(EXPR, (whole, raw: string) => resolveExpr(raw.trim(), ctx, whole));
}

function resolveExpr(expr: string, ctx: ExprContext, whole: string): string {
  let m = /^inputs\.([A-Za-z_][\w-]*)$/.exec(expr) ?? /^inputs\[\s*['"]([^'"]+)['"]\s*\]$/.exec(expr);
  if (m) {
    if (!ctx.inputs) return whole; // defer
    const name = m[1]!;
    if (!Object.prototype.hasOwnProperty.call(ctx.inputs, name)) {
      throw new WorkflowCompileError(`expression references undeclared input "${name}" (declare it under inputs:)`);
    }
    return String(ctx.inputs[name]);
  }

  m = /^matrix\.([A-Za-z_][\w-]*)$/.exec(expr) ?? /^matrix\[\s*['"]([^'"]+)['"]\s*\]$/.exec(expr);
  if (m) {
    if (!ctx.matrix) {
      throw new WorkflowCompileError(
        `matrix context is only available in a job with strategy.matrix (saw "\${{ ${expr} }}")`,
      );
    }
    const name = m[1]!;
    // A matrix property absent from *this* cell resolves to empty — `include`
    // routinely adds a key to only some legs (GHA semantics).
    if (!Object.prototype.hasOwnProperty.call(ctx.matrix, name)) return "";
    return String(ctx.matrix[name]);
  }

  m = /^needs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(expr);
  if (m) {
    if (!ctx.needs) return whole; // defer to runtime
    const job = m[1]!;
    const key = m[2]!;
    const bag = ctx.needs[job];
    if (!bag || !Object.prototype.hasOwnProperty.call(bag.outputs, key)) {
      throw new WorkflowCompileError(`expression references missing output: needs.${job}.outputs.${key}`);
    }
    return bag.outputs[key]!;
  }

  m = /^steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(expr);
  if (m) {
    if (!ctx.steps) return whole; // defer to runtime
    const id = m[1]!;
    const key = m[2]!;
    const bag = ctx.steps[id];
    if (!bag || !Object.prototype.hasOwnProperty.call(bag.outputs, key)) {
      throw new WorkflowCompileError(`expression references missing output: steps.${id}.outputs.${key}`);
    }
    return bag.outputs[key]!;
  }

  throw new WorkflowCompileError(
    `unsupported expression "\${{ ${expr} }}" — supported: inputs.<name>, needs.<job>.outputs.<name>, steps.<id>.outputs.<key>`,
  );
}
