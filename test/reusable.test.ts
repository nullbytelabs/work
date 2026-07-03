/**
 * Compiler tests for reusable workflows (inlining by substitution). An in-memory
 * resolver stands in for the filesystem so these stay pure — no temp files.
 * Verifies single-job collapse onto the call id, multi-job namespacing + needs
 * rewiring, caller-side output rewrites, compile-time `with:` binding,
 * matrix-on-the-call, and the guards. No synthetic join nodes are produced.
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

describe("reusable — single-job collapse", () => {
  it("collapses a single-job callee onto the call id (the call IS the job)", () => {
    const p = plan(`name: caller\njobs:\n  lint:\n    uses: workflow/lint`, {
      lint: `name: lint\non: workflow_call\njobs:\n  run:\n    steps:\n      - run: echo hi`,
    });
    // One real job, named after the call — no namespaced sub-job, no join node.
    assert.deepEqual(Object.keys(p.jobs), ["lint"]);
    const job = p.jobs["lint"]!;
    assert.deepEqual(job.needs, []);
    assert.equal(job.steps[0]!.run, "echo hi");
    assert.deepEqual(p.jobOrder, ["lint"]);
  });

  it("exposes the callee's curated workflow_call.outputs on the collapsed call id", () => {
    const p = plan(
      `name: caller\njobs:\n  build:\n    uses: workflow/build\n  deploy:\n    needs: [build]\n    steps:\n      - run: 'echo "v=\${{ needs.build.outputs.version }}"'`,
      {
        build: `name: build\non:\n  workflow_call:\n    outputs:\n      version: "\${{ jobs.compile.outputs.version }}"\njobs:\n  compile:\n    steps:\n      - id: meta\n        run: 'echo "version=1" >> "$WORK_OUTPUT"'\n    outputs:\n      version: "\${{ steps.meta.outputs.version }}"`,
      },
    );
    // The collapsed `build` carries the producer's steps AND the curated output.
    const build = p.jobs["build"]!;
    assert.equal(build.steps[0]!.id, "meta");
    assert.deepEqual(build.outputs, { version: "${{ steps.meta.outputs.version }}" });
    // Downstream is untouched: it reads needs.build.outputs.version against the call id.
    assert.deepEqual(p.jobs["deploy"]!.needs, ["build"]);
    assert.match(p.jobs["deploy"]!.steps[0]!.run!, /needs\.build\.outputs\.version/);
    // No namespaced producer job exists anymore.
    assert.equal(p.jobs["build__compile"], undefined);
  });

  it("flows the caller's needs into the collapsed callee", () => {
    const p = plan(`name: caller\njobs:\n  pre:\n    steps: [{ run: "true" }]\n  call:\n    needs: [pre]\n    uses: workflow/lib`, {
      lib: `name: lib\non: workflow_call\njobs:\n  j:\n    steps: [{ run: "echo hi" }]`,
    });
    assert.deepEqual(p.jobs["call"]!.needs, ["pre"]);
    assert.equal(p.jobs["call"]!.steps[0]!.run, "echo hi");
  });
});

describe("reusable — multi-job inlining", () => {
  it("namespaces a multi-job callee and re-points intra-callee needs", () => {
    const p = plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib`, {
      lib: `name: lib\non: workflow_call\njobs:\n  produce:\n    steps:\n      - id: m\n        run: 'echo "x=1" >> "$WORK_OUTPUT"'\n    outputs:\n      x: "\${{ steps.m.outputs.x }}"\n  consume:\n    needs: [produce]\n    steps:\n      - run: 'echo "\${{ needs.produce.outputs.x }}"'`,
    });
    // Two namespaced jobs, no join.
    assert.deepEqual(Object.keys(p.jobs).sort(), ["call__consume", "call__produce"]);
    assert.deepEqual(p.jobs["call__consume"]!.needs, ["call__produce"]);
    assert.match(p.jobs["call__consume"]!.steps[0]!.run!, /needs\.call__produce\.outputs\.x/);
    assert.deepEqual(p.jobs["call__produce"]!.needs, []);
  });

  // Regression: the `needs.<id>` rewrite must only touch `${{ }}` spans — a bare
  // literal `needs.produce` in shell text (or a prompt) is not an expression and
  // must be left verbatim, while the real `${{ needs.produce.outputs.x }}` is
  // namespaced.
  it("rewrites needs.* only inside ${{ }}, not bare literal text in run", () => {
    const p = plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib`, {
      lib: `name: lib\non: workflow_call\njobs:\n  produce:\n    steps:\n      - id: m\n        run: 'echo "x=1" >> "$WORK_OUTPUT"'\n    outputs:\n      x: "\${{ steps.m.outputs.x }}"\n  consume:\n    needs: [produce]\n    steps:\n      - run: 'echo "see needs.produce docs: \${{ needs.produce.outputs.x }}"'`,
    });
    const run = p.jobs["call__consume"]!.steps[0]!.run!;
    // The expression is namespaced…
    assert.match(run, /\$\{\{ needs\.call__produce\.outputs\.x \}\}/);
    // …but the literal prose `needs.produce` (outside ${{ }}) is untouched.
    assert.match(run, /see needs\.produce docs/);
  });

  it("attaches a downstream needs to the callee's leaf and rewrites its output ref onto the producer", () => {
    const p = plan(
      `name: caller\njobs:\n  build:\n    uses: workflow/lib\n  deploy:\n    needs: [build]\n    steps:\n      - run: 'echo "\${{ needs.build.outputs.x }}"'`,
      {
        lib: `name: lib\non:\n  workflow_call:\n    outputs:\n      x: "\${{ jobs.produce.outputs.x }}"\njobs:\n  produce:\n    steps:\n      - id: m\n        run: 'echo "x=1" >> "$WORK_OUTPUT"'\n    outputs:\n      x: "\${{ steps.m.outputs.x }}"\n  finalize:\n    needs: [produce]\n    steps: [{ run: "true" }]`,
      },
    );
    // The producer is mid-DAG; the leaf is `finalize`. Downstream needs both
    // (leaf for convergence, producer for the output it references).
    assert.deepEqual(p.jobs["deploy"]!.needs.sort(), ["build__finalize", "build__produce"]);
    // The output reference is rewritten onto the producing job.
    assert.match(p.jobs["deploy"]!.steps[0]!.run!, /needs\.build__produce\.outputs\.x/);
    assert.doesNotMatch(p.jobs["deploy"]!.steps[0]!.run!, /needs\.build\.outputs/);
  });
});

describe("reusable — with: binding", () => {
  it("binds compile-time inputs (inputs.*) into the callee", () => {
    const p = plan(
      `name: caller\ninputs:\n  env: { default: staging }\njobs:\n  dep:\n    uses: workflow/deploy\n    with:\n      target: "\${{ inputs.env }}"`,
      { deploy: `name: deploy\non: workflow_call\ninputs:\n  target: { required: true }\njobs:\n  go:\n    steps:\n      - run: 'echo "deploy to \${{ inputs.target }}"'` },
    );
    assert.equal(p.jobs["dep"]!.steps[0]!.run, 'echo "deploy to staging"');
  });

  it("threads a runtime value (needs.*) in with: into the callee's inputs.*", () => {
    const p = plan(
      `name: caller\njobs:\n  prod:\n    steps:\n      - id: m\n        run: 'echo "v=1" >> "$WORK_OUTPUT"'\n    outputs:\n      v: "\${{ steps.m.outputs.v }}"\n  dep:\n    needs: [prod]\n    uses: workflow/deploy\n    with:\n      target: "\${{ needs.prod.outputs.v }}"`,
      { deploy: `name: deploy\non: workflow_call\ninputs:\n  target: {}\njobs:\n  go:\n    steps:\n      - run: 'echo "to \${{ inputs.target }}"'` },
    );
    // The callee's inputs.target expands to the caller's runtime expression, which
    // resolves at runtime through the inherited need on `prod`.
    const go = p.jobs["dep"]!;
    assert.deepEqual(go.needs, ["prod"]);
    assert.equal(go.steps[0]!.run, 'echo "to ${{ needs.prod.outputs.v }}"');
  });

  it("rejects a runtime value in with: whose job is not in the call's needs", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  dep:\n    uses: workflow/deploy\n    with:\n      target: "\${{ needs.x.outputs.y }}"`, {
          deploy: `name: deploy\non: workflow_call\ninputs:\n  target: {}\njobs:\n  go:\n    steps: [{ run: "true" }]`,
        }),
      (e) => e instanceof WorkflowCompileError && /not in this job's 'needs:'/.test(e.message),
    );
  });

  it("rejects steps.* in with: (a reusable call has no steps)", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  dep:\n    uses: workflow/deploy\n    with:\n      target: "\${{ steps.x.outputs.y }}"`, {
          deploy: `name: deploy\non: workflow_call\ninputs:\n  target: {}\njobs:\n  go:\n    steps: [{ run: "true" }]`,
        }),
      (e) => e instanceof WorkflowCompileError && /may not reference "steps\.\*"/.test(e.message),
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
  it("fans the whole call out per cell, each collapsing onto the cell's leg id", () => {
    const p = plan(
      `name: caller\njobs:\n  dep:\n    strategy:\n      matrix:\n        env: [staging, prod]\n    uses: workflow/deploy\n    with:\n      target: "\${{ matrix.env }}"`,
      { deploy: `name: deploy\non: workflow_call\ninputs:\n  target: { required: true }\njobs:\n  go:\n    steps:\n      - run: 'echo "\${{ inputs.target }}"'` },
    );
    // One real job per cell (id = the call leg id), no join, no namespaced sub-job.
    assert.deepEqual(Object.keys(p.jobs).sort(), ["dep::env-prod", "dep::env-staging"]);
    assert.equal(p.jobs["dep::env-staging"]!.steps[0]!.run, 'echo "staging"');
    assert.equal(p.jobs["dep::env-prod"]!.steps[0]!.run, 'echo "prod"');
  });

  // Regression: a dotted cell value (e.g. version 1.5) becomes a reusable-namespace
  // prefix that must stay expression-grammar-safe (`[A-Za-z_][\w-]*`, no `.`) — a
  // multi-job callee's namespaced `${{ needs.<id>.outputs.* }}` would otherwise
  // reference an id the runtime resolver rejects at runtime.
  it("sanitizes a dotted cell value so namespaced needs.* ids stay resolvable", () => {
    const p = plan(
      `name: caller\njobs:\n  build:\n    strategy:\n      matrix:\n        ver: ["1.5"]\n    uses: workflow/lib\n    with:\n      v: "\${{ matrix.ver }}"`,
      {
        lib: `name: lib\non: workflow_call\ninputs:\n  v: { required: true }\njobs:\n  produce:\n    steps:\n      - id: m\n        run: 'echo "x=1" >> "$WORK_OUTPUT"'\n    outputs:\n      x: "\${{ steps.m.outputs.x }}"\n  consume:\n    needs: [produce]\n    steps:\n      - run: 'echo "\${{ needs.produce.outputs.x }}"'`,
      },
    );
    // Every job id (and the namespaced needs reference) is expression-grammar-safe.
    for (const id of Object.keys(p.jobs)) {
      assert.doesNotMatch(id, /\./, `job id ${id} must not contain a dot`);
    }
    const consume = Object.entries(p.jobs).find(([id]) => id.includes("consume"))![1];
    const m = /needs\.([\w-]+)\.outputs\.x/.exec(consume.steps[0]!.run!)!;
    assert.doesNotMatch(m[1]!, /\./, "namespaced needs id must be dot-free");
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
        // A *multi-job* callee namespaces as call__produce / call__consume, which
        // collides with the caller's own `call__produce`.
        plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib\n  call__produce:\n    steps: [{ run: "true" }]`, {
          lib: `name: lib\non: workflow_call\njobs:\n  produce:\n    steps: [{ run: "true" }]\n  consume:\n    needs: [produce]\n    steps: [{ run: "true" }]`,
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

  // Regression: `jobId in W.jobs` walked the prototype, so a producer named after an
  // Object.prototype member (`toString`, `constructor`, …) slipped past as "known"
  // and later crashed topoSort with a raw TypeError instead of a clean error.
  it("rejects a workflow_call.outputs producer named after a prototype member (no prototype walk)", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib`, {
          lib: `name: lib\non:\n  workflow_call:\n    outputs:\n      v: "\${{ jobs.toString.outputs.x }}"\njobs:\n  a:\n    steps: [{ run: "true" }]\n  b:\n    needs: [a]\n    steps: [{ run: "true" }]`,
        }),
      (e) => e instanceof WorkflowCompileError && /references unknown job "toString"/.test(e.message),
    );
  });

  // Regression: a multi-job callee exposing an output whose producer doesn't declare
  // the key compiled silently and failed late at runtime; reject it at compile time.
  it("rejects a multi-job callee output referencing an undeclared producer key", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib`, {
          lib: `name: lib\non:\n  workflow_call:\n    outputs:\n      v: "\${{ jobs.a.outputs.nope }}"\njobs:\n  a:\n    steps: [{ run: "true" }]\n  b:\n    needs: [a]\n    steps: [{ run: "true" }]`,
        }),
      (e) => e instanceof WorkflowCompileError && /does not declare output "nope"/.test(e.message),
    );
  });

  // Regression: a matrix-fanned call can't expose outputs unambiguously (one set per
  // cell); reject at compile time instead of failing late at runtime.
  // Regression: a workflow_call.outputs value must be exactly ONE ${{ }} expression
  // — multiple were silently collapsed to the last, yielding a wrong plan.
  it("rejects a workflow_call.outputs value composed of multiple ${{ }} expressions", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib`, {
          lib: `name: lib\non:\n  workflow_call:\n    outputs:\n      url: "\${{ jobs.a.outputs.host }}/\${{ jobs.a.outputs.path }}"\njobs:\n  a:\n    steps:\n      - id: m\n        run: 'true'\n    outputs:\n      host: "\${{ steps.m.outputs.host }}"\n      path: "\${{ steps.m.outputs.path }}"`,
        }),
      (e) => e instanceof WorkflowCompileError && /must be a single \$\{\{ \}\} expression/.test(e.message),
    );
  });

  // Regression: a single ${{ }} span with surrounding literal text (e.g. a
  // `https://` prefix) passed validation, then silently dropped the literal since
  // the exposed output is only the producer's raw value.
  it("rejects a workflow_call.outputs value with a literal around the ${{ }} span", () => {
    assert.throws(
      () =>
        plan(`name: caller\njobs:\n  call:\n    uses: workflow/lib`, {
          lib: `name: lib\non:\n  workflow_call:\n    outputs:\n      url: "https://\${{ jobs.a.outputs.host }}"\njobs:\n  a:\n    steps:\n      - id: m\n        run: 'true'\n    outputs:\n      host: "\${{ steps.m.outputs.host }}"`,
        }),
      (e) => e instanceof WorkflowCompileError && /must be the entire value/.test(e.message),
    );
  });

  it("rejects a matrix uses: call whose callee exposes workflow_call.outputs", () => {
    assert.throws(
      () =>
        plan(
          `name: caller\njobs:\n  call:\n    strategy:\n      matrix:\n        env: [staging, prod]\n    uses: workflow/lib\n    with:\n      target: "\${{ matrix.env }}"`,
          {
            lib: `name: lib\non:\n  workflow_call:\n    inputs:\n      target: { type: string }\n    outputs:\n      v: "\${{ jobs.run.outputs.version }}"\njobs:\n  run:\n    steps:\n      - id: meta\n        run: 'echo "version=1" >> "$WORK_OUTPUT"'\n    outputs:\n      version: "\${{ steps.meta.outputs.version }}"`,
          },
        ),
      (e) => e instanceof WorkflowCompileError && /matrix .*cannot expose workflow_call.outputs/.test(e.message),
    );
  });
});
