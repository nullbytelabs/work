/**
 * Runtime test for reusable workflows: compile a caller that invokes a callee
 * producing an output, run it on the HostTarget double (no VM), and prove the
 * collapsed call node runs the callee's job for real and exposes its output to a
 * downstream caller job via `needs.<call>.outputs.*`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, type ResolveWorkflow } from "../src/compiler/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import type { WorkflowResult } from "../src/runtime/index.ts";
import { useSharedRuntime } from "./_support.ts";

const runtime = useSharedRuntime();

const CALLER = `name: caller
jobs:
  build:
    uses: workflow/build
  deploy:
    needs: [build]
    steps:
      - run: 'echo "deployed version=\${{ needs.build.outputs.version }}"'
`;

const BUILD = `name: build
on:
  workflow_call:
    outputs:
      version: "\${{ jobs.compile.outputs.version }}"
jobs:
  compile:
    steps:
      - id: meta
        run: 'echo "version=42" >> "$WORK_OUTPUT"'
    outputs:
      version: "\${{ steps.meta.outputs.version }}"
`;

const resolver: ResolveWorkflow = (ref) => {
  if (ref.replace(/^workflow\//, "") !== "build") throw new Error(`unexpected ref ${ref}`);
  return { spec: parseWorkflow(BUILD), dir: "/wf", file: "/wf/build.yaml" };
};

function jobOf(result: WorkflowResult, id: string) {
  const j = result.jobs.find((x) => x.id === id);
  assert.ok(j, `no job ${id} in result`);
  return j;
}

describe("reusable — runtime", () => {
  it("collapses a single-job callee and threads its output downstream", async () => {
    const plan = compile(parseWorkflow(CALLER), {
      resolveWorkflow: resolver,
      _fromDir: "/wf",
      _chain: ["/wf/caller.yaml"],
      _depth: 0,
    });

    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-reusable-"));
    let output = "";
    try {
      const result = await runtime.run(plan, {
        workRoot,
        hooks: { onOutput: (_j, _s, c) => (output += c.text) },
      });

      assert.equal(result.status, "success");
      // The callee's job ran for real AS the call id `build` and captured its output.
      const buildJob = jobOf(result, "build");
      assert.equal(buildJob.status, "success");
      assert.equal(buildJob.steps.length, 1);
      assert.deepEqual(buildJob.outputs, { version: "42" });
      // No separate namespaced producer job exists — the call IS the job.
      assert.equal(result.jobs.find((x) => x.id === "build__compile"), undefined);
      // The downstream caller job read it through needs.build.outputs.version.
      assert.match(output, /deployed version=42/);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  // The checks→review pattern: a producer job's output reaches a *reusable
  // workflow's* root job via inherited needs. The caller's `uses:` job
  // `needs: [producer]`, so the callee's root jobs inherit that need and read
  // `${{ needs.producer.outputs.* }}` at runtime — without any with:/inputs.
  const CALLER2 = `name: caller2
jobs:
  producer:
    steps:
      - id: m
        run: 'echo "x=carried" >> "$WORK_OUTPUT"'
    outputs:
      x: "\${{ steps.m.outputs.x }}"
  consumer:
    needs: [producer]
    uses: workflow/sink
`;
  const SINK2 = `name: sink
on: workflow_call
jobs:
  reader:
    steps:
      - run: 'echo "got=\${{ needs.producer.outputs.x }}"'
  tail:
    needs: [reader]
    steps:
      - run: "true"
`;

  it("threads a producer's output into a reusable callee's root job via inherited needs", async () => {
    const sinkResolver: ResolveWorkflow = (ref) => {
      if (ref.replace(/^workflow\//, "") !== "sink") throw new Error(`unexpected ref ${ref}`);
      return { spec: parseWorkflow(SINK2), dir: "/wf", file: "/wf/sink.yaml" };
    };
    const plan = compile(parseWorkflow(CALLER2), {
      resolveWorkflow: sinkResolver,
      _fromDir: "/wf",
      _chain: ["/wf/caller.yaml"],
      _depth: 0,
    });

    // Multi-job callee → namespaced; the root reader inherits the caller's needs.
    assert.deepEqual(plan.jobs["consumer__reader"]!.needs, ["producer"]);

    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-inherit-"));
    let output = "";
    try {
      const result = await runtime.run(plan, {
        workRoot,
        hooks: { onOutput: (_j, _s, c) => (output += c.text) },
      });
      assert.equal(result.status, "success");
      // The callee root read the producer's output through the inherited need.
      assert.match(output, /got=carried/);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  // The PREFERRED pattern (what ci.yaml→review.yaml now uses): the caller passes a
  // producer's runtime output into the callee EXPLICITLY via `with:`, mapping it
  // onto the callee's declared `inputs:`. The callee references only `inputs.*` —
  // it never reaches into a caller-side job — so it reads cleanly and runs
  // standalone with input defaults. The runtime value resolves through the need
  // the caller declared.
  const CALLER3 = `name: caller3
jobs:
  producer:
    steps:
      - id: m
        run: 'echo "x=explicit" >> "$WORK_OUTPUT"'
    outputs:
      x: "\${{ steps.m.outputs.x }}"
  consumer:
    needs: [producer]
    uses: workflow/sink3
    with:
      payload: "\${{ needs.producer.outputs.x }}"
`;
  const SINK3 = `name: sink3
on: workflow_call
inputs:
  payload: { type: string, default: "none" }
jobs:
  reader:
    steps:
      - run: 'echo "saw=\${{ inputs.payload }}"'
`;

  it("threads a runtime with: value into the callee's inputs.* and resolves it at runtime", async () => {
    const sinkResolver: ResolveWorkflow = (ref) => {
      if (ref.replace(/^workflow\//, "") !== "sink3") throw new Error(`unexpected ref ${ref}`);
      return { spec: parseWorkflow(SINK3), dir: "/wf", file: "/wf/sink3.yaml" };
    };
    const plan = compile(parseWorkflow(CALLER3), {
      resolveWorkflow: sinkResolver,
      _fromDir: "/wf",
      _chain: ["/wf/caller.yaml"],
      _depth: 0,
    });

    // Single-job callee → collapses onto the call id `consumer`. inputs.payload
    // was rewritten to the caller's runtime expression, scoped to the inherited
    // need on `producer`.
    const reader = plan.jobs["consumer"]!;
    assert.deepEqual(reader.needs, ["producer"]);
    assert.match(reader.steps[0]!.run!, /needs\.producer\.outputs\.x/);
    assert.doesNotMatch(reader.steps[0]!.run!, /inputs\.payload/);

    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-with-runtime-"));
    let output = "";
    try {
      const result = await runtime.run(plan, {
        workRoot,
        hooks: { onOutput: (_j, _s, c) => (output += c.text) },
      });
      assert.equal(result.status, "success");
      assert.match(output, /saw=explicit/);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
