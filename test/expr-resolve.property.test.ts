/**
 * Property-based tests for the `${{ … }}` resolver DISPATCH in
 * `src/compiler/expr.ts` — the two-phase contract that `interpolate` enforces over
 * every context root, complementing expr-path.property.test.ts (which targets the
 * access-path plumbing `parseAccessPath`/`walkPath`).
 *
 * The invariants:
 *   P1 — DEFER, don't error: a `needs.*` / `steps.*` / `event.*` expression with
 *        that context absent is left VERBATIM for a later phase (compile→runtime).
 *   P2 — unknown root always THROWS WorkflowCompileError, never silently passes.
 *   P3 — a present `event` scalar interpolates to `String(value)`; a non-scalar to
 *        `JSON.stringify(value)`; a missing leaf to "".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { interpolate, type ExprContext } from "../src/compiler/expr.ts";
import { WorkflowCompileError } from "../src/compiler/compile.ts";

const ID_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split("");
const ID_CHAR = [...ID_START, ..."0123456789-".split("")];
const identifier = fc
  .tuple(fc.constantFrom(...ID_START), fc.array(fc.constantFrom(...ID_CHAR), { maxLength: 6 }))
  .map(([head, tail]) => head + tail.join(""));

// Plain surrounding text that can't itself form a `${{ … }}` span, so we can assert
// the expression's verbatim survival inside a larger template.
const safeText = fc.array(fc.constantFrom(...[..."abc XYZ-/.".split("")]), { maxLength: 10 }).map((a) => a.join(""));

// ── P1: deferred roots are left intact when their context is absent ──────────

// Builders for the RUNTIME-resolved roots (resolveNeeds/resolveSteps/resolveEvent/
// resolveSecrets), each of which defers (returns the verbatim span) when its
// context is missing.
const deferredExpr = fc.oneof(
  fc.tuple(identifier, identifier).map(([job, name]) => `needs.${job}.outputs.${name}`),
  fc.tuple(identifier, identifier).map(([id, key]) => `steps.${id}.outputs.${key}`),
  fc.tuple(identifier, fc.constantFrom("logs", "outcome", "exitCode")).map(([id, b]) => `steps.${id}.${b}`),
  fc.constant("event"),
  fc.tuple(identifier, identifier).map(([a, b]) => `event.${a}.${b}`),
  identifier.map((name) => `secrets.${name}`),
);

test("P1 — a deferred root with absent context is left verbatim (defer, don't error)", () => {
  fc.assert(
    fc.property(deferredExpr, safeText, safeText, (expr, pre, post) => {
      const tpl = `${pre}\${{ ${expr} }}${post}`;
      // ctx supplies none of needs/steps/event/secrets → every match must defer, not throw.
      assert.equal(interpolate(tpl, {}), tpl);
    }),
    { numRuns: 500 },
  );
});

// ── P2: an unknown root always throws, never silently passes through ─────────

// Roots the resolver chain does NOT recognize. (The known roots are
// inputs/matrix/needs/steps/event/secrets.)
const unknownRoot = fc.constantFrom("github", "vars", "env", "runner", "job", "strategy", "foo", "bar", "x");

test("P2 — an unknown root throws WorkflowCompileError", () => {
  fc.assert(
    fc.property(unknownRoot, fc.array(identifier, { minLength: 0, maxLength: 3 }), (root, tail) => {
      const expr = [root, ...tail].join(".");
      assert.throws(() => interpolate(`\${{ ${expr} }}`, {}), WorkflowCompileError);
    }),
    { numRuns: 500 },
  );
});

// ── P3: event scalar → String(v); non-scalar → JSON.stringify(v); missing → "" ──

const scalar = fc.oneof(fc.string(), fc.integer(), fc.boolean());
const nonScalar = fc.oneof(fc.array(fc.jsonValue(), { maxLength: 4 }), fc.dictionary(identifier, fc.jsonValue(), { maxKeys: 4 }));

test("P3 — a present event scalar stringifies via String()", () => {
  fc.assert(
    fc.property(scalar, (value) => {
      const ctx: ExprContext = { event: { k: value } };
      assert.equal(interpolate("${{ event.k }}", ctx), String(value));
    }),
    { numRuns: 500 },
  );
});

test("P3 — a present event non-scalar stringifies via JSON.stringify()", () => {
  fc.assert(
    fc.property(nonScalar, (value) => {
      const ctx: ExprContext = { event: { k: value } };
      assert.equal(interpolate("${{ event.k }}", ctx), JSON.stringify(value));
    }),
    { numRuns: 500 },
  );
});

test("P3 — a missing event leaf interpolates to empty string", () => {
  fc.assert(
    fc.property(identifier, (missingKey) => {
      const ctx: ExprContext = { event: {} };
      assert.equal(interpolate(`\${{ event.${missingKey} }}`, ctx), "");
    }),
    { numRuns: 300 },
  );
});
