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
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { AbsurdRuntime, createAbsurdEngine } from "../src/runtime/index.ts";
import type { TargetFactory } from "../src/targets/index.ts";
import { crashTargetFor, hostTargetFactory } from "./_support.ts";

async function runOne(yaml: string, makeTarget: TargetFactory): Promise<string> {
  return (await runFull(yaml, makeTarget)).status;
}

async function runFull(yaml: string, makeTarget: TargetFactory) {
  const engine = await createAbsurdEngine();
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-status-"));
  try {
    const runtime = new AbsurdRuntime({ engine, makeTarget });
    return await runtime.run(compile(parseWorkflow(yaml)), { workRoot });
  } finally {
    await engine.close();
    await rm(workRoot, { recursive: true, force: true });
  }
}

describe("run status — interrupted vs failure", () => {
  it("reports `interrupted` when the run is torn out mid-flight", async () => {
    const status = await runOne(`name: w\njobs:\n  boom:\n    steps:\n      - run: echo hi`, crashTargetFor("boom"));
    assert.equal(status, "interrupted");
  });

  it("reports `failure` when a job runs and exits non-zero", async () => {
    const status = await runOne(`name: w\njobs:\n  boom:\n    steps:\n      - run: exit 1`, hostTargetFactory);
    assert.equal(status, "failure");
  });
});

describe("continue-on-error", () => {
  it("a failing continue-on-error step doesn't fail the job, and later steps still run", async () => {
    const result = await runFull(
      `name: w
jobs:
  j:
    steps:
      - id: lint
        continue-on-error: true
        run: |
          echo "log=boom" >> "$WORK_OUTPUT"
          exit 3
      - id: after
        run: 'echo "ran=yes" >> "$WORK_OUTPUT"'`,
      hostTargetFactory,
    );
    assert.equal(result.status, "success");
    const job = result.jobs.find((j) => j.id === "j")!;
    assert.equal(job.status, "success");
    // The tolerated step's real outcome is still recorded (not masked to success).
    const lint = job.steps.find((s) => s.name.endsWith("/lint"))!;
    assert.equal(lint.status, "failure");
    // ...and its $WORK_OUTPUT is captured despite the non-zero exit (so a capture
    // step that runs a failing tool can still expose the tool's output).
    assert.equal(lint.outputs?.log, "boom");
    // The step after it ran (a normal non-zero exit would have skipped it).
    const after = job.steps.find((s) => s.name.endsWith("/after"))!;
    assert.equal(after.status, "success");
    assert.equal(after.outputs?.ran, "yes");
  });

  it("forwards a failing tool's combined output via steps.<id>.logs (the checks.yaml pattern)", async () => {
    // The real dogfood pattern: a `continue-on-error` step runs a tool that
    // fails; its stdout+stderr is exposed as `steps.<id>.logs` (no $WORK_OUTPUT
    // wrapper) and forwarded as a job output for a downstream reviewer.
    const result = await runFull(
      `name: w
jobs:
  j:
    outputs:
      tool: \${{ steps.tool.logs }}
      result: \${{ steps.tool.outcome }}
      code: \${{ steps.tool.exitCode }}
    steps:
      - id: tool
        name: tool
        continue-on-error: true
        run: |
          echo "hello from stdout"
          echo "oops on stderr" 1>&2
          exit 7`,
      hostTargetFactory,
    );
    assert.equal(result.status, "success");
    const job = result.jobs.find((j) => j.id === "j")!;
    assert.equal(job.status, "success");
    // logs is the combined stdout+stderr — captured even though the tool failed.
    assert.match(job.outputs?.tool ?? "", /hello from stdout/);
    assert.match(job.outputs?.tool ?? "", /oops on stderr/);
    // outcome reflects the real (failed) result; exitCode is the command's code.
    assert.equal(job.outputs?.result, "failure");
    assert.equal(job.outputs?.code, "7");
  });

  it("without continue-on-error, a non-zero step fails the job and skips the rest", async () => {
    const result = await runFull(
      `name: w
jobs:
  j:
    steps:
      - run: exit 3
      - id: after
        run: 'echo "ran=yes" >> "$WORK_OUTPUT"'`,
      hostTargetFactory,
    );
    assert.equal(result.status, "failure");
    const job = result.jobs.find((j) => j.id === "j")!;
    const after = job.steps.find((s) => s.name.endsWith("/after"))!;
    assert.equal(after.status, "skipped");
  });
});
