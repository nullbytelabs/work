/**
 * Property-based tests for reusable-workflow inlining by substitution
 * (`inlineCall` in src/compiler/reusable.ts). Reusable inlining is a *pure
 * structural relabel*: a multi-job callee's DAG is spliced into the caller's flat
 * plan under the rename `<job>` → `<call>__<job>`, with intra-callee `needs`
 * re-pointed and `${{ needs.* }}` spans rewritten — but bare text left alone. That
 * shape is exactly what example tests under-cover (reusable.test.ts hand-picks a
 * handful of DAGs), so the laws below quantify over *every* small callee DAG.
 *
 * The oracle is a one-line relabel function, NOT a re-implementation of the
 * inliner (which also binds `with:`, recursively compiles, curates outputs, …):
 * a plausible wrong inliner — one that drops an edge, mis-points a `needs`,
 * introduces a join node, or blanket-rewrites bare prose — fails these.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { compile, type ResolveWorkflow } from "../src/compiler/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";

/** Build a resolver over a name→yaml map (handles `workflow/<name>`). Mirrors
 *  reusable.test.ts so these stay pure — no temp files. */
function resolverFor(callees: Record<string, string>): ResolveWorkflow {
  return (ref) => {
    const name = ref.replace(/^workflow\//, "").replace(/^\.\//, "").replace(/\.ya?ml$/, "");
    const yaml = callees[name];
    if (yaml === undefined) throw new Error(`test resolver: unknown workflow "${name}" (ref "${ref}")`);
    return { spec: parseWorkflow(yaml), dir: "/wf", file: `/wf/${name}.yaml` };
  };
}

/** Compile a caller against a set of callee workflows (compile-time `with:` ctx). */
function plan(callerYaml: string, callees: Record<string, string>) {
  return compile(parseWorkflow(callerYaml), {
    resolveWorkflow: resolverFor(callees),
    _fromDir: "/wf",
    _chain: ["/wf/caller.yaml"],
    _depth: 0,
  });
}

/** The caller is fixed: a lone `uses:` job `C` calling the generated callee. */
const CALLER = `name: caller\njobs:\n  C:\n    uses: workflow/callee`;

/** Namespacing oracle for the multi-job case (NS_SEP === "__"). */
const ns = (id: string): string => `C__${id}`;

// ── generators ───────────────────────────────────────────────────────────────

interface Node {
  id: string;
  needs: string[];
}

/**
 * A small acyclic multi-job callee DAG. Nodes are `j0..j(n-1)` (always-valid ids);
 * node `i` may only `need` strictly-earlier nodes, so acyclicity is structural (no
 * filtering). n ≥ 2 keeps us in the *multi-job* inlining branch (n === 1 is the
 * single-job collapse, covered separately below).
 */
const multiJobDag = fc.integer({ min: 2, max: 5 }).chain((n) => {
  const ids = Array.from({ length: n }, (_, i) => `j${i}`);
  return fc
    .tuple(...ids.map((_, i) => (i === 0 ? fc.constant<string[]>([]) : fc.subarray(ids.slice(0, i)))))
    .map((needsPerNode) => ids.map((id, i) => ({ id, needs: needsPerNode[i]! }) satisfies Node));
});

function calleeYaml(nodes: Node[]): string {
  const jobs = nodes
    .map(({ id, needs }) => {
      const needsLine = needs.length ? `    needs: [${needs.join(", ")}]\n` : "";
      return `  ${id}:\n${needsLine}    steps:\n      - run: "true"`;
    })
    .join("\n");
  return `name: lib\non: workflow_call\njobs:\n${jobs}\n`;
}

// ── P1: the inlined plan is the callee DAG relabeled `j → C__j` ───────────────
// Node set AND edge set are preserved under the namespacing relabel: exactly the
// namespaced jobs (no join node, no extras), and every intra-callee `needs` edge
// re-points to its namespaced endpoint. This is the core multi-job invariant.
test("reusable-ns · a multi-job callee is its DAG relabeled j → C__j (nodes + edges)", () => {
  fc.assert(
    fc.property(multiJobDag, (nodes) => {
      const p = plan(CALLER, { callee: calleeYaml(nodes) });

      // (a) node set: exactly the namespaced callee jobs — no join, no leftovers.
      assert.deepEqual(Object.keys(p.jobs).sort(), nodes.map((nd) => ns(nd.id)).sort());

      // (b) edge set: each job's needs are its callee needs, each namespaced. Roots
      // (no intra-callee needs) end up with []  — the caller `C` has no needs to inject.
      for (const { id, needs } of nodes) {
        assert.deepEqual([...p.jobs[ns(id)]!.needs].sort(), needs.map(ns).sort());
      }
    }),
  );
});

// ── P2: `needs.*` is rewritten ONLY inside ${{ }} spans, never in bare text ───
// The regression at reusable.test.ts:90, quantified: arbitrary prose (which may
// itself contain the literal token `needs.produce`) surrounding one real
// `${{ needs.produce.outputs.x }}` span must come back byte-identical except for
// the span body, which is namespaced. A blanket `s.replace(/needs\.produce/g,…)`
// would corrupt the prose and fail.
const proseToken = fc.constantFrom("needs.produce", "echo", "see", "docs", "x", "a-b", "p/q", "and", "needs.other");
const prose = fc.array(proseToken, { maxLength: 5 }).map((a) => a.join(" "));

test("reusable-ns · needs.<id> is namespaced inside ${{ }} but bare prose is left verbatim", () => {
  fc.assert(
    fc.property(prose, prose, (pre, post) => {
      const run = `START ${pre} \${{ needs.produce.outputs.x }} ${post} END`;
      const expected = `START ${pre} \${{ needs.C__produce.outputs.x }} ${post} END`;
      const callee = `name: lib
on: workflow_call
jobs:
  produce:
    steps:
      - id: m
        run: 'echo x'
    outputs:
      x: "\${{ steps.m.outputs.x }}"
  consume:
    needs: [produce]
    steps:
      - run: '${run}'`;
      const p = plan(CALLER, { callee });
      assert.equal(p.jobs["C__consume"]!.steps[0]!.run, expected);
    }),
  );
});

// ── P3: a single-job callee collapses onto the call id, whatever its shape ────
// One job, keyed by the call id `C` (never `C__<inner>`), with its steps intact —
// regardless of the lone job's own id or how many steps it has.
const ident = fc.constantFrom("only", "run", "build", "go", "toString"); // incl. a prototype-name id
test("reusable-ns · a single-job callee collapses onto the call id (no namespacing)", () => {
  fc.assert(
    fc.property(ident, fc.integer({ min: 1, max: 4 }), (jobId, stepCount) => {
      const steps = Array.from({ length: stepCount }, () => `      - run: "true"`).join("\n");
      const callee = `name: solo\non: workflow_call\njobs:\n  ${jobId}:\n    steps:\n${steps}`;
      const p = plan(CALLER, { callee });
      assert.deepEqual(Object.keys(p.jobs), ["C"]);
      assert.equal(p.jobs["C"]!.steps.length, stepCount);
    }),
  );
});
