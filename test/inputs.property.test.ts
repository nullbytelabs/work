/**
 * Property-based tests for typed input resolution (`src/compiler/inputs.ts`).
 * Target #3 — see docs/property-based-testing.md.
 *
 * resolveInputs validates a provided JSON body against a declared `inputs:` block:
 * strict typing (no coercion), defaults, required-ness, and options/pattern
 * constraints — the last gated to *present* inputs only (line 63).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { resolveInputs } from "../src/compiler/inputs.ts";
import { WorkflowCompileError } from "../src/compiler/compile.ts";
import type { InputSpec } from "../src/spec/index.ts";

// ── generators ──────────────────────────────────────────────────────────────

const inputType = fc.constantFrom("string", "number", "boolean");
const inputName = fc.string({ minLength: 1, maxLength: 5 });

const valueOfType = (t: string): fc.Arbitrary<string | number | boolean> =>
  t === "number" ? fc.integer() : t === "boolean" ? fc.boolean() : fc.string();

// A constraint-free declared spec plus a coherent decision to provide a value or
// not — normalized so the scenario always resolves (a required input without a
// default is always provided).
const declAndProvision = inputType.chain((type) =>
  fc
    .record({
      required: fc.boolean(),
      hasDefault: fc.boolean(),
      defaultVal: valueOfType(type),
      provide: fc.boolean(),
      providedVal: valueOfType(type),
    })
    .map((g) => {
      const spec: InputSpec = { type: type as InputSpec["type"] };
      if (g.hasDefault) spec.default = g.defaultVal;
      if (g.required) spec.required = true;
      // Guarantee resolvability: a required input lacking a default must be provided.
      const provide = g.provide || (g.required && !g.hasDefault);
      return { spec, provide, providedVal: g.providedVal };
    }),
);

// A whole resolvable scenario: unique-named declared specs + a matching provided map.
const scenario = fc
  .uniqueArray(fc.tuple(inputName, declAndProvision), { selector: ([n]) => n, maxLength: 6 })
  .map((entries) => {
    const declared: Record<string, InputSpec> = {};
    const provided: Record<string, unknown> = {};
    for (const [n, e] of entries) {
      declared[n] = e.spec;
      if (e.provide) provided[n] = e.providedVal;
    }
    return { declared, provided };
  });

const typeOf = (v: unknown) => (typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string");

// ── P1: output shape & typing invariant ─────────────────────────────────────
// The result has exactly the declared keys, and every value matches its declared
// type — whether it came from the provided body, a default, or a sentinel.
test("inputs · result keys equal declared keys and every value matches its declared type", () => {
  fc.assert(
    fc.property(scenario, ({ declared, provided }) => {
      const out = resolveInputs(declared, provided);
      assert.deepEqual(Object.keys(out).sort(), Object.keys(declared).sort());
      for (const [name, spec] of Object.entries(declared)) {
        assert.equal(typeOf(out[name]), spec.type ?? "string");
      }
    }),
  );
});

// ── P2: unknown provided key is rejected ────────────────────────────────────
test("inputs · an undeclared provided key throws", () => {
  fc.assert(
    fc.property(scenario, inputName, ({ declared, provided }, extra) => {
      fc.pre(!(extra in declared));
      assert.throws(() => resolveInputs(declared, { ...provided, [extra]: 1 }), WorkflowCompileError);
    }),
  );
});

// ── P3: strict typing, no coercion ──────────────────────────────────────────
// A provided value whose JS type differs from the declared type is rejected — a
// string "36" is never coerced into a number input.
const mismatch = inputType.chain((type) => {
  const wrong =
    type === "number"
      ? fc.oneof(fc.string(), fc.boolean())
      : type === "boolean"
        ? fc.oneof(fc.string(), fc.integer())
        : fc.oneof(fc.integer(), fc.boolean());
  return fc.record({ type: fc.constant(type), name: inputName, bad: wrong });
});

test("inputs · a wrong-typed provided value throws (no coercion)", () => {
  fc.assert(
    fc.property(mismatch, ({ type, name, bad }) => {
      const declared: Record<string, InputSpec> = { [name]: { type: type as InputSpec["type"] } };
      assert.throws(() => resolveInputs(declared, { [name]: bad }), WorkflowCompileError);
    }),
  );
});

// ── P4: resolution is idempotent (a fixed point) ────────────────────────────
// Feeding the resolved values back in yields the same result.
test("inputs · resolveInputs is idempotent", () => {
  fc.assert(
    fc.property(scenario, ({ declared, provided }) => {
      const once = resolveInputs(declared, provided);
      const twice = resolveInputs(declared, once);
      assert.deepEqual(twice, once);
    }),
  );
});

// ── P5: an absent optional input is not constraint-checked ───────────────────
// The `if (present)` gate (line 63): an optional input with no default and a
// constraint its sentinel would fail must still resolve to the sentinel, not throw.
const sentinelHostile: fc.Arbitrary<InputSpec> = fc.oneof(
  fc.record({ type: fc.constant("string"), pattern: fc.constantFrom("^.+$", "^[a-z]+$", "^\\d+$") }),
  fc.constant({ type: "number", options: [1, 2, 3] }),
  fc.constant({ type: "boolean", options: [true] }),
) as fc.Arbitrary<InputSpec>;

test("inputs · an absent optional input skips constraint validation (resolves to sentinel)", () => {
  fc.assert(
    fc.property(inputName, sentinelHostile, (name, spec) => {
      const out = resolveInputs({ [name]: spec }, {});
      const expected = spec.type === "number" ? 0 : spec.type === "boolean" ? false : "";
      assert.equal(out[name], expected);
    }),
  );
});
