/**
 * The run-level status distinguishes a run that DIDN'T FINISH (its orchestrator
 * was interrupted — the platform stopped mid-flight) from one that ran to a
 * verdict and FAILED (a job exited non-zero). That distinction drives the right
 * recovery verb: `interrupted` → resume; `failure` → re-run failed. It's surfaced
 * as a third WorkflowResult status (and recorded in work.runs).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { AbsurdRuntime, createAbsurdEngine } from "../src/runtime/index.ts";
import type { ExecutionTarget, TargetFactory } from "../src/targets/index.ts";
import { HostTarget, hostTargetFactory } from "./_support.ts";

/** Tears `boom` out mid-step (its `run` rejects) — an interruption, not a non-zero exit. */
const crashBoom: TargetFactory = (_runsOn, ctx) => {
  const host = new HostTarget(ctx.workdir);
  if (basename(ctx.workdir) !== "boom") return host;
  const crashing: ExecutionTarget = {
    kind: "host",
    workspacePath: host.workspacePath,
    provision: () => host.provision(),
    run: () => Promise.reject(new Error("PLATFORM STOPPED (simulated)")),
    dispose: () => host.dispose(),
  };
  return crashing;
};

async function runOne(yaml: string, makeTarget: TargetFactory): Promise<string> {
  const engine = await createAbsurdEngine();
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-status-"));
  try {
    const runtime = new AbsurdRuntime({ engine, makeTarget });
    const result = await runtime.run(compile(parseWorkflow(yaml)), { workRoot });
    return result.status;
  } finally {
    await engine.close();
    await rm(workRoot, { recursive: true, force: true });
  }
}

describe("run status — interrupted vs failure", () => {
  it("reports `interrupted` when the run is torn out mid-flight", async () => {
    const status = await runOne(`name: w\njobs:\n  boom:\n    steps:\n      - run: echo hi`, crashBoom);
    assert.equal(status, "interrupted");
  });

  it("reports `failure` when a job runs and exits non-zero", async () => {
    const status = await runOne(`name: w\njobs:\n  boom:\n    steps:\n      - run: exit 1`, hostTargetFactory);
    assert.equal(status, "failure");
  });
});
