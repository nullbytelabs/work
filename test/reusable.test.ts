/**
 * Compiler tests for reusable workflows (Strategy A inlining). An in-memory
 * resolver stands in for the filesystem so these stay pure — no temp files.
 * Verifies namespacing, needs rewiring, the virtual join + output rewrite,
 * compile-time `with:` binding, matrix-on-the-call, and the guards.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, WorkflowCompileError, type ResolveWorkflow } from "../src/compiler/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";

/** Build a resolver over a name→yaml map (handles `workflow/<name>` and `./<name>.yaml`). */
function resolverFor(callees: Record<string, string>): ResolveWorkflow {
  return (ref) => {
    const name = ref.replace(/^workflow\//, "").replace(/^\.\//, "").replace(/\.ya?ml$/, "");
    const yaml = callees[name];
    if (yaml === undefined) throw new Error(`test resolver: unknown workflow "${name}" (ref "${ref}")`);
    return { spec: parseWorkflow(yaml), dir: "/wf", file: `/wf/${name}.yaml` };
  };
}

/** Compile a caller against a set of callee workflows. */
function plan(callerYaml: string, callees: Record<string, string> = {}, inputs?: Record<string, unknown>) {
  return compile(parseWorkflow(callerYaml), {
    inputs,
    resolveWorkflow: resolverFor(callees),
    _fromDir: "/wf",
    _chain: ["/wf/caller.yaml"],
    _depth: 0,
  });
}

describe("reusable — single-level inlining", () => {
  it("inlines a single-job callee + synthesizes a virtual join", () => {
    const p = plan(`name: caller\njobs:\n  lint:\n    uses: workflow/lint`, {
      lint: `name: lint\non: workflow_call\njobs:\n  run:\n    steps:\n      - run: echo hi`,
    });
    assert.deepEqual(Object.keys(p.jobs).sort(), ["lint", "lint__run"]);
    const join = p.jobs["lint"]!;
    assert.equal(join.virtual, true);
    assert.deepEqual(join.steps, []);
    assert.deepEqual(join.needs, ["lint__run"]);
    const sub = p.jobs["lint__run"]!;
    assert.equal(sub.virtual, undefined);
    assert.deepEqual(sub.needs, []);
    assert.equal(sub.steps[0]!.run, "echo hi");
    // The join runs after its sub-DAG.
    assert.ok(p.jobOrder.indexOf("lint__run") < p.jobOrder.indexOf("lint"));
  });

  it("rewrites the callee's workflow_call.outputs onto the join (jobs.* → needs.<call>__*)", () => {
    const p = plan(
      `name: caller\njobs:\n  build:\n    uses: workflow/build\n  deploy:\n    needs: [build]\n    steps:\n      - run: 'echo "v=\${{ needs.build.outputs.version }}"'`,
      {
        build: `name: build\non:\n  workflow_call:\n    outputs:\n      version: "\${{ jobs.compile.outputs.version }}"\njobs:\n  compile:\n    steps:\n      - id: meta\n        run: 'echo "version=1" >> "$WORK_OUTPUT"'\n    outputs:\n      version: "\${{ steps.meta.outputs.version }}"`,
      },
    );
    const join = p.jobs["build"]!;
    assert.deepEqual(join.outputs, { version: "${{ needs.build__compile.outputs.version }}" });
    assert.ok(join.needs.includes("build__compile"));
    // Caller-side downstream is untouched: it references the join by its id.
    assert.deepEqual(p.jobs["deploy"]!.needs, ["build"]);
    assert.match(p.jobs["deploy"]!.steps[0]!.run!, /needs\.build\.outputs\.version/);
    // Inside the callee, the producer's own output expr is unchanged.
    assert.deepEqual(p.jobs["build__compile"]!.outputs, { version: "${{ steps.meta.outputs.version }}" });
  });

  it("re-points intra-callee needs references to namespaced ids", () => {
    const p = plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib`, {
      lib: `name: lib\non: workflow_call\njobs:\n  produce:\n    steps:\n      - id: m\n        run: 'echo "x=1" >> "$WORK_OUTPUT"'\n    outputs:\n      x: "\${{ steps.m.outputs.x }}"\n  consume:\n    needs: [produce]\n    steps:\n      - run: 'echo "\${{ needs.produce.outputs.x }}"'`,
    });
    assert.deepEqual(p.jobs["call__consume"]!.needs, ["call__produce"]);
    assert.match(p.jobs["call__consume"]!.steps[0]!.run!, /needs\.call__produce\.outputs\.x/);
    assert.deepEqual(p.jobs["call__produce"]!.needs, []);
  });

  it("flows the caller's needs into the callee's root jobs", () => {
    const p = plan(`name: caller\njobs:\n  pre:\n    steps: [{ run: "true" }]\n  call:\n    needs: [pre]\n    uses: workflow/lib`, {
      lib: `name: lib\non: workflow_call\njobs:\n  j:\n    steps: [{ run: "true" }]`,
    });
    assert.deepEqual(p.jobs["call__j"]!.needs, ["pre"]);
    assert.deepEqual(p.jobs["call"]!.needs, ["call__j"]);
  });
});

describe("reusable — with: binding", () => {
  it("binds compile-time inputs (inputs.*) into the callee", () => {
    const p = plan(
      `name: caller\ninputs:\n  env: { default: staging }\njobs:\n  dep:\n    uses: workflow/deploy\n    with:\n      target: "\${{ inputs.env }}"`,
      { deploy: `name: deploy\non: workflow_call\ninputs:\n  target: { required: true }\njobs:\n  go:\n    steps:\n      - run: 'echo "deploy to \${{ inputs.target }}"'` },
    );
    assert.equal(p.jobs["dep__go"]!.steps[0]!.run, 'echo "deploy to staging"');
  });

  it("rejects a runtime value (needs.*) in with:", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  dep:\n    uses: workflow/deploy\n    with:\n      target: "\${{ needs.x.outputs.y }}"`, {
          deploy: `name: deploy\non: workflow_call\ninputs:\n  target: {}\njobs:\n  go:\n    steps: [{ run: "true" }]`,
        }),
      (e) => e instanceof WorkflowCompileError && /runtime value/.test(e.message),
    );
  });

  it("validates with: against the callee's declared inputs", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  dep:\n    uses: workflow/deploy\n    with:\n      nope: "x"`, {
          deploy: `name: deploy\non: workflow_call\njobs:\n  go:\n    steps: [{ run: "true" }]`,
        }),
      (e) => e instanceof WorkflowCompileError && /unknown input "nope"/.test(e.message),
    );
  });
});

describe("reusable — matrix on the call", () => {
  it("fans the whole call out per cell, binding matrix.* into with:", () => {
    const p = plan(
      `name: caller\njobs:\n  dep:\n    strategy:\n      matrix:\n        env: [staging, prod]\n    uses: workflow/deploy\n    with:\n      target: "\${{ matrix.env }}"`,
      { deploy: `name: deploy\non: workflow_call\ninputs:\n  target: { required: true }\njobs:\n  go:\n    steps:\n      - run: 'echo "\${{ inputs.target }}"'` },
    );
    // One join per cell (keeps `::`), sub-jobs hang off the `\w`-safe prefix.
    assert.equal(p.jobs["dep::env-staging"]!.virtual, true);
    assert.equal(p.jobs["dep::env-prod"]!.virtual, true);
    assert.equal(p.jobs["dep__env-staging__go"]!.steps[0]!.run, 'echo "staging"');
    assert.equal(p.jobs["dep__env-prod__go"]!.steps[0]!.run, 'echo "prod"');
  });
});

describe("reusable — guards", () => {
  it("rejects a callee that hasn't opted into workflow_call", () => {
    assert.throws(
      () => plan(`name: caller\njobs:\n  a:\n    uses: workflow/plain`, { plain: `name: plain\njobs:\n  j:\n    steps: [{ run: "true" }]` }),
      (e) => e instanceof WorkflowCompileError && /not callable/.test(e.message),
    );
  });

  it("detects a reusable-workflow cycle", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  call:\n    uses: workflow/a`, {
          a: `name: a\non: workflow_call\njobs:\n  x: { uses: workflow/b }`,
          b: `name: b\non: workflow_call\njobs:\n  y: { uses: workflow/a }`,
        }),
      (e) => e instanceof WorkflowCompileError && /cycle/.test(e.message),
    );
  });

  it("enforces the nesting depth cap", () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i <= 15; i++) {
      chain[`w${i}`] =
        i < 15
          ? `name: w${i}\non: workflow_call\njobs:\n  j: { uses: workflow/w${i + 1} }`
          : `name: w${i}\non: workflow_call\njobs:\n  j:\n    steps: [{ run: "true" }]`;
    }
    assert.throws(
      () => plan(`name: caller\njobs:\n  call:\n    uses: workflow/w0`, chain),
      (e) => e instanceof WorkflowCompileError && /too deep/.test(e.message),
    );
  });

  it("rejects a job-id collision between a real job and an inlined sub-job", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib\n  call__produce:\n    steps: [{ run: "true" }]`, {
          lib: `name: lib\non: workflow_call\njobs:\n  produce:\n    steps: [{ run: "true" }]`,
        }),
      (e) => e instanceof WorkflowCompileError && /collision/.test(e.message),
    );
  });

  it("errors on a uses: job when no resolver is provided", () => {
    assert.throws(
      () => compile(parseWorkflow(`name: caller\njobs:\n  a:\n    uses: workflow/x`)),
      (e) => e instanceof WorkflowCompileError && /not available in this context/.test(e.message),
    );
  });
});
