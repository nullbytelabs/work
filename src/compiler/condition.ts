/**
 * `if:` / `when:` condition evaluation — a small, safe boolean expression engine.
 *
 * This is deliberately a *pragmatic subset* of the GitHub-Actions expression
 * language, covering what the engine actually needs to gate jobs and steps:
 *
 *   - Context access:  inputs.<name>, matrix.<axis>,
 *                      needs.<job>.result, needs.<job>.outputs.<key>,
 *                      steps.<id>.result, steps.<id>.outputs.<key>,
 *                      event.<path> (incl. array indexing: event.alerts[0].labels.severity)
 *   - Literals:        'single' / "double" strings, numbers, true / false / null
 *   - Operators:       == != && || !  and parentheses
 *   - Status functions: success() failure() always() cancelled()
 *
 * It is a hand-written tokenizer + recursive-descent parser (no `eval`, no
 * dependencies). The condition string may be wrapped in `${{ ... }}` (as in the
 * README examples) or written bare — both are accepted.
 *
 * Anything outside this grammar (unknown context root, comparison operators like
 * `<`, helper functions like `contains()`) raises a clear error rather than
 * silently passing, so an unsupported condition is never mistaken for `true`.
 */
import { parseAccessPath, walkPath, type Segment } from "./expr.ts";

/** A scalar value flowing through the evaluator. */
type Value = string | number | boolean | null | undefined;

/** A job/step's terminal status, for the status functions. */
export interface ConditionStatus {
  /** `success()` — true when nothing has failed so far. */
  success: boolean;
  /** `failure()` — true when something has failed. */
  failure: boolean;
  /** `cancelled()` — true when the run was cancelled (not modeled yet → false). */
  cancelled?: boolean;
}

/** Outputs (+ optional result) exposed by a dependency job or a prior step. */
export interface ConditionBag {
  result?: string;
  outputs: Record<string, string>;
}

/** Everything a condition may read. Missing contexts default to empty. */
export interface ConditionContext {
  inputs?: Record<string, Value>;
  needs?: Record<string, ConditionBag>;
  steps?: Record<string, ConditionBag>;
  /** Present only inside a matrix leg; referencing `matrix.*` elsewhere errors. */
  matrix?: Record<string, Value>;
  /**
   * The webhook/dispatch payload, readable as `event.<path>` (incl. array
   * indexing) in `if:`/`when:`. Arbitrary nested JSON; a missing member yields
   * undefined. Populated by the runtime from `plan.event` (wired separately).
   */
  event?: Record<string, unknown>;
  status?: ConditionStatus;
}

export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionError";
  }
}

// --- Tokenizer ---------------------------------------------------------------

type Tok =
  | { t: "op"; v: "==" | "!=" | "&&" | "||" | "!" }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "ident"; v: string }
  | { t: "eof" };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === "=" || c === "&" || c === "|") {
      const pair = src.slice(i, i + 2);
      if (pair === "==" || pair === "&&" || pair === "||") {
        toks.push({ t: "op", v: pair });
        i += 2;
        continue;
      }
      throw new ConditionError(`unexpected "${c}" (did you mean "${c}${c}"?)`);
    }
    if (c === "!") {
      if (src[i + 1] === "=") {
        toks.push({ t: "op", v: "!=" });
        i += 2;
      } else {
        toks.push({ t: "op", v: "!" });
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== quote) {
        // GHA escapes a quote by doubling it inside the same quote style.
        if (src[j] === quote && src[j + 1] === quote) {
          out += quote;
          j += 2;
          continue;
        }
        out += src[j];
        j++;
      }
      if (j >= n) throw new ConditionError("unterminated string literal");
      toks.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j]!)) j++;
      const text = src.slice(i, j);
      const num = Number(text);
      if (Number.isNaN(num)) throw new ConditionError(`invalid number "${text}"`);
      toks.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      // A context path: dotted keys plus optional `[...]` index/key segments,
      // e.g. `event.alerts[0].labels.severity`. We consume the whole path as one
      // ident token; parsePrimary tokenizes its internal structure. Bracket
      // contents are slurped verbatim (they may hold quotes/spaces) up to `]`.
      let j = i + 1;
      while (j < n) {
        const d = src[j]!;
        if (IDENT_PART.test(d) || d === ".") {
          j++;
        } else if (d === "[") {
          const close = src.indexOf("]", j);
          if (close === -1) throw new ConditionError("unbalanced '[' in context path");
          j = close + 1;
        } else {
          break;
        }
      }
      const word = src.slice(i, j);
      if (word === "true" || word === "false") toks.push({ t: "bool", v: word === "true" });
      else if (word === "null") toks.push({ t: "null" });
      else toks.push({ t: "ident", v: word });
      i = j;
      continue;
    }
    throw new ConditionError(`unexpected character "${c}" in condition`);
  }
  toks.push({ t: "eof" });
  return toks;
}

// --- AST ---------------------------------------------------------------------

type Node =
  | { k: "lit"; v: Value }
  | { k: "path"; segments: Segment[] }
  | { k: "call"; name: string }
  | { k: "not"; e: Node }
  | { k: "bin"; op: "==" | "!=" | "&&" | "||"; l: Node; r: Node };

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.pos]!;
  }
  private next(): Tok {
    return this.toks[this.pos++]!;
  }

  parse(): Node {
    const node = this.parseOr();
    if (this.peek().t !== "eof") throw new ConditionError("unexpected trailing tokens in condition");
    return node;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek().t === "op" && (this.peek() as { v: string }).v === "||") {
      this.next();
      left = { k: "bin", op: "||", l: left, r: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseEquality();
    while (this.peek().t === "op" && (this.peek() as { v: string }).v === "&&") {
      this.next();
      left = { k: "bin", op: "&&", l: left, r: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): Node {
    let left = this.parseUnary();
    while (this.peek().t === "op" && ((this.peek() as { v: string }).v === "==" || (this.peek() as { v: string }).v === "!=")) {
      const op = (this.next() as { v: "==" | "!=" }).v;
      left = { k: "bin", op, l: left, r: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.peek().t === "op" && (this.peek() as { v: string }).v === "!") {
      this.next();
      return { k: "not", e: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const tok = this.next();
    switch (tok.t) {
      case "lparen": {
        const e = this.parseOr();
        if (this.next().t !== "rparen") throw new ConditionError("missing closing ')'");
        return e;
      }
      case "str":
        return { k: "lit", v: tok.v };
      case "num":
        return { k: "lit", v: tok.v };
      case "bool":
        return { k: "lit", v: tok.v };
      case "null":
        return { k: "lit", v: null };
      case "ident": {
        // A zero-arg function call (`success()`), else a context path.
        if (this.peek().t === "lparen") {
          this.next(); // (
          if (this.next().t !== "rparen") {
            throw new ConditionError(`function "${tok.v}" takes no arguments`);
          }
          return { k: "call", name: tok.v };
        }
        // Parse the dotted/bracketed path into structured segments (the same
        // grammar `interpolate` uses), so array indexing works identically here.
        try {
          return { k: "path", segments: parseAccessPath(tok.v) };
        } catch (err) {
          throw new ConditionError((err as Error).message);
        }
      }
      default:
        throw new ConditionError("unexpected token in condition");
    }
  }
}

// --- Evaluation --------------------------------------------------------------

const ROOTS = new Set(["inputs", "needs", "steps", "matrix", "event"]);

function truthy(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  return false; // null / undefined
}

/** A loose, intuitive equality: numeric when both look numeric, else by string. */
function looseEq(a: Value, b: Value): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const na = numeric(a);
  const nb = numeric(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a) === String(b);
}

function numeric(v: Value): number | null {
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

function resolvePath(segments: Segment[], ctx: ConditionContext): Value {
  // The root is always a bare key (the tokenizer requires an identifier start).
  const head = segments[0]!;
  const root = head.kind === "key" ? head.name : String(head.index);
  if (!ROOTS.has(root)) {
    throw new ConditionError(
      `unknown context "${root}" — supported: inputs, needs, steps, matrix, event (and success()/failure()/always()/cancelled())`,
    );
  }
  if (root === "matrix" && ctx.matrix === undefined) {
    throw new ConditionError("matrix context is only available in a job with strategy.matrix");
  }
  // Walk the remaining segments (keys + array indices) through plain objects and
  // arrays; a missing property/index yields undefined (GHA returns null for a
  // missing context member). The walk is shared with `interpolate`.
  const base = (ctx as Record<string, unknown>)[root] ?? {};
  return walkPath(base, segments.slice(1)) as Value;
}

function evalNode(node: Node, ctx: ConditionContext): Value {
  switch (node.k) {
    case "lit":
      return node.v;
    case "path":
      return resolvePath(node.segments, ctx);
    case "not":
      return !truthy(evalNode(node.e, ctx));
    case "call": {
      const s = ctx.status ?? { success: true, failure: false };
      switch (node.name) {
        case "success":
          return s.success;
        case "failure":
          return s.failure;
        case "always":
          return true;
        case "cancelled":
          return s.cancelled ?? false;
        default:
          throw new ConditionError(
            `unknown function "${node.name}()" — supported: success(), failure(), always(), cancelled()`,
          );
      }
    }
    case "bin": {
      if (node.op === "&&") return truthy(evalNode(node.l, ctx)) && truthy(evalNode(node.r, ctx));
      if (node.op === "||") return truthy(evalNode(node.l, ctx)) || truthy(evalNode(node.r, ctx));
      const eq = looseEq(evalNode(node.l, ctx), evalNode(node.r, ctx));
      return node.op === "==" ? eq : !eq;
    }
  }
}

/** Strip a single outer `${{ ... }}` wrapper if the whole string is one. */
function unwrap(expr: string): string {
  const t = expr.trim();
  const m = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(t);
  return m ? m[1]!.trim() : t;
}

/**
 * Evaluate an `if:` / `when:` condition to a boolean. Throws ConditionError on a
 * malformed or unsupported expression (callers surface this as an authoring
 * error, never a silent pass).
 */
export function evaluateCondition(expr: string, ctx: ConditionContext = {}): boolean {
  const inner = unwrap(expr);
  if (inner === "") throw new ConditionError("empty condition");
  const ast = new Parser(tokenize(inner)).parse();
  return truthy(evalNode(ast, ctx));
}
