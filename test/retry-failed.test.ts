/**
 * "Re-run failed jobs" through the shared run path (`startRun`) — the GitHub
 * Actions tactic of retrying just the jobs that failed, reusing the ones that
 * passed, under the SAME runId (so the resume picks up where the passing jobs left
 * off). The runtime already reuses a finished job on a same-id re-drive; the new
 * `resetFailedJobs` clears a *cleanly-failed* job's journal (and the run's
 * orchestrator) so it re-runs from scratch while every successful job is reused.
 *
 * Modeled deterministically on the host double (no VM): a 2-job workflow `pass`
 * (always succeeds) + `flaky` (fails until a marker file appears). Each job appends
 * a byte to a per-job counter, so re-execution is visible from outside the journal.
 *   Phase 1 — no marker: `flaky` exits non-zero → run is `failure`. pass=1 flaky=1.
 *   reset  — create the marker, `resetFailedJobs`.
 *   Phase 2 — same dataDir + runId: `pass` is reused (pass stays 1), `flaky` re-runs
 *             and succeeds (flaky=2), the run reports `success`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { startRun } from "../src/run.ts";
import { createAbsurdEngine, resetFailedJobs } from "../src/runtime/index.ts";
import { hostTargetFactory } from "./_support.ts";

// `flaky` appends a byte then succeeds only once the marker exists; `pass` always
// succeeds. The marker/counter dir is injected via an input.
const WORKFLOW = `name: retry-failed
inputs:
  dir: { type: string, required: true }
jobs:
  pass:
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/pass"'
  flaky:
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/flaky"; test -f "\${{ inputs.dir }}/marker"'
`;

async function byteLen(path: string): Promise<number> {
  return (await readFile(path, "utf8").catch(() => "")).length;
}

describe("retry — re-run only a prior run's failed jobs", () => {
  it("reuses the passing job and re-runs the failed one under the same runId", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-retry-db-"));
    const sideDir = await mkdtemp(join(tmpdir(), "pi-wf-retry-fx-"));
    const workdir = await mkdtemp(join(tmpdir(), "pi-wf-retry-wr-"));
    const runId = "retry-run";
    const plan = compile(parseWorkflow(WORKFLOW), { inputs: { dir: sideDir } });

    try {
      // Phase 1 — `flaky` fails (no marker). Both jobs ran once; the run failed.
      const res1 = await startRun({ plan, runId, dataDir, workdir, makeTarget: hostTargetFactory });
      assert.equal(res1.status, "failure");
      assert.equal(await byteLen(join(sideDir, "pass")), 1, "pass ran once in phase 1");
      assert.equal(await byteLen(join(sideDir, "flaky")), 1, "flaky ran once in phase 1");

      // Clear the failed job's journal — only `flaky` should be reported as reset.
      const engine = await createAbsurdEngine({ dataDir });
      try {
        const { jobsReset } = await resetFailedJobs(engine, runId);
        assert.deepEqual(jobsReset.sort(), ["flaky"], "only the failed job is cleared");
      } finally {
        await engine.close();
      }

      // The flaky cause clears.
      await writeFile(join(sideDir, "marker"), "");

      // Phase 2 — retry: `pass` reused (no re-run), `flaky` re-runs and succeeds.
      const res2 = await startRun({ plan, runId, dataDir, workdir, makeTarget: hostTargetFactory });
      assert.equal(res2.status, "success", "the retried run succeeds");
      assert.equal(await byteLen(join(sideDir, "pass")), 1, "the passing job is NOT re-run on retry");
      assert.equal(await byteLen(join(sideDir, "flaky")), 2, "the failed job re-runs on retry");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(sideDir, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("resets nothing when there were no failed jobs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-retry-noop-db-"));
    const sideDir = await mkdtemp(join(tmpdir(), "pi-wf-retry-noop-fx-"));
    const runId = "retry-noop-run";
    // Pre-seed the marker so both jobs pass.
    await writeFile(join(sideDir, "marker"), "");
    const plan = compile(parseWorkflow(WORKFLOW), { inputs: { dir: sideDir } });

    try {
      const res = await startRun({ plan, runId, dataDir, makeTarget: hostTargetFactory });
      assert.equal(res.status, "success");

      const engine = await createAbsurdEngine({ dataDir });
      try {
        const { jobsReset } = await resetFailedJobs(engine, runId);
        assert.deepEqual(jobsReset, [], "a successful run has nothing to retry");
      } finally {
        await engine.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(sideDir, { recursive: true, force: true });
    }
  });
});
