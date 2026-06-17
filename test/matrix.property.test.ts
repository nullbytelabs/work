/**
 * Property-based tests for matrix fan-out (`src/compiler/matrix.ts`).
 *
 * The first PBT target — see docs/property-based-testing.md. Each property is an
 * invariant true for *every* input, not a hand-picked example. Companion to the
 * example-based coverage in compiler.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { expandMatrix, cellId, type MatrixCell } from "../src/compiler/matrix.ts";
import type { MatrixValue } from "../src/spec/index.ts";

// A matrix scalar: string | number | boolean (src/spec/types.ts).
const scalar: fc.Arbitrary<MatrixValue> = fc.oneof(fc.string(), fc.integer(), fc.boolean());

// Adversarial scalar — control chars, slashes, unicode — to exercise the path
// sanitizer in cellId.
const wildScalar: fc.Arbitrary<MatrixValue> = fc.oneof(
  fc.string({ unit: "binary" }),
  fc.integer(),
  fc.boolean(),
);

const axisName = fc.string({ minLength: 1, maxLength: 6 });

// 1..4 named axes, each a non-empty list of 1..4 scalar values.
const axes = fc.dictionary(axisName, fc.array(scalar, { minLength: 1, maxLength: 4 }), {
  minKeys: 1,
  maxKeys: 4,
});

// ── P1: counting ──────────────────────────────────────────────────────────
// With no include/exclude, the result is exactly the cartesian product.
test("matrix · |expandMatrix| equals the product of axis lengths", () => {
  fc.assert(
    fc.property(axes, (a) => {
      const product = Object.values(a).reduce((n, vs) => n * vs.length, 1);
      assert.equal(expandMatrix({ axes: a }).length, product);
    }),
  );
});

// ── P2: exclude monotonicity (metamorphic) ─────────────────────────────────
// Adding exclude entries can only prune — never grow — the cell count. We build
// excludes from real axis values so they actually match (a non-vacuous test).
const axesWithExclude = axes.chain((a) => {
  const keys = Object.keys(a);
  const excludeEntry = fc
    .subarray(keys, { minLength: 1 })
    .chain((sel) =>
      fc
        .tuple(...sel.map((k) => fc.constantFrom(...a[k]!)))
        .map((vals) => Object.fromEntries(sel.map((k, i) => [k, vals[i]!])) as MatrixCell),
    );
  return fc.record({ axes: fc.constant(a), exclude: fc.array(excludeEntry, { maxLength: 5 }) });
});

test("matrix · adding exclude entries never increases the cell count", () => {
  fc.assert(
    fc.property(axesWithExclude, ({ axes: a, exclude }) => {
      const full = expandMatrix({ axes: a }).length;
      const pruned = expandMatrix({ axes: a, exclude }).length;
      assert.ok(pruned <= full, `pruned ${pruned} > full ${full}`);
    }),
  );
});

// ── P3: include never overwrites an axis value ──────────────────────────────
// include extends matching cells in place (adding non-axis keys) and appends
// unmatched entries; it must never alter an axis value. So projecting each
// extended cell back onto the axis keys reproduces the original product cell.
const includeEntry = (keys: string[]) =>
  fc.dictionary(fc.oneof(fc.constantFrom(...keys), axisName), scalar, { minKeys: 1, maxKeys: 4 });

const axesWithInclude = axes.chain((a) =>
  fc.record({ axes: fc.constant(a), include: fc.array(includeEntry(Object.keys(a)), { maxLength: 4 }) }),
);

test("matrix · include never overwrites an axis value", () => {
  fc.assert(
    fc.property(axesWithInclude, ({ axes: a, include }) => {
      const axisNames = Object.keys(a);
      const base = expandMatrix({ axes: a });
      const inc = expandMatrix({ axes: a, include });
      assert.ok(inc.length >= base.length, "include must not drop cells");
      for (let i = 0; i < base.length; i++) {
        const proj: MatrixCell = {};
        for (const k of axisNames) if (k in inc[i]!) proj[k] = inc[i]![k]!;
        assert.deepEqual(proj, base[i]);
      }
    }),
  );
});

// ── P4: cellId is path-safe ─────────────────────────────────────────────────
// The leg id is documented as path-safe (matrix.ts, plan.ts:41). It must contain
// only path-safe characters for *any* cell, including adversarial keys/values.
const wildCell = fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), wildScalar, { maxKeys: 5 });
const axisOrder = fc.array(fc.string({ maxLength: 6 }), { maxLength: 5 });

test("matrix · cellId is path-safe for arbitrary cells", () => {
  fc.assert(
    fc.property(wildCell, axisOrder, (cell, order) => {
      assert.match(cellId(cell, order), /^[A-Za-z0-9._-]*$/);
    }),
    // Regression: PBT-found counterexample — an unsanitized key (a space) leaked
    // into the id as `" -"`. See the findings log in docs/property-based-testing.md.
    { examples: [[{ " ": "" }, []]] },
  );
});

// ── P5: cellId is independent of key insertion order ────────────────────────
// cellId orders axes by axisOrder and include-only keys alphabetically, so the
// same logical cell yields the same id regardless of property insertion order.
const distinctEntries = fc.uniqueArray(fc.tuple(axisName, scalar), {
  selector: ([k]) => k,
  maxLength: 6,
});

test("matrix · cellId is independent of key insertion order", () => {
  fc.assert(
    fc.property(distinctEntries, axisOrder, (entries, order) => {
      const forward: MatrixCell = {};
      for (const [k, v] of entries) forward[k] = v;
      const reverse: MatrixCell = {};
      for (const [k, v] of [...entries].reverse()) reverse[k] = v;
      assert.equal(cellId(forward, order), cellId(reverse, order));
    }),
  );
});
