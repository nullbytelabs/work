/**
 * #3 — the durable orchestrator. The whole workflow runs as one orchestrator task
 * that spawns + awaits job tasks on a *separate* queue. This pins the property that
 * makes the two-queue split necessary: an orchestrator awaiting its jobs must never
 * starve them of worker slots.
 *
 * With `maxConcurrency: 1`, if the orchestrator and the jobs shared a single worker
 * slot, the orchestrator would hold it while awaiting a job that needs it — a
 * deadlock (the run would hang). Because job tasks run on their own queue with their
 * own worker, a 1-slot run still completes. (Resume/durability across the
 * orchestrator is covered by durable-resume / run-resume / web-resume.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { AbsurdRuntime, createAbsurdEngine } from "../src/runtime/index.ts";
import { hostTargetFactory } from "./_support.ts";

describe("durable orchestrator — two-queue", () => {
  it("runs a multi-job DAG with maxConcurrency=1 without the orchestrator starving its jobs", async () => {
    const engine = await createAbsurdEngine();
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-orch-"));
    try {
      const runtime = new AbsurdRuntime({ engine, maxConcurrency: 1, makeTarget: hostTargetFactory });
      const plan = compile(
        parseWorkflow(`name: seq
jobs:
  a:
    steps:
      - run: echo a
  b:
    needs: [a]
    steps:
      - run: echo b
  c:
    needs: [b]
    steps:
      - run: echo c
`),
      );
      // A single shared worker slot would deadlock here (orchestrator holds it,
      // the job it awaits can't get one). Separate queues → this completes.
      const result = await runtime.run(plan, { workRoot });
      assert.equal(result.status, "success");
      assert.equal(result.jobs.length, 3);
      assert.deepEqual(
        result.jobs.map((j) => j.status),
        ["success", "success", "success"],
      );
    } finally {
      await engine.close();
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
