/**
 * Property-based tests for the job topological sort (`topoSort` in
 * src/compiler/compile.ts). Target #5 — see docs/property-based-testing.md.
 *
 * topoSort (Kahn's algorithm, alphabetical tie-breaking) orders the job DAG so a
 * durable, replay-stable runtime can walk it. The invariants below hold for every
 * acyclic graph; cyclic graphs must be rejected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { topoSort, WorkflowCompileError } from "../src/compiler/compile.ts";
import type { PlannedJob } from "../src/compiler/plan.ts";

type Jobs = Record<string, { needs: string[] }>;
const sort = (jobs: Jobs) => topoSort(jobs as unknown as Record<string, PlannedJob>);

const nodeName = fc.string({ minLength: 1, maxLength: 5 });

// ── acyclic DAG generator ───────────────────────────────────────────────────
// Fix the node list as a linear order; each node may only `need` nodes that come
// earlier in that list. This makes acyclicity structural — no filtering.
const dagArb: fc.Arbitrary<{ jobs: Jobs; nodes: string[] }> = fc
  .uniqueArray(nodeName, { minLength: 0, maxLength: 8 })
  .chain((nodes) => {
    if (nodes.length === 0) return fc.constant({ jobs: {} as Jobs, nodes });
    const needArbs = nodes.map((_, i) => (i === 0 ? fc.constant<string[]>([]) : fc.subarray(nodes.slice(0, i))));
    return fc.tuple(...needArbs).map((needsList) => {
      const jobs: Jobs = {};
      nodes.forEach((id, i) => (jobs[id] = { needs: needsList[i]! }));
      return { jobs, nodes };
    });
  });

// ── P1: the order is a permutation of the job ids ───────────────────────────
test("toposort · output is a permutation of the input job ids", () => {
  fc.assert(
    fc.property(dagArb, ({ jobs, nodes }) => {
      const order = sort(jobs);
      assert.equal(order.length, nodes.length);
      assert.deepEqual([...order].sort(), [...nodes].sort());
    }),
  );
});

// ── P2: every dependency precedes its dependent ─────────────────────────────
test("toposort · every need appears before the job that needs it", () => {
  fc.assert(
    fc.property(dagArb, ({ jobs }) => {
      const order = sort(jobs);
      const pos = new Map(order.map((id, i) => [id, i]));
      for (const [id, job] of Object.entries(jobs)) {
        for (const dep of job.needs) {
          assert.ok(pos.get(dep)! < pos.get(id)!, `${dep} must precede ${id}`);
        }
      }
    }),
  );
});

// ── P3: deterministic, independent of job insertion order ───────────────────
// Replay-stability: re-inserting the same jobs in reverse order yields the same
// sequence (topoSort sorts ids internally).
test("toposort · result is independent of job insertion order", () => {
  fc.assert(
    fc.property(dagArb, ({ jobs, nodes }) => {
      const forward = sort(jobs);
      const reordered: Jobs = {};
      for (const id of [...nodes].reverse()) reordered[id] = jobs[id]!;
      assert.deepEqual(sort(reordered), forward);
    }),
  );
});

// ── P4: cyclic graphs are rejected ──────────────────────────────────────────
// A ring (self-loop for n=1) guarantees a cycle; topoSort must throw and name the
// nodes involved.
const cyclicArb = fc.uniqueArray(nodeName, { minLength: 1, maxLength: 6 }).map((nodes) => {
  const jobs: Jobs = {};
  const n = nodes.length;
  if (n === 1) jobs[nodes[0]!] = { needs: [nodes[0]!] };
  else nodes.forEach((id, i) => (jobs[id] = { needs: [nodes[(i - 1 + n) % n]!] }));
  return { jobs, nodes };
});

test("toposort · a cyclic graph throws and names the cycle", () => {
  fc.assert(
    fc.property(cyclicArb, ({ jobs, nodes }) => {
      assert.throws(
        () => sort(jobs),
        (e) => e instanceof WorkflowCompileError && /cycle detected/.test(e.message) && e.message.includes(nodes[0]!),
      );
    }),
  );
});
