/**
 * AbsurdRuntime — the engine's durable runtime (the only one).
 *
 * A whole workflow run is one Absurd **task**; each `<job>/<step>` is a durable
 * `ctx.step(...)` checkpoint. Job order, env, workspace staging, and the
 * failure/skip semantics live inside the task handler, with the step bodies as
 * the memoized units — so a completed step is never recomputed on a replay.
 *
 * On PGLite the backend is single-connection, so execution serializes (no true
 * parallelism); `needs` ordering is preserved via the compiled `jobOrder`.
 * The same code runs against a server Postgres provider unchanged.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, cp } from "node:fs/promises";
import type { TaskContext } from "absurd-sdk";
import { makeTarget } from "../../targets/index.ts";
import { createAbsurdEngine, type AbsurdEngine } from "./engine.ts";
import type { ExecutionPlan, PlannedJob } from "../../compiler/index.ts";
import type { JobResult, RunContext, Runtime, StepResult, WorkflowResult } from "../types.ts";

export interface AbsurdRuntimeOptions {
  /** PGLite data dir for persistence; omit for ephemeral in-memory. */
  dataDir?: string;
  /** Inject a shared engine (e.g. in tests) so it isn't booted/closed per run. */
  engine?: AbsurdEngine;
}

export class AbsurdRuntime implements Runtime {
  readonly kind = "absurd";
  private engine: AbsurdEngine | null;
  private readonly ownsEngine: boolean;
  private readonly dataDir: string | undefined;

  constructor(opts: AbsurdRuntimeOptions = {}) {
    this.engine = opts.engine ?? null;
    this.ownsEngine = opts.engine === undefined;
    this.dataDir = opts.dataDir;
  }

  private async ensureEngine(): Promise<AbsurdEngine> {
    if (!this.engine) this.engine = await createAbsurdEngine({ dataDir: this.dataDir });
    return this.engine;
  }

  async run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult> {
    const { app } = await this.ensureEngine();

    // One durable task per run; unique name so a shared engine can host many.
    const taskName = `workflow:${plan.name}:${randomUUID()}`;
    app.registerTask(
      { name: taskName, queue: "default", defaultMaxAttempts: 1 },
      async (_params: unknown, taskCtx: TaskContext) => executePlan(plan, ctx, taskCtx),
    );

    const { taskID } = await app.spawn(taskName, {}, { queue: "default" });

    // Drive the worker until the task reaches a terminal state. The whole
    // workflow runs within one claim; checkpoints extend the lease.
    let snapshot = await app.fetchTaskResult(taskID);
    for (let i = 0; i < 100_000; i++) {
      if (snapshot && (snapshot.state === "completed" || snapshot.state === "failed" || snapshot.state === "cancelled")) {
        break;
      }
      await app.workBatch("pi-workflows", 300, 1);
      snapshot = await app.fetchTaskResult(taskID);
    }

    if (snapshot && snapshot.state === "completed") {
      return snapshot.result as unknown as WorkflowResult;
    }
    // The handler turns workflow failures into a completed result, so reaching
    // here means the task itself errored unexpectedly.
    const detail = snapshot && snapshot.state === "failed" ? JSON.stringify(snapshot.failure) : JSON.stringify(snapshot);
    throw new Error(`workflow task did not complete cleanly: ${detail}`);
  }

  /** Tear down the engine if this runtime owns it. */
  async close(): Promise<void> {
    if (this.ownsEngine && this.engine) {
      await this.engine.close();
      this.engine = null;
    }
  }
}

async function executePlan(
  plan: ExecutionPlan,
  ctx: RunContext,
  taskCtx: TaskContext,
): Promise<WorkflowResult> {
  const jobs: JobResult[] = [];
  let aborted = false;

  for (const jobId of plan.jobOrder) {
    const job = plan.jobs[jobId]!;
    if (aborted) {
      jobs.push({ id: jobId, status: "skipped", steps: [] });
      continue;
    }
    const result = await runJob(job, ctx, taskCtx);
    jobs.push(result);
    if (result.status === "failure") aborted = true;
  }

  return {
    name: plan.name,
    status: jobs.some((j) => j.status === "failure") ? "failure" : "success",
    jobs,
  };
}

async function runJob(job: PlannedJob, ctx: RunContext, taskCtx: TaskContext): Promise<JobResult> {
  ctx.hooks?.onJobStart?.(job.id);
  const workdir = join(ctx.workRoot, job.id);

  // Stage the workflow's directory into this job's isolated workspace.
  await mkdir(workdir, { recursive: true });
  if (ctx.workspaceSource) {
    await cp(ctx.workspaceSource, workdir, { recursive: true });
  }

  // Resolving/provisioning the target can fail for environmental reasons (e.g.
  // gondolin not installed). Surface that as a failed step rather than crashing
  // the whole task, so the message reaches the user and the workflow fails cleanly.
  let target;
  try {
    target = makeTarget(job.runsOn, { workdir });
    await target.provision();
  } catch (err) {
    const result: StepResult = {
      name: `${job.id}/provision`,
      status: "failure",
      exitCode: 1,
      stdout: "",
      stderr: (err as Error).message,
    };
    ctx.hooks?.onStepEnd?.(job.id, result);
    return { id: job.id, status: "failure", steps: [result] };
  }

  const steps: StepResult[] = [];
  let failed = false;
  try {
    for (const step of job.steps) {
      if (failed) {
        steps.push({ name: step.name, status: "skipped", exitCode: 0, stdout: "", stderr: "" });
        continue;
      }

      // `uses` (agentic) steps are recognized but not executable yet.
      if (step.run === undefined) {
        const result: StepResult = {
          name: step.name,
          status: "failure",
          exitCode: 1,
          stdout: "",
          stderr: `step "${step.name}" uses "${step.uses}" — "uses" steps are not supported yet`,
        };
        ctx.hooks?.onStepStart?.(job.id, step.name);
        ctx.hooks?.onStepEnd?.(job.id, result);
        steps.push(result);
        failed = true;
        continue;
      }

      ctx.hooks?.onStepStart?.(job.id, step.name);
      const command = step.run;
      const stepEnv = step.env;
      // Durable checkpoint: the command runs once and its result is memoized.
      const result = await taskCtx.step<StepResult>(step.name, async () => {
        const run = await target.run(command, {
          env: stepEnv,
          onOutput: (chunk) => ctx.hooks?.onOutput?.(job.id, step.name, chunk),
        });
        return {
          name: step.name,
          status: run.ok ? "success" : "failure",
          exitCode: run.exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
        };
      });
      ctx.hooks?.onStepEnd?.(job.id, result);
      steps.push(result);
      if (result.status === "failure") failed = true;
    }
  } finally {
    await target.dispose();
  }

  return { id: job.id, status: failed ? "failure" : "success", steps };
}
