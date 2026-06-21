/**
 * Model-based (stateful) property test for durable crash-resume — the one
 * property the engine lives or dies on, generalized past the single hand-picked
 * crash in durable-resume.test.ts to an *arbitrary crash schedule*.
 *
 * The system under test is `AbsurdRuntime` over a persistent (on-disk) journal:
 * a job torn out mid-step fails its task (resumable); re-invoking `run()` with the
 * same runId fast-forwards committed `ctx.step` checkpoints and re-drives the rest
 * (see the runtime header + docs/durable-orchestrator.md).
 *
 * `fc.commands` generates a sequence of `CrashAt(<step>)` operations; each runs the
 * whole workflow on a FRESH engine over the SAME dataDir+runId, tearing out one
 * chosen step. The invariants checked after every attempt and at completion:
 *
 *   I1 at-most-once — every step appends exactly one byte to its own counter file
 *      when it commits; a torn-out attempt writes nothing (the tear-out fires
 *      *before* the command runs). So no counter ever exceeds 1 byte: a committed
 *      step is never re-executed on resume.
 *   I2 convergence  — a clean resume always finishes the run.
 *   I3 determinism  — the terminal per-job outcome is identical to a clean
 *      once-through run, no matter when/where the crashes happened.
 *
 * The DAG is LINEAR (build → test → deploy) on purpose: with parallel jobs a
 * sibling could be mid-`run()` when the orchestrator tears down on the armed
 * crash, leaving a byte written but its checkpoint uncommitted (a spurious
 * counter=2). Linear means exactly one job is ever in flight, so I1 stays exact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkflow } from "../src/spec/index.ts";
import { compile, type ExecutionPlan } from "../src/compiler/index.ts";
import { AbsurdRuntime, createAbsurdEngine, type WorkflowResult } from "../src/runtime/index.ts";
import type { ExecutionTarget, TargetFactory } from "../src/targets/index.ts";
import { HostTarget } from "./_support.ts";

// Quiet the Absurd client: an interrupted attempt fails a job task, which would
// otherwise log noisily.
const SILENT = { log() {}, info() {}, warn() {}, error() {} };

// 8 steps across a linear 3-job chain. Each step echoes a unique marker (the
// crash key) and appends one byte to its own counter file under inputs.dir, so
// "did this step's body actually run?" is observable from outside the journal.
const STEP_IDS = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"] as const;
const MARKS = STEP_IDS.map((s) => `MARK_${s}`);

function stepBlock(ids: string[]): string {
  return ids
    .map((s) => `      - id: ${s}\n        run: 'echo MARK_${s}; printf x >> "\${{ inputs.dir }}/${s}"'`)
    .join("\n");
}

const WORKFLOW = `name: resume-model
inputs:
  dir: { type: string, required: true }
jobs:
  build:
    steps:
${stepBlock(["s0", "s1"])}
  test:
    needs: [build]
    steps:
${stepBlock(["s2", "s3", "s4"])}
  deploy:
    needs: [test]
    steps:
${stepBlock(["s5", "s6", "s7"])}
`;

const buildPlan = (counterDir: string): ExecutionPlan =>
  compile(parseWorkflow(WORKFLOW), { inputs: { dir: counterDir } });

/** A controller a job's target consults: when a marker is armed and appears in the
 *  command, reject (a tear-out *before* the side effect) — exactly the resumable
 *  interruption a dying VM produces. Disarm on hit so teardown can't re-trip it. */
interface Controller {
  armed: string | null;
}

function controllerFactory(controller: Controller): TargetFactory {
  return (_runsOn, ctx) => {
    const host = new HostTarget(ctx.workdir);
    const target: ExecutionTarget = {
      kind: "host",
      workspacePath: host.workspacePath,
      provision: () => host.provision(),
      run: (cmd, opts) => {
        if (controller.armed && cmd.includes(controller.armed)) {
          controller.armed = null;
          return Promise.reject(new Error(`tear-out at ${cmd} (simulated platform stop)`));
        }
        return host.run(cmd, opts ?? {});
      },
      dispose: () => host.dispose(),
    };
    return target;
  };
}

interface Real {
  dataDir: string;
  counterDir: string;
  workRoot: string;
  runId: string;
  plan: ExecutionPlan;
  controller: Controller;
  reference: NormResult;
}

/** One full run on a fresh engine over the shared dataDir+runId — the resume unit. */
async function runOnce(real: Real): Promise<WorkflowResult> {
  const engine = await createAbsurdEngine({ dataDir: real.dataDir, log: SILENT });
  try {
    const rt = new AbsurdRuntime({ engine, makeTarget: controllerFactory(real.controller) });
    return await rt.run(real.plan, { runId: real.runId, workRoot: real.workRoot });
  } finally {
    await engine.close();
  }
}

async function readCounters(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of STEP_IDS) out[s] = (await readFile(join(dir, s), "utf8").catch(() => "")).length;
  return out;
}

type NormResult = { status: string; jobs: { id: string; status: string }[] };

/** Project a result down to what must be invariant across any crash schedule:
 *  the terminal status and each job's id+status (sorted) — not stdout/timing. */
function normalize(r: WorkflowResult): NormResult {
  return {
    status: r.status,
    jobs: r.jobs.map((j) => ({ id: j.id, status: j.status })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

interface Model {
  done: boolean;
  attempts: number;
  interrupts: number;
}

/** One generated operation: run the workflow, tearing out the chosen step. */
class CrashAt {
  readonly mark: string;
  constructor(mark: string) {
    this.mark = mark;
  }
  check(m: Model): boolean {
    return !m.done;
  }
  async run(m: Model, r: Real): Promise<void> {
    m.attempts += 1;
    r.controller.armed = this.mark;
    const result = await runOnce(r);
    r.controller.armed = null;

    // I1 — at-most-once: no committed step ever re-runs (counter > 1 byte).
    const counters = await readCounters(r.counterDir);
    for (const [s, n] of Object.entries(counters)) assert.ok(n <= 1, `step ${s} executed ${n}× (>1)`);

    if (result.status === "interrupted") {
      m.interrupts += 1;
      return;
    }
    // A completed run: I3 — identical terminal outcome to a clean once-through run,
    // regardless of the crash history that preceded it.
    assert.deepEqual(normalize(result), r.reference);
    m.done = true;
  }
  toString(): string {
    return `CrashAt(${this.mark})`;
  }
}

test("resume-model · any crash schedule converges to the clean-run outcome, steps run at most once", async () => {
  // The clean-run reference (computed once; it depends only on job statuses, not on
  // the per-invocation counter dir).
  const refData = await mkdtemp(join(tmpdir(), "resume-model-refdb-"));
  const refCount = await mkdtemp(join(tmpdir(), "resume-model-reffx-"));
  const refWork = await mkdtemp(join(tmpdir(), "resume-model-refwr-"));
  let reference: NormResult;
  try {
    const refResult = await runOnce({
      dataDir: refData,
      counterDir: refCount,
      workRoot: refWork,
      runId: "resume-model-ref",
      plan: buildPlan(refCount),
      controller: { armed: null },
      reference: { status: "", jobs: [] },
    });
    assert.equal(refResult.status, "success", "the clean reference run must succeed");
    reference = normalize(refResult);
  } finally {
    await rm(refData, { recursive: true, force: true });
    await rm(refCount, { recursive: true, force: true });
    await rm(refWork, { recursive: true, force: true });
  }

  const commandArb = fc.constantFrom(...MARKS).map((mk) => new CrashAt(mk));

  await fc.assert(
    fc.asyncProperty(fc.commands([commandArb], { maxCommands: 6 }), async (cmds) => {
      const dataDir = await mkdtemp(join(tmpdir(), "resume-model-db-"));
      const counterDir = await mkdtemp(join(tmpdir(), "resume-model-fx-"));
      const workRoot = await mkdtemp(join(tmpdir(), "resume-model-wr-"));
      try {
        const real: Real = {
          dataDir,
          counterDir,
          workRoot,
          runId: "resume-model-run",
          plan: buildPlan(counterDir),
          controller: { armed: null },
          reference,
        };
        const model: Model = { done: false, attempts: 0, interrupts: 0 };

        await fc.asyncModelRun(() => ({ model, real }), cmds);

        // I2 — convergence: a clean resume always finishes the run.
        if (!model.done) {
          real.controller.armed = null;
          const result = await runOnce(real);
          assert.equal(result.status, "success", "a clean resume must complete the run");
          const counters = await readCounters(counterDir);
          for (const [s, n] of Object.entries(counters)) assert.equal(n, 1, `step ${s} counter = ${n} at completion (want 1)`);
          assert.deepEqual(normalize(result), reference);
          model.done = true;
        }

        // Anti-tautology: if we actually armed any crash, the first one (nothing
        // committed yet) must have hit — otherwise the test exercised no resume.
        if (model.attempts > 0) {
          assert.ok(model.interrupts > 0, "armed crash(es) but never interrupted — the test would be trivial");
        }
      } finally {
        await rm(dataDir, { recursive: true, force: true });
        await rm(counterDir, { recursive: true, force: true });
        await rm(workRoot, { recursive: true, force: true });
      }
    }),
    { numRuns: 15, timeout: 120_000 },
  );
});
