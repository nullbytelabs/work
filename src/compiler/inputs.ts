/**
 * Workflow inputs: resolve a provided JSON body against the declared `inputs:`
 * block, and interpolate `${{ inputs.<name> }}` expressions.
 *
 * Resolution + interpolation happen at COMPILE time, so the durable execution
 * plan contains concrete values — the runtime never sees an expression.
 */
import type { InputSpec } from "../spec/index.ts";
import { WorkflowCompileError } from "./compile.ts";

/** Resolved input values, keyed by name. */
export type ResolvedInputs = Record<string, string | number | boolean>;

/**
 * Validate the provided inputs against the declared spec and produce concrete
 * values (applying defaults, enforcing required, coercing to declared types).
 */
export function resolveInputs(
  declared: Record<string, InputSpec> | undefined,
  provided: Record<string, unknown>,
): ResolvedInputs {
  const decl = declared ?? {};

  for (const key of Object.keys(provided)) {
    if (!(key in decl)) {
      throw new WorkflowCompileError(`unknown input "${key}" (not declared in inputs:)`);
    }
  }

  const out: ResolvedInputs = {};
  for (const [name, spec] of Object.entries(decl)) {
    const type = spec.type ?? "string";
    let value: unknown;
    let present = true;
    if (Object.prototype.hasOwnProperty.call(provided, name)) {
      value = provided[name];
    } else if (spec.default !== undefined) {
      value = spec.default;
    } else if (spec.required) {
      throw new WorkflowCompileError(`required input "${name}" was not provided`);
    } else {
      // Optional + unprovided + no default: a type-appropriate empty sentinel.
      value = type === "number" ? 0 : type === "boolean" ? false : "";
      present = false;
    }

    const resolved = validateType(name, type, value);
    // Only run value constraints when the input was actually supplied (provided
    // or via an explicit default) — an absent optional input isn't validated.
    if (present) validateConstraints(name, spec, resolved);
    out[name] = resolved;
  }
  return out;
}

function validateConstraints(name: string, spec: InputSpec, value: string | number | boolean): void {
  if (spec.options && !spec.options.some((o) => o === value)) {
    throw new WorkflowCompileError(
      `input "${name}" must be one of: ${spec.options.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  if (spec.pattern && typeof value === "string" && !new RegExp(spec.pattern).test(value)) {
    throw new WorkflowCompileError(`input "${name}" does not match required pattern ${spec.pattern}`);
  }
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Strict type check: the provided JSON value's type must match the declared
 * type. No coercion — a string `"36"` is NOT accepted for a `number` input, so
 * mismatches are rejected rather than silently converted.
 */
function validateType(name: string, type: string, value: unknown): string | number | boolean {
  if (type === "number") {
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    throw new WorkflowCompileError(`input "${name}" must be a number (got ${jsonType(value)})`);
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    throw new WorkflowCompileError(`input "${name}" must be a boolean (got ${jsonType(value)})`);
  }
  if (typeof value === "string") return value;
  throw new WorkflowCompileError(`input "${name}" must be a string (got ${jsonType(value)})`);
}

// Matches `${{ ... }}`. The inner group can't contain `}`, which is fine for the
// supported `inputs.<name>` form and keeps the close unambiguous.
const EXPR = /\$\{\{\s*([^}]*?)\s*\}\}/g;

/**
 * Replace every `${{ inputs.<name> }}` in `template` with the resolved value.
 * Throws on unsupported expressions or references to undeclared inputs — a
 * condition is never silently left in place.
 */
export function interpolate(template: string, inputs: ResolvedInputs): string {
  return template.replace(EXPR, (_match, expr: string) => {
    const name = inputName(expr);
    if (!Object.prototype.hasOwnProperty.call(inputs, name)) {
      throw new WorkflowCompileError(`expression references undeclared input "${name}" (declare it under inputs:)`);
    }
    return String(inputs[name]);
  });
}

function inputName(expr: string): string {
  const e = expr.trim();
  let m = /^inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(e);
  if (m) return m[1]!;
  m = /^inputs\[\s*'([^']+)'\s*\]$/.exec(e) ?? /^inputs\[\s*"([^"]+)"\s*\]$/.exec(e);
  if (m) return m[1]!;
  throw new WorkflowCompileError(
    `unsupported expression "\${{ ${e} }}" — only \${{ inputs.<name> }} is supported`,
  );
}
