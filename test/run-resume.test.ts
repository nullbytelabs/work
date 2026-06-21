/**
 * Resume across invocations through the shared run path (`startRun`) — the layer
 * the CLI uses. The runtime can already resume a job interrupted mid-step
 * (test/durable-resume.test.ts), but only against a *persistent* journal with a
 * stable runId. The CLI path builds its own engine per run, so for `work run` to
 * be resumable `startRun` must persist that engine's journal to a caller-supplied
 * `dataDir`. This pins that: two `startRun` calls sharing a dataDir + runId resume
 * rather than recompute.
 *
 * Modeled deterministically (no racing on worker leases): phase 1's second job has
 * its target torn out mid-step (the platform "dies"); phase 2 re-invokes with the
 * same dataDir + runId and a healthy target. Each job appends one byte to a
 * per-job counter file, so re-execution is visible from outside the journal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { startRun } from "../src/run.ts";
import { createAbsurdEngine } from "../src/runtime/index.ts";
import { RunRepository } from "../src/persistence/runs.ts";
import { crashTargetFor, hostTargetFactory } from "./_support.ts";

const WORKFLOW = `name: cli-resume
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

describe("startRun — resumable across invocations (the CLI path)", () => {
  it("persists to dataDir so a re-invocation with the same runId resumes, not recomputes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-clires-db-"));
    const sideDir = await mkdtemp(join(tmpdir(), "pi-wf-clires-fx-"));
    const workdir = await mkdtemp(join(tmpdir(), "pi-wf-clires-wr-"));
    const runId = "cli-resume-run";
    const plan = compile(parseWorkflow(WORKFLOW), { inputs: { dir: sideDir } });

    try {
      // Phase 1 — the run is interrupted under `second`.
      const res1 = await startRun({ plan, runId, dataDir, workdir, makeTarget: crashTargetFor("second") });
      assert.equal(res1.status, "interrupted");
      assert.equal(await byteLen(join(sideDir, "first")), 1, "first ran once in phase 1");
      assert.equal(await byteLen(join(sideDir, "second")), 0, "second was torn out before it ran");

      // Phase 2 — same dataDir + runId, healthy target: resume.
      const res2 = await startRun({ plan, runId, dataDir, workdir, makeTarget: hostTargetFactory });
      assert.equal(res2.status, "success", "the resumed run completes");
      assert.equal(await byteLen(join(sideDir, "first")), 1, "a finished job must NOT be recomputed on resume");
      assert.equal(await byteLen(join(sideDir, "second")), 1, "the interrupted job completes on resume");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(sideDir, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  // Unified core: a persistent CLI run is the same durable run a web run is, so it
  // records into the *same* `work.runs` history the web UI lists. (The web records
  // its own runs through RunManager; an owned-engine persistent startRun records
  // here, so a `work run` shows up in history too.)
  it("records a persistent run in the shared work.runs history", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-hist-db-"));
    const sideDir = await mkdtemp(join(tmpdir(), "pi-wf-hist-fx-"));
    const runId = "history-run";
    const plan = compile(
      parseWorkflow(`name: histwf
inputs:
  dir: { type: string, required: true }
jobs:
  only:
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/only"'
`),
      { inputs: { dir: sideDir } },
    );

    try {
      const res = await startRun({ plan, runId, dataDir, makeTarget: hostTargetFactory });
      assert.equal(res.status, "success");

      // Re-open the same store the web UI reads; the run must be listed.
      const engine = await createAbsurdEngine({ dataDir });
      try {
        const runs = new RunRepository(engine);
        await runs.ensureSchema();
        const row = (await runs.list()).find((r) => r.id === runId);
        assert.ok(row, "the CLI run should be recorded in work.runs");
        assert.equal(row.status, "success");
        assert.equal(row.name, "histwf");
      } finally {
        await engine.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(sideDir, { recursive: true, force: true });
    }
  });
});
