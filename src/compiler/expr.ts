/**
 * `${{ ... }}` expression interpolation — context-aware and two-phase.
 *
 * Supported contexts:
 *   - `inputs.<name>`               (resolved at COMPILE time)
 *   - `matrix.<axis>`               (resolved at COMPILE time, per matrix leg)
 *   - `needs.<job>.outputs.<name>`  (resolved at RUNTIME, after the dep finishes)
 *   - `steps.<id>.outputs.<key>`    (resolved at RUNTIME, within the job)
 *   - `steps.<id>.logs` / `.outcome` / `.exitCode`
 *                                   (resolved at RUNTIME — the step's captured
 *                                    combined output, result, and exit code)
 *   - `secrets.<name>`              (resolved at RUNTIME from `work.json`'s
 *                                    `secrets:` whitelist — a value materialized
 *                                    into the guest env; see docs/egress-walk-back.md.
 *                                    Deferred at compile so it never lands in the
 *                                    durable plan/journal.)
 *   - `event` / `event.a.b.c` / `event.alerts[0].labels.severity`
 *                                   (resolved at COMPILE/INGRESS time from the
 *                                    webhook/dispatch payload — see below)
 *
 * When the relevant context isn't supplied (e.g. `needs` at compile time), the
 * expression is **left intact** for a later phase rather than erroring. An
 * unknown root (`github`, …) always errors — never silently passes.
 */
import { WorkflowCompileError } from "./compile.ts";
import { DOCS } from "../errors.ts";

export interface OutputBag {
  outputs: Record<string, string>;
}

/**
 * What a *step* exposes to expressions. Beyond its declared `outputs` (values it
 * wrote to `$WORK_OUTPUT`), the engine surfaces data it already captures for
 * every step at no extra cost:
 *   - `logs`     — the step's combined stdout+stderr
 *   - `outcome`  — "success" | "failure" | "skipped" (mirrors GitHub Actions)
 *   - `exitCode` — the command's exit code
 * These let a job forward a tool's output downstream (`outputs: { lint: ${{
 * steps.lint.logs }} }`) without a hand-rolled `$WORK_OUTPUT` capture wrapper.
 */
export interface StepBag extends OutputBag {
  logs?: string;
  outcome?: string;
  exitCode?: number;
}

export interface ExprContext {
  inputs?: Record<string, string | number | boolean>;
  /** Resolved matrix cell for the current leg; only present in a matrix job. */
  matrix?: Record<string, string | number | boolean>;
  needs?: Record<string, OutputBag>;
  steps?: Record<string, StepBag>;
  /**
   * The resolved webhook/dispatch payload, exposed as `${{ event.* }}`. Arbitrary
   * deeply-nested JSON (Alertmanager's `alerts[]`, `commonLabels{}`, …). When
   * absent (undefined) the engine defers `event.*` expressions intact, exactly as
   * it does for `needs`/`steps`, so a later phase can supply it.
   */
  event?: Record<string, unknown>;
  /**
   * The `work.json` `secrets:` whitelist, resolved (`$ENV`-expanded) host-side and
   * supplied only at RUNTIME. Present → `secrets.<name>` resolves to its value;
   * absent (compile time) → deferred intact, so the value never bakes into the
   * durable plan. A passthrough into the guest (path b) — for credentials a CLI
   * must hold to sign (aws/gcloud/kubectl). See docs/egress-walk-back.md.
   */
  secrets?: Record<string, string>;
}

const EXPR = /\$\{\{\s*([^}]*?)\s*\}\}/g;

export function interpolate(template: string, ctx: ExprContext): string {
  return template.replace(EXPR, (whole, raw: string) => resolveExpr(raw.trim(), ctx, whole));
}

/**
 * The trimmed bodies of every `${{ … }}` span in a template. Used by the reusable
 * compiler to inspect `with:` expressions for runtime roots (`needs`/`steps`),
 * which are illegal in a compile-time-bound `with:`. A fresh regex per call keeps
 * the shared global `EXPR` free of `lastIndex` state.
 */
export function expressionBodies(template: string): string[] {
  const out: string[] = [];
  const re = new RegExp(EXPR.source, EXPR.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) out.push(m[1]!.trim());
  return out;
}

/**
 * Replace each `${{ body }}` span via `fn`, which receives the trimmed body and
 * returns the **full replacement text** (including a new `${{ }}` if desired).
 * Used to parse a callee's `workflow_call.outputs` (`jobs.<id>.outputs.<k>`) when
 * inlining a reusable call.
 */
export function replaceExpressions(template: string, fn: (body: string) => string): string {
  return template.replace(new RegExp(EXPR.source, EXPR.flags), (_whole, raw: string) => fn(raw.trim()));
}

/**
 * A single context resolver: returns the resolved string for an expression it
 * recognizes, or `null` if the expression isn't its pattern (so the next
 * resolver gets a turn). A recognized-but-deferred expression returns `whole`
 * (the verbatim `${{ … }}`); a recognized-but-invalid one throws.
 */
type Resolver = (expr: string, ctx: ExprContext, whole: string) => string | null;

const resolveInputs: Resolver = (expr, ctx, whole) => {
  const m = /^inputs\.([A-Za-z_][\w-]*)$/.exec(expr) ?? /^inputs\[\s*['"]([^'"]+)['"]\s*\]$/.exec(expr);
  if (!m) return null;
  if (!ctx.inputs) return whole; // defer
  const name = m[1]!;
  if (!Object.prototype.hasOwnProperty.call(ctx.inputs, name)) {
    throw new WorkflowCompileError(`expression references undeclared input "${name}" (declare it under inputs:)`);
  }
  return String(ctx.inputs[name]);
};

const resolveMatrix: Resolver = (expr, ctx) => {
  const m = /^matrix\.([A-Za-z_][\w-]*)$/.exec(expr) ?? /^matrix\[\s*['"]([^'"]+)['"]\s*\]$/.exec(expr);
  if (!m) return null;
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
};

const resolveNeeds: Resolver = (expr, ctx, whole) => {
  const m = /^needs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(expr);
  if (!m) return null;
  if (!ctx.needs) return whole; // defer to runtime
  const job = m[1]!;
  const key = m[2]!;
  // `Object.hasOwn`, not a bare index — `ctx.needs` is a plain object with a live
  // prototype, so `ctx.needs["toString"]` would return the inherited function
  // (truthy) and slip past the `!bag` guard, then crash on `bag.outputs`. A name
  // that isn't a real dep must read as missing, matching walkPath's guard below.
  const bag = Object.hasOwn(ctx.needs, job) ? ctx.needs[job] : undefined;
  if (!bag || !Object.prototype.hasOwnProperty.call(bag.outputs, key)) {
    throw new WorkflowCompileError(`expression references missing output: needs.${job}.outputs.${key}`, {
      hint: `declare "${key}" as an output of job "${job}" (write it to $WORK_OUTPUT, or set it under that job's outputs:)`,
      docs: DOCS.workflowSyntax,
    });
  }
  return bag.outputs[key]!;
};

const resolveSteps: Resolver = (expr, ctx, whole) => {
  // Either a declared output (`steps.<id>.outputs.<key>`) or a built-in the
  // engine captures for free (`steps.<id>.logs` / `.outcome` / `.exitCode`).
  const m = /^steps\.([A-Za-z_][\w-]*)\.(?:outputs\.([A-Za-z_][\w-]*)|(logs|outcome|exitCode))$/.exec(expr);
  if (!m) return null;
  if (!ctx.steps) return whole; // defer to runtime
  const id = m[1]!;
  // `Object.hasOwn`, not a bare index — an inherited Object.prototype member
  // (`toString`, `constructor`, …) would otherwise resolve to a function, sail
  // past the `!bag` guard, and return a silent "" for `.logs`/an output instead
  // of the clean "unknown step" error.
  const bag = Object.hasOwn(ctx.steps, id) ? ctx.steps[id] : undefined;
  if (!bag) {
    throw new WorkflowCompileError(`expression references unknown step: steps.${id}`);
  }
  const builtin = m[3];
  if (builtin === "logs") return bag.logs ?? "";
  if (builtin === "outcome") return bag.outcome ?? "";
  if (builtin === "exitCode") return bag.exitCode !== undefined ? String(bag.exitCode) : "";
  const key = m[2]!;
  if (!Object.prototype.hasOwnProperty.call(bag.outputs, key)) {
    throw new WorkflowCompileError(`expression references missing output: steps.${id}.outputs.${key}`);
  }
  return bag.outputs[key]!;
};

// `event` — the webhook/dispatch payload. Unlike the flat-regex roots above,
// this supports arbitrary-depth path access AND array indexing, because a real
// payload is deeply nested (`event.alerts[0].labels.severity`). We tokenize the
// access path ourselves rather than bolt on more regexes.
const resolveEvent: Resolver = (expr, ctx, whole) => {
  if (expr !== "event" && !expr.startsWith("event.") && !expr.startsWith("event[")) return null;
  // Defer, exactly like needs/steps, when no payload is supplied — a later
  // phase (the ingress/receiver) will re-interpolate with `event` present.
  if (ctx.event === undefined) return whole;
  const segments = parseAccessPath(expr);
  // segments[0] is the literal "event" root; walk the remainder.
  const value = walkPath(ctx.event, segments.slice(1));
  return stringifyValue(value);
};

const resolveSecrets: Resolver = (expr, ctx, whole) => {
  const m = /^secrets\.([A-Za-z_][\w-]*)$/.exec(expr) ?? /^secrets\[\s*['"]([^'"]+)['"]\s*\]$/.exec(expr);
  if (!m) return null;
  if (!ctx.secrets) return whole; // defer to runtime — never bake a secret into the plan
  const name = m[1]!;
  if (!Object.prototype.hasOwnProperty.call(ctx.secrets, name)) {
    throw new WorkflowCompileError(
      `expression references undeclared secret "${name}" (add it to the secrets: block in work.json)`,
    );
  }
  return ctx.secrets[name]!;
};

const RESOLVERS: Resolver[] = [resolveInputs, resolveMatrix, resolveNeeds, resolveSteps, resolveEvent, resolveSecrets];

function resolveExpr(expr: string, ctx: ExprContext, whole: string): string {
  for (const resolve of RESOLVERS) {
    const out = resolve(expr, ctx, whole);
    if (out !== null) return out;
  }
  throw new WorkflowCompileError(
    `unsupported expression "\${{ ${expr} }}" — supported: inputs.<name>, needs.<job>.outputs.<name>, steps.<id>.outputs.<key>, steps.<id>.(logs|outcome|exitCode), event.<path>, secrets.<name>`,
    { docs: DOCS.workflowSyntax },
  );
}

/** A single resolved access-path segment: an object key or an array index. */
export type Segment = { kind: "key"; name: string } | { kind: "index"; index: number };

/**
 * Tokenize a context access path into segments, supporting three forms after the
 * root identifier: `.name` (dotted key), `[<integer>]` (array index), and
 * `['key']` / `["key"]` (bracketed key — for keys that aren't bare identifiers).
 * The leading root (`event`) is the first segment.
 *
 * Examples:
 *   `event`                              → [event]
 *   `event.alerts[0].labels.severity`    → [event, alerts, [0], labels, severity]
 *   `event['commonLabels'].severity`     → [event, commonLabels, severity]
 *
 * Exported so the condition engine can share the exact same indexing grammar.
 */
/** Index of the `]` that closes the `[` at `open`, skipping any `]` that sits
 *  inside a quoted key (e.g. `event['a]b']`). Returns -1 if unbalanced. Shared
 *  by the expression and condition parsers so both index brackets identically. */
export function closingBracket(src: string, open: number): number {
  let quote: string | undefined;
  for (let k = open + 1; k < src.length; k++) {
    const ch = src[k]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "]") {
      return k;
    }
  }
  return -1;
}

export function parseAccessPath(expr: string): Segment[] {
  const segs: Segment[] = [];
  let i = 0;
  const n = expr.length;

  // Root identifier (e.g. `event`).
  if (!/[A-Za-z_]/.test(expr[i] ?? "")) {
    throw new WorkflowCompileError(`malformed expression "\${{ ${expr} }}"`);
  }
  let j = i + 1;
  while (j < n && /[A-Za-z0-9_-]/.test(expr[j]!)) j++;
  segs.push({ kind: "key", name: expr.slice(i, j) });
  i = j;

  while (i < n) {
    const c = expr[i]!;
    if (c === ".") {
      i++;
      if (!/[A-Za-z_]/.test(expr[i] ?? "")) {
        throw new WorkflowCompileError(`malformed path after "." in "\${{ ${expr} }}"`);
      }
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_-]/.test(expr[k]!)) k++;
      segs.push({ kind: "key", name: expr.slice(i, k) });
      i = k;
      continue;
    }
    if (c === "[") {
      const close = closingBracket(expr, i);
      if (close === -1) throw new WorkflowCompileError(`unbalanced "[" in "\${{ ${expr} }}"`);
      const inner = expr.slice(i + 1, close).trim();
      const sm = /^['"]([\s\S]*)['"]$/.exec(inner);
      if (sm) {
        segs.push({ kind: "key", name: sm[1]! });
      } else if (/^\d+$/.test(inner)) {
        segs.push({ kind: "index", index: Number(inner) });
      } else {
        throw new WorkflowCompileError(`invalid index "[${inner}]" in "\${{ ${expr} }}" (expected an integer or a quoted key)`);
      }
      i = close + 1;
      continue;
    }
    throw new WorkflowCompileError(`unexpected "${c}" in path "\${{ ${expr} }}"`);
  }
  return segs;
}

/**
 * Walk parsed access-path segments through an object. A missing key, an
 * out-of-range index, or a non-object/non-array intermediate yields `undefined`
 * (the "missing" case) — never a throw, mirroring GHA's null-for-missing.
 */
export function walkPath(root: unknown, segments: Segment[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (seg.kind === "index") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.index];
    } else {
      // Own properties only: untrusted payloads (the webhook `event`) flow through
      // here, so a key like `constructor`/`__proto__`/`toString` must read as
      // "missing", never reach an inherited builtin. Matches the hasOwnProperty
      // guards on the other context roots (resolveInputs/resolveMatrix in this file).
      if (!Object.hasOwn(cur, seg.name)) return undefined;
      cur = (cur as Record<string, unknown>)[seg.name];
    }
  }
  return cur;
}

/**
 * Stringify a resolved `event` value for interpolation into a `run:`/`env:`/etc.
 * string. Deliberately GHA-ish and defined explicitly:
 *   - `null` / `undefined` (missing) → "" (empty string)
 *   - a scalar (string/number/boolean) → `String(value)`
 *   - any non-scalar (object/array, incl. the whole `${{ event }}`) → `JSON.stringify(value)`
 *
 * Every string is passed through `neutralizeExpressionOpeners` first — `event` is
 * the ONE untrusted context root (an internet-facing webhook body), and its values
 * bake into plan strings at compile time that the runtime later re-interpolates
 * with `needs`/`steps`/`secrets` in scope. Without neutralization, a payload field
 * whose value is `${{ secrets.token }}` would become a live deferred expression
 * and resolve to the real secret at runtime (the GHA `pull_request_target`
 * injection class) — with open egress carrying it anywhere.
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const t = typeof value;
  if (t === "string") return neutralizeExpressionOpeners(value as string);
  if (t === "number" || t === "boolean") return String(value);
  // object | array (functions/symbols won't occur in JSON payloads)
  return neutralizeExpressionOpeners(JSON.stringify(value));
}

/**
 * Break every `${{` in untrusted text so it can never re-form a `${{ … }}` span
 * in the interpolated output. The inserted space (`${ {`) keeps the text readable
 * while making it unmatchable by `EXPR` (which requires the literal `${{` pair) —
 * and the replacement can't recombine with adjacent text into a new opener, since
 * every original `${{` is consumed and `${ {` never ends in `$` or `${`.
 */
function neutralizeExpressionOpeners(s: string): string {
  return s.replaceAll("${{", "${ {");
}
