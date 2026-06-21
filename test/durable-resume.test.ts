/**
 * Durable whole-workflow crash-resume, pinned as a test.
 *
 * Absurd's whole point is durable execution: a run interrupted partway should be
 * resumable, and work that already finished should not be redone. The cross-job
 * orchestration runs inside a durable orchestrator task (see the runtime header
 * note + docs/durable-orchestrator.md), so a restart picks an interrupted run
 * back up. This test pins that behavior.
 *
 * It models a platform stop deterministically — no racing on worker leases:
 *   Phase 1 ("running")  — a 2-job workflow (`first` → `second`) runs against an
 *                          on-disk journal. `first` completes; `second`'s target
 *                          is torn out mid-step (its `run` rejects), exactly as if
 *                          the platform died under it. The run ends "failure".
 *   Phase 2 ("restart")  — a FRESH engine on the SAME dataDir + the SAME runId
 *                          re-invokes the run. The intended outcome:
 *                            • `first` is NOT re-executed (its journaled result is
 *                              reused) — proven by a side-effect counter file,
 *                            • `second` runs to completion this time,
 *                            • the resumed run reports success.
 *
 * Each job appends one byte to a per-job counter file, so "did this job's body
 * actually execute?" is observable from outside the journal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { AbsurdRuntime, createAbsurdEngine, StepInterrupted, type AbsurdEngine, type UsesHandler } from "../src/runtime/index.ts";
import { crashTargetFor, hostTargetFactory } from "./_support.ts";

// A well-behaved `uses:` handler: it calls `ctx.exec` (so a torn-out target makes
// the runtime-wrapped exec throw StepInterrupted) and re-throws StepInterrupted per
// the handler contract — mirroring the fixed work/agent + action handlers.
const probeUsesHandler: UsesHandler = {
  scheme: "probe",
  async run(ctx) {
    try {
      await ctx.exec("true");
      return { status: "success", outputs: { ran: "yes" } };
    } catch (err) {
      if (err instanceof StepInterrupted) throw err; // resumable tear-out, not a failure
      return { status: "failure", stderr: String(err) };
    }
  },
};

// Quiet the Absurd client: phase 1 intentionally fails a job, which would
// otherwise log noisily.
const SILENT = { log() {}, info() {}, warn() {}, error() {} };

// Two jobs, `second` needs `first`. Each appends exactly one byte to its own
// counter file (path injected via an input, resolved into the command at compile
// time) — so re-execution is visible as a 2-byte file.
const WORKFLOW = `name: durable-resume
inputs:
  dir: { type: string, required: true }
jobs:
  first:
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/first"'
  second:
    needs: [first]
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/second"'
`;

async function byteLen(path: string): Promise<number> {
  return (await readFile(path, "utf8").catch(() => "")).length;
}

describe("durable execution — whole-workflow crash-resume", () => {
  it("resumes an interrupted run: finished jobs aren't redone, the in-flight job completes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-resume-db-"));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-resume-wr-"));
    const sideDir = await mkdtemp(join(tmpdir(), "pi-wf-resume-fx-"));
    const runId = "resume-fixed-run";
    const plan = compile(parseWorkflow(WORKFLOW), { inputs: { dir: sideDir } });

    let e1: AbsurdEngine | undefined;
    let e2: AbsurdEngine | undefined;
    try {
      // Phase 1 — the platform "runs" then dies under `second`.
      e1 = await createAbsurdEngine({ dataDir, log: SILENT });
      const r1 = new AbsurdRuntime({ engine: e1, makeTarget: crashTargetFor("second") });
      const res1 = await r1.run(plan, { runId, workRoot });
      await e1.close();
      e1 = undefined;

      // The symptom: the interrupted run is reported as a failure.
      assert.equal(res1.status, "interrupted");
      assert.equal(await byteLen(join(sideDir, "first")), 1, "first should have run once in phase 1");
      assert.equal(await byteLen(join(sideDir, "second")), 0, "second was torn out before it could run");

      // Phase 2 — restart on the SAME journal + runId, with a healthy target.
      e2 = await createAbsurdEngine({ dataDir, log: SILENT });
      const r2 = new AbsurdRuntime({ engine: e2, makeTarget: hostTargetFactory });
      const res2 = await r2.run(plan, { runId, workRoot });
      await e2.close();
      e2 = undefined;

      // Intended behavior (fails until the runtime resumes via Absurd):
      assert.equal(res2.status, "success", "the resumed run should complete successfully");
      assert.equal(await byteLen(join(sideDir, "first")), 1, "a finished job must NOT re-run on resume");
      assert.equal(await byteLen(join(sideDir, "second")), 1, "the interrupted job must run to completion on resume");
    } finally {
      if (e1) await e1.close().catch(() => {});
      if (e2) await e2.close().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
      await rm(workRoot, { recursive: true, force: true });
      await rm(sideDir, { recursive: true, force: true });
    }
  });

  // Regression: a dispose() throw during an interruption must NOT downgrade the run
  // from resumable `interrupted` to terminal `failure`. Without the fix, the dispose
  // error replaces JobInterrupted in the finally, runJobInTask returns a failure
  // result instead of re-throwing, and the run is recorded non-resumable.
  it("keeps an interrupted run resumable even when the job's dispose() throws", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-disp-db-"));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-disp-wr-"));
    const sideDir = await mkdtemp(join(tmpdir(), "pi-wf-disp-fx-"));
    const runId = "dispose-throw-run";
    const plan = compile(parseWorkflow(WORKFLOW), { inputs: { dir: sideDir } });

    let e1: AbsurdEngine | undefined;
    let e2: AbsurdEngine | undefined;
    try {
      // Phase 1 — `second` is torn out AND its dispose throws.
      e1 = await createAbsurdEngine({ dataDir, log: SILENT });
      const res1 = await new AbsurdRuntime({ engine: e1, makeTarget: crashTargetFor("second", { disposeThrows: true }) }).run(plan, { runId, workRoot });
      await e1.close();
      e1 = undefined;
      // The dispose throw must not mask the interruption.
      assert.equal(res1.status, "interrupted", "a dispose throw must not downgrade interrupted → failure");

      // Phase 2 — restart with a healthy target: the run resumes to success.
      e2 = await createAbsurdEngine({ dataDir, log: SILENT });
      const res2 = await new AbsurdRuntime({ engine: e2, makeTarget: hostTargetFactory }).run(plan, { runId, workRoot });
      await e2.close();
      e2 = undefined;
      assert.equal(res2.status, "success", "the resumed run should complete successfully");
      assert.equal(await byteLen(join(sideDir, "first")), 1, "a finished job must NOT re-run on resume");
      assert.equal(await byteLen(join(sideDir, "second")), 1, "the interrupted job runs to completion on resume");
    } finally {
      if (e1) await e1.close().catch(() => {});
      if (e2) await e2.close().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
      await rm(workRoot, { recursive: true, force: true });
      await rm(sideDir, { recursive: true, force: true });
    }
  });

  // Regression: a `uses:` step torn out mid-execution must be resumable too — the
  // same durability `run:` steps get. Before the fix, a uses-handler swallowed the
  // target/exec rejection into a terminal failure, so the run was recorded
  // non-resumable `failure` and `resume` never retried the step.
  it("resumes a uses: step torn out mid-execution (parity with run: steps)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-uses-db-"));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-uses-wr-"));
    const sideDir = await mkdtemp(join(tmpdir(), "pi-wf-uses-fx-"));
    const runId = "uses-resume-run";
    const plan = compile(
      parseWorkflow(`name: durable-uses
inputs:
  dir: { type: string, required: true }
jobs:
  first:
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/first"'
  probe:
    needs: [first]
    steps:
      - uses: probe/run
`),
      { inputs: { dir: sideDir } },
    );
    // Tear out the `probe` job's target (its exec rejects), like a platform stop.
    const crashProbe = crashTargetFor("probe");

    let e1: AbsurdEngine | undefined;
    let e2: AbsurdEngine | undefined;
    try {
      e1 = await createAbsurdEngine({ dataDir, log: SILENT });
      const res1 = await new AbsurdRuntime({ engine: e1, makeTarget: crashProbe, usesHandlers: [probeUsesHandler] }).run(plan, { runId, workRoot });
      await e1.close();
      e1 = undefined;
      // The symptom this fixes: a torn-out uses: step is resumable, not terminal.
      assert.equal(res1.status, "interrupted", "a uses: tear-out must be interrupted (resumable), not failure");

      // Resume with a healthy target: `first` is not redone, `probe` completes.
      e2 = await createAbsurdEngine({ dataDir, log: SILENT });
      const res2 = await new AbsurdRuntime({ engine: e2, makeTarget: hostTargetFactory, usesHandlers: [probeUsesHandler] }).run(plan, { runId, workRoot });
      await e2.close();
      e2 = undefined;
      assert.equal(res2.status, "success", "the resumed run completes the uses: step");
      assert.equal(await byteLen(join(sideDir, "first")), 1, "the finished run: job is not re-run on resume");
    } finally {
      if (e1) await e1.close().catch(() => {});
      if (e2) await e2.close().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
      await rm(workRoot, { recursive: true, force: true });
      await rm(sideDir, { recursive: true, force: true });
    }
  });

  // The other side of the resumability boundary: a job that actually RAN and a
  // step exited non-zero is a real, terminal failure — re-invoking the run must
  // reuse that result, not silently re-execute the job (which, for a
  // deterministically-failing step, would loop forever).
  it("does not re-run a job that ran and failed (a clean non-zero exit stays terminal)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-fail-db-"));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-fail-wr-"));
    const sideDir = await mkdtemp(join(tmpdir(), "pi-wf-fail-fx-"));
    const runId = "failed-fixed-run";
    // One job whose only step records that it ran, then exits non-zero.
    const plan = compile(
      parseWorkflow(`name: real-failure
inputs:
  dir: { type: string, required: true }
jobs:
  boom:
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/boom"; exit 1'
`),
      { inputs: { dir: sideDir } },
    );

    let e1: AbsurdEngine | undefined;
    let e2: AbsurdEngine | undefined;
    try {
      e1 = await createAbsurdEngine({ dataDir, log: SILENT });
      const res1 = await new AbsurdRuntime({ engine: e1, makeTarget: hostTargetFactory }).run(plan, { runId, workRoot });
      await e1.close();
      e1 = undefined;
      assert.equal(res1.status, "failure");
      assert.equal(await byteLen(join(sideDir, "boom")), 1, "the failing step ran once");

      // Restart + re-invoke: the journaled failure is reused, the step is NOT re-run.
      e2 = await createAbsurdEngine({ dataDir, log: SILENT });
      const res2 = await new AbsurdRuntime({ engine: e2, makeTarget: hostTargetFactory }).run(plan, { runId, workRoot });
      await e2.close();
      e2 = undefined;
      assert.equal(res2.status, "failure", "a real failure stays failed across a restart");
      assert.equal(await byteLen(join(sideDir, "boom")), 1, "a job that ran and failed must not be silently retried");
    } finally {
      if (e1) await e1.close().catch(() => {});
      if (e2) await e2.close().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
      await rm(workRoot, { recursive: true, force: true });
      await rm(sideDir, { recursive: true, force: true });
    }
  });
});
