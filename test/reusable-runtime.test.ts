/**
 * Runtime test for reusable workflows: compile a caller that invokes a callee
 * producing an output, run it on the HostTarget double (no VM), and prove the
 * virtual join boots nothing yet threads the callee's output to a downstream
 * caller job via `needs.<call>.outputs.*`.
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
  it("inlines a callee and threads its output through the virtual join", async () => {
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
      // The producer ran for real and captured its output.
      assert.deepEqual(jobOf(result, "build__compile").outputs, { version: "42" });
      // The virtual join aggregated it from its needs (boots no VM, no steps).
      const joinJob = jobOf(result, "build");
      assert.equal(joinJob.status, "success");
      assert.deepEqual(joinJob.steps, []);
      assert.deepEqual(joinJob.outputs, { version: "42" });
      // The downstream caller job read it through needs.build.outputs.version.
      assert.match(output, /deployed version=42/);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
