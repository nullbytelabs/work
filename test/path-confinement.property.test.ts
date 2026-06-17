/**
 * Security property tests: a computed job id must stay confined under the work
 * root. Target S-2 — see the Security track in docs/property-based-testing.md.
 *
 * The sink is `join(ctx.workRoot, job.id)` (src/runtime/absurd/runtime.ts). Job ids
 * are assembled from attacker-influenceable matrix axis names/values
 * (`cellId` → `<base>::<cell>`, src/compiler/matrix.ts + compile.ts) and reusable
 * namespacing (`<call>__<job>`, src/compiler/reusable.ts) — paths that bypass the
 * parse-time `assertValidJobKey`. Invariant: for any workflow, `join(workRoot, id)`
 * never escapes workRoot (no `..` component, no separator injection).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import fc from "fast-check";

import { parseWorkflow, WorkflowParseError } from "../src/spec/index.ts";
import { compile, WorkflowCompileError } from "../src/compiler/index.ts";
import { cellId } from "../src/compiler/matrix.ts";

const WORKROOT = resolve("/work/root");

// The confinement predicate, mirroring the real sink's `join` then asking whether
// the resolved path is a *proper* subdirectory of the root. Equality with root is
// itself a violation: a job whose workdir IS the shared root would stage over it.
function isConfined(root: string, id: string): boolean {
  const r = resolve(join(root, id));
  return r !== root && r.startsWith(root + sep);
}

// Strings designed to break out of a path if not sanitized. `traversal` chains many
// `../` with separators so it can climb above the root (escaping the `key-` prefix
// that otherwise absorbs a single leading `..`).
const traversal = fc
  .array(fc.constantFrom("../", "..", "/", "./", "..\\", "%2e%2e/", "\\"), { minLength: 1, maxLength: 8 })
  .map((a) => a.join(""));
const pathNasty = fc.oneof(
  traversal,
  fc.constantFrom("..", "/", "a/b", ".", "::", "__", ".git", "node_modules", "....//"),
);

const ID_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split("");
const ID_CHAR = [...ID_START, ..."0123456789-".split("")];
const baseId = fc
  .tuple(fc.constantFrom(...ID_START), fc.array(fc.constantFrom(...ID_CHAR), { maxLength: 5 }))
  .map(([h, t]) => h + t.join("")); // a valid assertValidJobKey id

// ── P1: end-to-end through compile() with an adversarial matrix ──────────────
// Axis names AND values are attacker-influenceable and bypass assertValidJobKey;
// every resulting leg id must stay confined. (include/exclude keys flow through the
// same cellId path.)
const axisName = fc.oneof(fc.string({ maxLength: 6 }), pathNasty).filter((s) => s.length > 0 && s !== "include" && s !== "exclude");
const scalarVal = fc.oneof(fc.string({ maxLength: 6 }), pathNasty, fc.integer(), fc.boolean());
const matrixArb = fc.dictionary(axisName, fc.array(scalarVal, { minLength: 1, maxLength: 3 }), { minKeys: 1, maxKeys: 3 });

test("path-confinement · every compiled job id stays confined under workRoot", () => {
  fc.assert(
    fc.property(matrixArb, (matrix) => {
      // JSON is valid YAML, so this feeds adversarial strings without escaping.
      const wf = { name: "w", jobs: { j: { strategy: { matrix }, steps: [{ run: "true" }] } } };
      let plan;
      try {
        plan = compile(parseWorkflow(JSON.stringify(wf)));
      } catch (e) {
        if (e instanceof WorkflowParseError || e instanceof WorkflowCompileError) return; // rejecting is fail-closed
        throw e;
      }
      for (const id of Object.keys(plan.jobs)) {
        assert.ok(isConfined(WORKROOT, id), `job id ${JSON.stringify(id)} escapes ${WORKROOT}`);
      }
    }),
  );
});

// ── P2: the leg-id format <base>::<cell> is confined for arbitrary cells ─────
const wildScalar = fc.oneof(fc.string({ unit: "binary", maxLength: 6 }), fc.integer(), fc.boolean(), pathNasty);
const cellArb = fc.dictionary(fc.oneof(fc.string({ maxLength: 6 }), pathNasty), wildScalar, { maxKeys: 4 });
const axisOrderArb = fc.array(fc.string({ maxLength: 6 }), { maxLength: 4 });

test("path-confinement · cellId leg id <base>::<cell> (and its -n disambiguation) is confined", () => {
  fc.assert(
    fc.property(baseId, cellArb, axisOrderArb, (base, cell, order) => {
      const suffix = cellId(cell, order) || "1";
      const id = `${base}::${suffix}`;
      assert.ok(isConfined(WORKROOT, id), id);
      assert.ok(isConfined(WORKROOT, `${id}-2`), `${id}-2`); // disambiguation suffix
    }),
  );
});

// ── P3: reusable namespacing preserves confinement ──────────────────────────
// Mirrors src/compiler/reusable.ts:95-96 — `::`→`__`, then prefix `<ns>__`.
const NS_SEP = "__";
test("path-confinement · reusable namespacing of a leg id stays confined", () => {
  fc.assert(
    fc.property(baseId, cellArb, axisOrderArb, baseId, (base, cell, order, child) => {
      const legId = `${base}::${cellId(cell, order) || "1"}`;
      const nsPrefix = legId.split("::").join(NS_SEP);
      const namespaced = `${nsPrefix}${NS_SEP}${child}`;
      assert.ok(isConfined(WORKROOT, namespaced), namespaced);
    }),
  );
});
