/**
 * AbsurdRuntime — the engine's durable runtime (the only one).
 *
 * Each **job** is its own durable Absurd task; each `<job>/<step>` is a durable
 * `ctx.step(...)` checkpoint, so a completed step is never recomputed on a retry.
 * The runtime itself walks the `needs` DAG: it spawns a job's task once all the
 * job's dependencies have succeeded, and runs an Absurd worker with
 * `concurrency > 1` so independent jobs execute **in parallel** (verified to
 * overlap even on single-connection PGLite — only checkpoint writes serialize).
 *
 * Failure/skip semantics (GitHub-Actions-like): a job runs only if every job in
 * its `needs` succeeded; if any dependency failed or was skipped, the job is
 * skipped. Independent jobs are unaffected by another job's failure.
 *
 * NOTE: cross-job orchestration lives in the runtime (JS), not in a durable
 * task, so whole-workflow crash-resume isn't covered yet (individual jobs/steps
 * ARE durable). Resume across a process restart is a later addition (persistent
 * dataDir + run id); see docs/phase-1.md.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, cp } from "node:fs/promises";
import type { TaskContext } from "absurd-sdk";
import { makeTarget } from "../../targets/index.ts";
import { createAbsurdEngine, type AbsurdEngine } from "./engine.ts";
import type { ExecutionPlan, PlannedJob } from "../../compiler/index.ts";
import type { JobResult, RunContext, Runtime, StepResult, WorkflowResult } from "../types.ts";

const QUEUE = "default";
const DEFAULT_MAX_CONCURRENCY = 16;

export interface AbsurdRuntimeOptions {
  /** PGLite data dir for persistence; omit for ephemeral in-memory. */
  dataDir?: string;
  /** Inject a shared engine (e.g. in tests) so it isn't booted/closed per run. */
  engine?: AbsurdEngine;
  /** Max jobs to execute concurrently (default min(jobs, 16)). */
  maxConcurrency?: number;
}

export class AbsurdRuntime implements Runtime {
  readonly kind = "absurd";
  private engine: AbsurdEngine | null;
  private readonly ownsEngine: boolean;
  private readonly dataDir: string | undefined;
  private readonly maxConcurrency: number | undefined;

  constructor(opts: AbsurdRuntimeOptions = {}) {
    this.engine = opts.engine ?? null;
    this.ownsEngine = opts.engine === undefined;
    this.dataDir = opts.dataDir;
    this.maxConcurrency = opts.maxConcurrency;
  }

  private async ensureEngine(): Promise<AbsurdEngine> {
    if (!this.engine) this.engine = await createAbsurdEngine({ dataDir: this.dataDir });
    return this.engine;
  }

  async run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult> {
    const { app } = await this.ensureEngine();
    const runId = randomUUID();

    // One durable task definition per run; each job is spawned as an instance of
    // it (params carry the job id). Unique name so a shared engine hosts many runs.
    const jobTaskName = `job:${plan.name}:${runId}`;
    app.registerTask(
      { name: jobTaskName, queue: QUEUE, defaultMaxAttempts: 1 },
      async (params: unknown, taskCtx: TaskContext) => {
        const jobId = (params as { jobId: string }).jobId;
        return runJobInTask(plan.jobs[jobId]!, ctx, taskCtx);
      },
    );

    const jobCount = Object.keys(plan.jobs).length;
    const concurrency = Math.max(1, this.maxConcurrency ?? Math.min(jobCount, DEFAULT_MAX_CONCURRENCY));
    const worker = await app.startWorker({ concurrency, batchSize: concurrency, claimTimeout: 600, pollInterval: 0.05 });

    try {
      // Walk the needs-DAG with memoized promises: each job awaits its deps, then
      // (if they all succeeded) spawns its task and awaits the result. Independent
      // jobs reach `spawn` concurrently and the worker runs them in parallel.
      const scheduled = new Map<string, Promise<JobResult>>();
      const schedule = (jobId: string): Promise<JobResult> => {
        const existing = scheduled.get(jobId);
        if (existing) return existing;
        const job = plan.jobs[jobId]!;
        const p = (async (): Promise<JobResult> => {
          const deps = await Promise.all(job.needs.map((d) => schedule(d)));
          if (deps.some((d) => d.status !== "success")) {
            return { id: jobId, status: "skipped", steps: [] };
          }
          const { taskID } = await app.spawn(
            jobTaskName,
            { jobId },
            { queue: QUEUE, idempotencyKey: `${runId}:${jobId}` },
          );
          const snap = await awaitTaskTerminal(app, taskID);
          if (snap.state === "completed") return snap.result as unknown as JobResult;
          return {
            id: jobId,
            status: "failure",
            steps: [
              {
                name: `${jobId}/error`,
                status: "failure",
                exitCode: 1,
                stdout: "",
                stderr: `job task did not complete: ${JSON.stringify("failure" in snap ? snap.failure : snap)}`,
              },
            ],
          };
        })();
        scheduled.set(jobId, p);
        return p;
      };

      // Stable output order = compiled topological order.
      const jobs = await Promise.all(plan.jobOrder.map((id) => schedule(id)));
      return {
        name: plan.name,
        status: jobs.some((j) => j.status === "failure") ? "failure" : "success",
        jobs,
      };
    } finally {
      await worker.close();
    }
  }

  /** Tear down the engine if this runtime owns it. */
  async close(): Promise<void> {
    if (this.ownsEngine && this.engine) {
      await this.engine.close();
      this.engine = null;
    }
  }
}

/** Poll a task's result until it reaches a terminal state. */
async function awaitTaskTerminal(app: AbsurdEngine["app"], taskID: string) {
  for (;;) {
    const snap = await app.fetchTaskResult(taskID);
    if (snap && (snap.state === "completed" || snap.state === "failed" || snap.state === "cancelled")) {
      return snap;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Run a single job's steps as durable checkpoints inside its Absurd task. */
async function runJobInTask(job: PlannedJob, ctx: RunContext, taskCtx: TaskContext): Promise<JobResult> {
  ctx.hooks?.onJobStart?.(job.id);
  const workdir = join(ctx.workRoot, job.id);

  // Stage the workflow's directory into this job's isolated workspace.
  await mkdir(workdir, { recursive: true });
  if (ctx.workspaceSource) {
    await cp(ctx.workspaceSource, workdir, { recursive: true });
  }

  // Provisioning can fail for environmental reasons (e.g. gondolin not
  // installed). Surface that as a failed step rather than crashing the task.
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
    const jobResult: JobResult = { id: job.id, status: "failure", steps: [result] };
    ctx.hooks?.onJobEnd?.(job.id, jobResult);
    return jobResult;
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

  const jobResult: JobResult = { id: job.id, status: failed ? "failure" : "success", steps };
  ctx.hooks?.onJobEnd?.(job.id, jobResult);
  return jobResult;
}
