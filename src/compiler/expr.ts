/**
 * `${{ ... }}` expression interpolation — context-aware and two-phase.
 *
 * Supported contexts:
 *   - `inputs.<name>`               (resolved at COMPILE time)
 *   - `matrix.<axis>`               (resolved at COMPILE time, per matrix leg)
 *   - `needs.<job>.outputs.<name>`  (resolved at RUNTIME, after the dep finishes)
 *   - `steps.<id>.outputs.<key>`    (resolved at RUNTIME, within the job)
 *   - `event` / `event.a.b.c` / `event.alerts[0].labels.severity`
 *                                   (resolved at COMPILE/INGRESS time from the
 *                                    webhook/dispatch payload — see below)
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
  /**
   * The resolved webhook/dispatch payload, exposed as `${{ event.* }}`. Arbitrary
   * deeply-nested JSON (Alertmanager's `alerts[]`, `commonLabels{}`, …). When
   * absent (undefined) the engine defers `event.*` expressions intact, exactly as
   * it does for `needs`/`steps`, so a later phase can supply it.
   */
  event?: Record<string, unknown>;
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
  const bag = ctx.needs[job];
  if (!bag || !Object.prototype.hasOwnProperty.call(bag.outputs, key)) {
    throw new WorkflowCompileError(`expression references missing output: needs.${job}.outputs.${key}`);
  }
  return bag.outputs[key]!;
};

const resolveSteps: Resolver = (expr, ctx, whole) => {
  const m = /^steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(expr);
  if (!m) return null;
  if (!ctx.steps) return whole; // defer to runtime
  const id = m[1]!;
  const key = m[2]!;
  const bag = ctx.steps[id];
  if (!bag || !Object.prototype.hasOwnProperty.call(bag.outputs, key)) {
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

const RESOLVERS: Resolver[] = [resolveInputs, resolveMatrix, resolveNeeds, resolveSteps, resolveEvent];

function resolveExpr(expr: string, ctx: ExprContext, whole: string): string {
  for (const resolve of RESOLVERS) {
    const out = resolve(expr, ctx, whole);
    if (out !== null) return out;
  }
  throw new WorkflowCompileError(
    `unsupported expression "\${{ ${expr} }}" — supported: inputs.<name>, needs.<job>.outputs.<name>, steps.<id>.outputs.<key>, event.<path>`,
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
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "number" || t === "boolean") return String(value);
  // object | array (functions/symbols won't occur in JSON payloads)
  return JSON.stringify(value);
}
