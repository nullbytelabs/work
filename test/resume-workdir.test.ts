/**
 * Crash-resume must preserve the per-job WORK DIR across invocations, not just the
 * step journal. A resumed job re-stages only the checkout and fast-forwards
 * already-completed steps WITHOUT re-running them, so the filesystem side-effects
 * those steps produced (a `build/` dir, generated files, …) must still be on disk
 * when a later step resumes. This pins that `startRun` keeps a minted work dir for
 * an `interrupted` (resumable) run and reuses it on resume — going through the real
 * `startRun` lifecycle (the ephemeral-temp-dir rm used to wipe it between runs).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { startRun } from "../src/run.ts";
import type { ExecutionTarget, TargetFactory } from "../src/targets/index.ts";
import { HostTarget, hostTargetFactory } from "./_support.ts";

// One job, two steps: step 1 writes `build/marker` into the job workdir; step 2
// reads it back. The target tears step 2 out the FIRST time (platform stop after
// build), then runs normally on resume — so step 2's success proves step 1's file
// survived in the reused workdir (its closure is memoized, never re-run).
const WORKFLOW = `name: resume-workdir
jobs:
  build-test:
    steps:
      - id: build
        run: 'mkdir -p build && printf ok > build/marker'
      - id: test
        run: 'cat build/marker'
`;

describe("crash-resume preserves the per-job work dir", () => {
  it("a resumed step sees a completed step's filesystem side-effects", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-wf-rwd-db-"));
    const runId = "resume-workdir-run";
    const plan = compile(parseWorkflow(WORKFLOW));
    // The minted work dir is deterministic from runId (so we can assert it survives).
    const expectedWorkRoot = join(tmpdir(), `work-${runId}`);

    // Tear out the SECOND `run` invocation in the build-test job (step 2) on phase 1.
    let runs = 0;
    const crashSecondStep: TargetFactory = (_runsOn, ctx) => {
      const host = new HostTarget(ctx.workdir);
      if (basename(ctx.workdir) !== "build-test") return host;
      const target: ExecutionTarget = {
        kind: "host",
        workspacePath: host.workspacePath,
        provision: () => host.provision(),
        run: (cmd, opts) => {
          runs++;
          if (runs === 2) return Promise.reject(new Error("PLATFORM STOPPED after build (simulated)"));
          return host.run(cmd, opts);
        },
        dispose: () => host.dispose(),
      };
      return target;
    };

    try {
      // Phase 1 — build runs, test is torn out → interrupted (resumable).
      const res1 = await startRun({ plan, runId, dataDir, makeTarget: crashSecondStep });
      assert.equal(res1.status, "interrupted");
      // The work dir must NOT have been cleaned up — resume needs build/marker.
      await assert.doesNotReject(access(join(expectedWorkRoot, "build-test", "build", "marker")), "build/ must survive an interrupted run");

      // Phase 2 — resume on the same dataDir + runId with a healthy target. Use the
      // host double (not the default GondolinTarget): this test pins work-dir survival
      // across the startRun lifecycle, not VM behavior, so resume must not boot/build a
      // real micro-VM (a nested image build has no lz4 in the work:nested guest).
      const res2 = await startRun({ plan, runId, dataDir, makeTarget: hostTargetFactory });
      assert.equal(res2.status, "success", "the resumed test step finds build/marker and succeeds");
      const test = res2.jobs[0]!.steps.find((s) => s.name.endsWith("/test"))!;
      assert.equal(test.stdout.trim(), "ok", "the memoized build step's file was present on resume");

      // A terminal run cleans its minted work dir up.
      await assert.rejects(access(expectedWorkRoot), "a terminal run removes its minted work dir");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(expectedWorkRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
