/**
 * Property-based tests for the `if:`/`when:` condition engine
 * (`src/compiler/condition.ts`). Target #4 — see docs/property-based-testing.md.
 *
 * The condition engine is a hand-written tokenizer + recursive-descent parser +
 * evaluator. Rather than mirror its semantics in an oracle (which would risk
 * copying its bugs), we assert algebraic laws that ANY correct boolean engine must
 * satisfy — double negation, De Morgan, commutativity of ==/&&/||, identity and
 * domination laws — plus a small literal-truthiness oracle and the engine's
 * reject-don't-silently-pass safety contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { evaluateCondition, ConditionError, type ConditionContext } from "../src/compiler/condition.ts";

// ── generators ──────────────────────────────────────────────────────────────

const ID_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split("");
const ID_CHAR = [...ID_START, ..."0123456789-".split("")];
const identifier = fc
  .tuple(fc.constantFrom(...ID_START), fc.array(fc.constantFrom(...ID_CHAR), { maxLength: 4 }))
  .map(([h, t]) => h + t.join(""));

// A string with no quote chars, so it renders safely inside single quotes.
const safeStr = fc.string({ maxLength: 5 }).filter((s) => !s.includes("'") && !s.includes('"'));

// A context: an `inputs` bag. Atoms reference `inputs.<name>`; whether the name is
// present is irrelevant to the laws (both sides of each law see the same ctx).
const condValue = fc.oneof(fc.integer(), fc.boolean(), fc.string({ maxLength: 5 }), fc.constant(null));
const ctxArb = fc
  .dictionary(identifier, condValue, { maxKeys: 4 })
  .map((inputs) => ({ inputs }) as ConditionContext);

// A primary operand: a literal or a (safe) context reference.
const atom = fc.oneof(
  fc.integer({ min: -50, max: 50 }).map(String),
  fc.constantFrom("true", "false", "null"),
  safeStr.map((s) => `'${s}'`),
  identifier.map((n) => `inputs.${n}`),
);

// A well-formed boolean expression string, fully parenthesized so composing it is
// precedence-safe. Atoms are weighted so recursion terminates.
const { expr } = fc.letrec<{ expr: string; not: string; bin: string }>((tie) => ({
  expr: fc.oneof(
    { depthSize: "small", maxDepth: 4, withCrossShrink: true },
    atom,
    atom,
    tie("not"),
    tie("bin"),
  ),
  not: tie("expr").map((e) => `!(${e})`),
  bin: fc
    .tuple(tie("expr"), fc.constantFrom("&&", "||", "==", "!="), tie("expr"))
    .map(([l, op, r]) => `(${l} ${op} ${r})`),
}));

const ev = (s: string, ctx: ConditionContext = {}) => evaluateCondition(s, ctx);

// ── P1: literal truthiness (independent oracle on leaves) ───────────────────
const literalWithTruth = fc.oneof(
  fc.integer().map((n) => ({ s: String(n), b: n !== 0 })),
  fc.constantFrom({ s: "true", b: true }, { s: "false", b: false }, { s: "null", b: false }),
  safeStr.map((s) => ({ s: `'${s}'`, b: s.length > 0 })),
);
test("condition · literal truthiness matches the documented rules", () => {
  fc.assert(fc.property(literalWithTruth, ({ s, b }) => assert.equal(ev(s), b)));
});

// ── P2: double negation ─────────────────────────────────────────────────────
test("condition · !!e equals e", () => {
  fc.assert(fc.property(expr, ctxArb, (e, ctx) => assert.equal(ev(`!(!(${e}))`, ctx), ev(e, ctx))));
});

// ── P3: == is commutative ───────────────────────────────────────────────────
test("condition · a == b equals b == a", () => {
  fc.assert(fc.property(atom, atom, ctxArb, (a, b, ctx) => assert.equal(ev(`${a} == ${b}`, ctx), ev(`${b} == ${a}`, ctx))));
});

// ── P4: != is the negation of == ────────────────────────────────────────────
test("condition · a != b equals !(a == b)", () => {
  fc.assert(fc.property(atom, atom, ctxArb, (a, b, ctx) => assert.equal(ev(`${a} != ${b}`, ctx), !ev(`${a} == ${b}`, ctx))));
});

// ── P5: De Morgan ───────────────────────────────────────────────────────────
test("condition · !(a && b) equals (!a) || (!b)", () => {
  fc.assert(
    fc.property(expr, expr, ctxArb, (a, b, ctx) =>
      assert.equal(ev(`!((${a}) && (${b}))`, ctx), ev(`(!(${a})) || (!(${b}))`, ctx)),
    ),
  );
});

// ── P6: && and || are commutative ───────────────────────────────────────────
test("condition · && and || are commutative", () => {
  fc.assert(
    fc.property(expr, expr, ctxArb, (a, b, ctx) => {
      assert.equal(ev(`(${a}) && (${b})`, ctx), ev(`(${b}) && (${a})`, ctx));
      assert.equal(ev(`(${a}) || (${b})`, ctx), ev(`(${b}) || (${a})`, ctx));
    }),
  );
});

// ── P7: identity and domination laws ────────────────────────────────────────
test("condition · identity/domination: x&&true=x, x||false=x, x&&false=false, x||true=true", () => {
  fc.assert(
    fc.property(expr, ctxArb, (e, ctx) => {
      const x = ev(e, ctx);
      assert.equal(ev(`(${e}) && true`, ctx), x);
      assert.equal(ev(`(${e}) || false`, ctx), x);
      assert.equal(ev(`(${e}) && false`, ctx), false);
      assert.equal(ev(`(${e}) || true`, ctx), true);
    }),
  );
});

// ── P8: totality — a well-formed expression always yields a boolean, no throw ─
test("condition · a well-formed expression evaluates to a boolean", () => {
  fc.assert(fc.property(expr, ctxArb, (e, ctx) => assert.equal(typeof ev(e, ctx), "boolean")));
});

// ── P9: malformed/unsupported input is rejected, never silently passed ───────
const malformed = fc.oneof(
  fc.tuple(atom, atom).map(([a, b]) => `${a} < ${b}`), // unsupported operator
  fc.tuple(atom, atom).map(([a, b]) => `${a} ${b}`), // trailing tokens
  atom.map((a) => `(${a}`), // unbalanced paren
  atom.map((a) => `${a} &`), // lone &
  fc.constantFrom("foo.bar", "xyz.a", "nope.x"), // unknown context root
  fc.constant(""), // empty
);
test("condition · malformed or unsupported conditions throw ConditionError", () => {
  fc.assert(fc.property(malformed, (m) => assert.throws(() => ev(m), ConditionError)));
});
