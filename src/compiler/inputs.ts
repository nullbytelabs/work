/**
 * Workflow inputs: resolve a provided JSON body against the declared `inputs:`
 * block (validate types, defaults, options, pattern). `${{ inputs.<name> }}`
 * interpolation itself lives in `./expr.ts` and runs at compile time, so the
 * durable execution plan contains concrete input values.
 */
import type { InputSpec } from "../spec/index.ts";
import { WorkflowCompileError } from "./compile.ts";
import { DOCS } from "../errors.ts";

/** Resolved input values, keyed by name. */
export type ResolvedInputs = Record<string, string | number | boolean>;

/**
 * Validate the provided inputs against the declared spec and produce concrete
 * values (applying defaults, enforcing required, coercing to declared types).
 *
 * `deferred` names inputs whose provided value is a runtime expression (a
 * `${{ needs.* }}` reference a reusable caller passed through `with:`). Their
 * value isn't known at compile time, so it can't be type- or constraint-checked
 * here — it's passed through verbatim as a string for substitution into the
 * callee, where `${{ inputs.<name> }}` expands to that expression and resolves at
 * runtime like any other `needs.*`.
 */
export function resolveInputs(
  declared: Record<string, InputSpec> | undefined,
  provided: Record<string, unknown>,
  deferred?: Set<string>,
): ResolvedInputs {
  const decl = declared ?? {};
  const deferredKeys = deferred ?? new Set<string>();

  for (const key of Object.keys(provided)) {
    // `Object.hasOwn`, not `in` — `in` walks the prototype, so a provided key that
    // is an Object.prototype member (`toString`, `constructor`, `__proto__`, …)
    // would read as "declared" and slip past this check, then get silently dropped
    // by the own-properties-only `Object.entries(decl)` loop below. Matches the
    // convention in compile.ts/reusable.ts/expr.ts.
    if (!Object.hasOwn(decl, key)) {
      throw new WorkflowCompileError(`unknown input "${key}"`, {
        path: "inputs",
        hint: `declared inputs: ${Object.keys(decl).join(", ") || "(none)"}`,
        docs: DOCS.configuration,
      });
    }
  }

  const out: ResolvedInputs = {};
  for (const [name, spec] of Object.entries(decl)) {
    const type = spec.type ?? "string";
    // Runtime-deferred input: keep the `${{ needs.* }}` expression as-is.
    if (deferredKeys.has(name) && Object.prototype.hasOwnProperty.call(provided, name)) {
      out[name] = String(provided[name]);
      continue;
    }
    let value: unknown;
    let present = true;
    if (Object.prototype.hasOwnProperty.call(provided, name)) {
      value = provided[name];
    } else if (spec.default !== undefined) {
      value = spec.default;
    } else if (spec.required) {
      throw new WorkflowCompileError(`required input "${name}" was not provided`, {
        path: `inputs.${name}`,
        hint: `pass it with --inputs '{"${name}": …}'`,
      });
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
