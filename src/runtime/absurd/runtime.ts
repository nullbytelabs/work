/**
 * AbsurdRuntime — the engine's durable runtime (the only one).
 *
 * Each **job** is its own durable Absurd task; each `<job>/<step>` is a durable
 * `ctx.step(...)` checkpoint. The runtime walks the `needs` DAG (independent jobs
 * run in parallel via worker `concurrency`) and threads outputs between jobs:
 * a dependency's resolved `outputs` are passed to its dependents as the
 * `needs.<job>.outputs.*` context, and a step's `${{ steps.<id>.outputs.* }}` /
 * `${{ needs.* }}` expressions are resolved here at runtime (inputs were already
 * bound at compile time).
 *
 * Step kinds: `run` (shell on the ExecutionTarget) and `uses:` (dispatched to a
 * registered handler — work/agent, an action, …). Both are memoized checkpoints.
 *
 * Failure/skip: a job runs only if every `needs` dependency succeeded; otherwise
 * it's skipped. The workflow fails if any job failed.
 *
 * Resume: each job spawns with an idempotency key of `${runId}:${jobId}`, so
 * re-invoking `run()` with the same `runId` against a persistent journal reuses a
 * finished job's recorded result instead of recomputing it, and re-drives a job
 * that was *interrupted* (its target torn out mid-step — surfaced as a failed
 * task) via `retryTask`, fast-forwarding the `ctx.step` checkpoints it already
 * completed. A job that ran and *failed cleanly* (a step exited non-zero) is a
 * real terminal outcome and is never silently retried. The cross-job walk itself
 * is still plain JS (not yet a durable task) and there's no user-facing `--resume`
 * entrypoint or persistent-by-default storage — see docs/phase-1.md.
 */
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { mkdir, cp, readFile, rm } from "node:fs/promises";
import type { TaskContext } from "absurd-sdk";
import { makeTarget as defaultMakeTarget, type TargetFactory, type ExecutionTarget } from "../../targets/index.ts";
import {
  interpolate,
  evaluateCondition,
  ConditionError,
  type OutputBag,
  type ConditionContext,
  type ConditionBag,
} from "../../compiler/index.ts";
import { createAbsurdEngine, JOBS_QUEUE, type AbsurdEngine } from "./engine.ts";
import type { ExecutionPlan, PlannedJob, PlannedStep } from "../../compiler/index.ts";
import type { JobResult, RunContext, Runtime, StepResult, UsesHandler, WorkflowResult } from "../types.ts";
import { parseOutputFile } from "../output.ts";

/** The orchestrator task's queue. Job tasks run on a *separate* queue
 *  (`JOBS_QUEUE`) so the orchestrator can await them without starving them of
 *  worker slots — see docs/durable-orchestrator.md. */
const QUEUE = "default";
const DEFAULT_MAX_CONCURRENCY = 16;
/** How often the orchestrator task heartbeats its lease while awaiting jobs
 *  (well under the worker's claim timeout). Short runs finish before it ever
 *  fires; long ones keep their lease alive. */
const ORCH_HEARTBEAT_MS = 300_000;

/** Upstream job outputs + status passed to a job's task (JSON-serializable). */
type NeedsBag = OutputBag & { result?: JobResult["status"] };
type NeedsContext = Record<string, NeedsBag>;

/** Resolved workflow inputs threaded to the runtime for `if:` evaluation. */
type WorkflowInputs = Record<string, string | number | boolean>;

/**
 * Marks a step that was torn out *before it could produce a verdict* — the target
 * VM died, the host process was stopped — as opposed to a step that ran and
 * exited non-zero. The distinction is the resumability boundary: an interruption
 * **fails the job task** so a later invocation of the same run can resume it (via
 * `retryTask`, fast-forwarding the `ctx.step` checkpoints that did complete),
 * whereas a clean non-zero exit stays a recorded step failure — a real, terminal
 * outcome that resume must not silently retry.
 */
class JobInterrupted extends Error {
  readonly stepName: string;
  constructor(stepName: string, reason: unknown) {
    super(`job interrupted at step "${stepName}": ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "JobInterrupted";
    this.stepName = stepName;
  }
}

/** Convert a needs/steps output map into condition bags (outputs + result). */
function toConditionBags(
  src: Record<string, OutputBag & { result?: string }>,
): Record<string, ConditionBag> {
  const out: Record<string, ConditionBag> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = v.result !== undefined ? { outputs: v.outputs, result: v.result } : { outputs: v.outputs };
  }
  return out;
}

/** Mediated egress for a job's sandbox target (allowlist + header-only secrets). */
export interface JobNetwork {
  /** Outbound HTTP hosts the guest may reach (deny-by-default otherwise). */
  allowedHosts?: string[];
  /** Secrets injected into outbound headers host-side only; never seen in-guest. */
  secrets?: Record<string, { hosts: string[]; value: string }>;
}

export interface AbsurdRuntimeOptions {
  /** PGLite data dir for persistence; omit for ephemeral in-memory. */
  dataDir?: string;
  /** Inject a shared engine (e.g. in tests) so it isn't booted/closed per run. */
  engine?: AbsurdEngine;
  /** Max jobs to execute concurrently (default min(jobs, 16)). */
  maxConcurrency?: number;
  /** Handlers for `uses:` steps, keyed by scheme (e.g. an agent handler). The
   *  core is agent-agnostic; the composition root registers handlers. */
  usesHandlers?: UsesHandler[];
  /**
   * Per-job network policy for sandbox targets — the composition root computes
   * it (e.g. allowlist the model host + inject the API key for a job's agent
   * steps). The core stays agent-agnostic and just forwards it to the target.
   */
  resolveJobNetwork?: (job: PlannedJob) => JobNetwork | undefined;
  /**
   * Resolve a job's guest image from its `runs-on` — an image selector for a
   * `work:<image>` (built on first use), or `undefined` for the stock guest. The
   * composition root supplies it (it knows the workspace + builder); the core just
   * forwards a job-bound thunk to the target. Stays agent/image-agnostic.
   */
  resolveImagePath?: (runsOn: string) => Promise<string | undefined>;
  /**
   * Override how a job's `runs-on` becomes an ExecutionTarget. Defaults to the
   * production factory (gondolin micro-VM only). Tests inject a lightweight
   * host-process double so they exercise the runtime↔target contract without
   * booting a VM — the double is never reachable from a workflow.
   */
  makeTarget?: TargetFactory;
}

/** Side dependencies captured by the per-job task handler (not serialized). */
interface JobDeps {
  ctx: RunContext;
  usesHandlers: UsesHandler[];
  /** Resolved workflow inputs, for `if:` evaluation inside steps. */
  inputs: WorkflowInputs;
  /**
   * The webhook/dispatch payload, for `if: ${{ event.* }}` evaluation. Already
   * baked into `run`/`with`/`env` strings at compile time; threaded here so the
   * runtime-evaluated job/step conditions can read it too (parallel to `inputs`).
   */
  event?: Record<string, unknown>;
  /** Optional per-job sandbox network policy (allowlist + secrets). */
  resolveJobNetwork?: (job: PlannedJob) => JobNetwork | undefined;
  /** Optional resolver for a job's guest image (a `work:<image>` selector). */
  resolveImagePath?: (runsOn: string) => Promise<string | undefined>;
  /** Builds the ExecutionTarget for a job's `runs-on`. */
  makeTarget: TargetFactory;
}

export class AbsurdRuntime implements Runtime {
  readonly kind = "absurd";
  private engine: AbsurdEngine | null;
  private readonly ownsEngine: boolean;
  private readonly dataDir: string | undefined;
  private readonly maxConcurrency: number | undefined;
  private readonly usesHandlers: UsesHandler[];
  private readonly resolveJobNetwork: ((job: PlannedJob) => JobNetwork | undefined) | undefined;
  private readonly resolveImagePath: ((runsOn: string) => Promise<string | undefined>) | undefined;
  private readonly makeTarget: TargetFactory;

  constructor(opts: AbsurdRuntimeOptions = {}) {
    this.engine = opts.engine ?? null;
    this.ownsEngine = opts.engine === undefined;
    this.dataDir = opts.dataDir;
    this.maxConcurrency = opts.maxConcurrency;
    this.usesHandlers = opts.usesHandlers ?? [];
    this.resolveJobNetwork = opts.resolveJobNetwork;
    this.resolveImagePath = opts.resolveImagePath;
    this.makeTarget = opts.makeTarget ?? defaultMakeTarget;
  }

  private async ensureEngine(): Promise<AbsurdEngine> {
    if (!this.engine) this.engine = await createAbsurdEngine({ dataDir: this.dataDir });
    return this.engine;
  }

  async run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult> {
    const { app, jobsApp } = await this.ensureEngine();
    const runId = ctx.runId ?? randomUUID();
    const deps: JobDeps = {
      ctx,
      usesHandlers: this.usesHandlers,
      inputs: plan.inputs ?? {},
      makeTarget: this.makeTarget,
      ...(plan.event ? { event: plan.event } : {}),
      ...(this.resolveJobNetwork ? { resolveJobNetwork: this.resolveJobNetwork } : {}),
      ...(this.resolveImagePath ? { resolveImagePath: this.resolveImagePath } : {}),
    };

    const jobTaskName = `job:${plan.name}:${runId}`;
    const orchTaskName = `orch:${plan.name}:${runId}`;

    // Each job is a durable task on the JOBS queue.
    jobsApp.registerTask(
      { name: jobTaskName, queue: JOBS_QUEUE, defaultMaxAttempts: 1 },
      async (params: unknown, taskCtx: TaskContext) => {
        const p = params as { jobId: string; needs: NeedsContext };
        return runJobInTask(plan.jobs[p.jobId]!, deps, taskCtx, p.needs ?? {});
      },
    );

    // The whole workflow is a durable ORCHESTRATOR task: it walks the needs DAG,
    // spawning + awaiting job tasks (on the jobs queue, so it can't starve them of
    // slots) and threading outputs. Because it's a task, a crashed run self-resumes
    // when a worker re-claims it — the orchestration state lives in the journal, not
    // in this process's memory. It heartbeats its own lease while awaiting jobs.
    app.registerTask(
      { name: orchTaskName, queue: QUEUE, defaultMaxAttempts: 1 },
      async (_params: unknown, taskCtx: TaskContext) => {
        const beat = setInterval(() => void taskCtx.heartbeat().catch(() => {}), ORCH_HEARTBEAT_MS);
        beat.unref?.();
        try {
          return await runOrchestration({ plan, deps, jobsApp, runId, jobTaskName });
        } finally {
          clearInterval(beat);
        }
      },
    );

    const jobCount = Object.keys(plan.jobs).length;
    const concurrency = Math.max(1, this.maxConcurrency ?? Math.min(jobCount, DEFAULT_MAX_CONCURRENCY));
    // A worker on each queue — separate pools so an orchestrator awaiting jobs can
    // never deadlock the jobs it's waiting on.
    const jobsWorker = await jobsApp.startWorker({ concurrency, batchSize: concurrency, claimTimeout: 600, pollInterval: 0.05 });
    const orchWorker = await app.startWorker({ concurrency, batchSize: concurrency, claimTimeout: 600, pollInterval: 0.05 });

    try {
      // Spawn the orchestrator (idempotent on runId) and await its result — the
      // WorkflowResult. Resume: a pre-existing *failed* orchestrator (a run
      // interrupted mid-flight) is re-driven via retryTask, which re-walks the DAG,
      // reuses finished jobs, and re-drives the interrupted one. A *completed*
      // orchestrator (even one whose WorkflowResult is `failure` — a job that ran
      // and failed) is a real outcome, reused as-is.
      const spawned = await app.spawn(orchTaskName, {}, { queue: QUEUE, idempotencyKey: runId });
      let snap = await awaitTaskTerminal(app, spawned.taskID);
      if (!spawned.created && snap.state === "failed") {
        const retried = await app.retryTask(spawned.taskID, { spawnNewTask: false });
        snap = await awaitTaskTerminal(app, retried.taskID);
      }
      if (snap.state === "completed") return snap.result as unknown as WorkflowResult;
      // The orchestrator task failed — the run was interrupted (a job torn out) and
      // couldn't finish in this invocation. Report `interrupted` (not `failure`):
      // it's resumable, and re-running with the same runId picks it back up.
      return { name: plan.name, status: "interrupted", jobs: [] };
    } finally {
      await orchWorker.close();
      await jobsWorker.close();
    }
  }

  async close(): Promise<void> {
    if (this.ownsEngine && this.engine) {
      await this.engine.close();
      this.engine = null;
    }
  }
}

/** A failed-job result carrying a single synthetic error step (e.g. bad `if:`). */
function jobConditionError(jobId: string, message: string): JobResult {
  return {
    id: jobId,
    status: "failure",
    steps: [{ name: `${jobId}/error`, status: "failure", exitCode: 1, stdout: "", stderr: message }],
  };
}

async function awaitTaskTerminal(client: AbsurdEngine["app"], taskID: string) {
  for (;;) {
    const snap = await client.fetchTaskResult(taskID);
    if (snap && (snap.state === "completed" || snap.state === "failed" || snap.state === "cancelled")) {
      return snap;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * The DAG walk, run inside the orchestrator task. Independent jobs run in parallel
 * (each spawned as a job task and awaited concurrently); a job spawns the instant
 * its own deps resolve — fine-grained, no wave barrier. Awaits are raw polling (not
 * `ctx.step`), so the parallel awaits don't race on checkpoints; the durable state
 * lives in the job tasks, which the orchestrator re-derives by re-walking on a
 * re-claim. Returns the assembled WorkflowResult, but **throws** if any job task
 * ended `failed` (an interruption — its target was torn out), so the orchestrator
 * task itself fails and a re-spawn re-drives the run. A job that ran and exited
 * non-zero is a `completed` task with a failure result and is reported normally.
 */
async function runOrchestration(args: {
  plan: ExecutionPlan;
  deps: JobDeps;
  jobsApp: AbsurdEngine["jobsApp"];
  runId: string;
  jobTaskName: string;
}): Promise<WorkflowResult> {
  const { plan, deps, jobsApp, runId, jobTaskName } = args;
  const scheduled = new Map<string, Promise<JobResult>>();
  const schedule = (jobId: string): Promise<JobResult> => {
    const existing = scheduled.get(jobId);
    if (existing) return existing;
    const job = plan.jobs[jobId]!;
    const p = (async (): Promise<JobResult> => {
      const depResults = await Promise.all(job.needs.map((d) => schedule(d)));
      const depsAllSucceeded = depResults.every((d) => d.status === "success");
      const depsSomeFailed = depResults.some((d) => d.status === "failure");

      // Build the needs context from dependencies' resolved outputs + status.
      const needs: NeedsContext = {};
      for (const dep of depResults) needs[dep.id] = { outputs: dep.outputs ?? {}, result: dep.status };

      // Gate the job. With no `if`, a job runs only if every dependency succeeded
      // (the default). An `if:` takes over entirely — letting `always()`/`failure()`
      // run a job after an upstream failure.
      if (job.if !== undefined) {
        let run: boolean;
        try {
          run = evaluateCondition(job.if, {
            inputs: deps.inputs,
            needs: toConditionBags(needs),
            ...(deps.event ? { event: deps.event } : {}),
            ...(job.matrix ? { matrix: job.matrix } : {}),
            status: { success: depsAllSucceeded, failure: depsSomeFailed },
          });
        } catch (err) {
          if (err instanceof ConditionError) return jobConditionError(jobId, `job if: ${err.message}`);
          throw err;
        }
        if (!run) return { id: jobId, status: "skipped", steps: [] };
      } else if (!depsAllSucceeded) {
        return { id: jobId, status: "skipped", steps: [] };
      }

      // Idempotent on the run+job key: a job that already ran in an earlier
      // invocation (same runId) returns the existing task instead of a fresh one,
      // so a finished job's journaled result is reused, not recomputed.
      const spawned = await jobsApp.spawn(jobTaskName, { jobId, needs }, { queue: JOBS_QUEUE, idempotencyKey: `${runId}:${jobId}` });
      let snap = await awaitTaskTerminal(jobsApp, spawned.taskID);
      // Resume: a pre-existing *failed* job task was interrupted in an earlier
      // invocation — re-drive it (Absurd fast-forwards its completed step
      // checkpoints). A *completed* task (success, or a step that exited non-zero)
      // is a real outcome, reused as-is.
      if (!spawned.created && snap.state === "failed") {
        const retried = await jobsApp.retryTask(spawned.taskID, { spawnNewTask: false });
        snap = await awaitTaskTerminal(jobsApp, retried.taskID);
      }
      if (snap.state === "completed") return snap.result as unknown as JobResult;
      // A `failed` job task = an interruption. Propagate so the orchestrator task
      // fails and a re-spawn re-drives the whole run.
      throw new JobInterrupted(jobId, "failure" in snap ? snap.failure : snap);
    })();
    scheduled.set(jobId, p);
    return p;
  };

  const jobs = await Promise.all(plan.jobOrder.map((id) => schedule(id)));
  return { name: plan.name, status: jobs.some((j) => j.status === "failure") ? "failure" : "success", jobs };
}

/** Expression context shape threaded to the step runners (needs + step outputs). */
type StepExprCtx = { needs: NeedsContext; steps: Record<string, OutputBag> };

/**
 * Stage the job's checkout into `workdir` like a fresh `git checkout`: never carry
 * a foreign `node_modules` (a job installs its own — copying one across platforms
 * breaks native deps) or `.git`. Keeps staging fast and reproducible.
 */
async function stageWorkspace(ctx: RunContext, workdir: string): Promise<void> {
  await mkdir(workdir, { recursive: true });
  if (!ctx.workspaceSource) return;
  await cp(ctx.workspaceSource, workdir, {
    recursive: true,
    filter: (src) => {
      const b = basename(src);
      return b !== "node_modules" && b !== ".git";
    },
  });
}

/**
 * Build + provision the job's target. On success returns the target; on failure
 * returns the synthetic `provision` step result so the caller can report it.
 */
async function provisionTarget(
  job: PlannedJob,
  deps: JobDeps,
  workdir: string,
): Promise<{ target: ExecutionTarget } | { failure: StepResult }> {
  try {
    // A sandbox target may need mediated egress (e.g. an in-guest agent reaching
    // the model API). The composition root supplies this per job; the core stays
    // agent-agnostic — it just forwards the allowlist/secrets to the target.
    const network = deps.resolveJobNetwork?.(job);
    // Bind the image resolver to this job's `runs-on` — the target awaits it at
    // provision time (a `work:<image>` builds on first use; stock → undefined).
    const resolveImagePath = deps.resolveImagePath
      ? () => deps.resolveImagePath!(job.runsOn)
      : undefined;
    const target = deps.makeTarget(job.runsOn, {
      workdir,
      machine: job.machine,
      ...(network ?? {}),
      ...(resolveImagePath ? { resolveImagePath } : {}),
    });
    await target.provision();
    return { target };
  } catch (err) {
    return {
      failure: { name: `${job.id}/provision`, status: "failure", exitCode: 1, stdout: "", stderr: (err as Error).message },
    };
  }
}

/** Whether (and how) a step runs: with no `if`, it runs while the job is healthy;
 *  an `if:` takes over (so `always()`/`failure()` can run after a failure). A
 *  malformed `if:` is itself a step failure. */
type StepDecision = { kind: "run" | "skip" } | { kind: "error"; result: StepResult };

function decideStep(step: PlannedStep, condCtx: ConditionContext, failed: boolean): StepDecision {
  if (step.if === undefined) return { kind: failed ? "skip" : "run" };
  try {
    return { kind: evaluateCondition(step.if, condCtx) ? "run" : "skip" };
  } catch (err) {
    if (!(err instanceof ConditionError)) throw err;
    return { kind: "error", result: { name: step.name, status: "failure", exitCode: 1, stdout: "", stderr: `if: ${err.message}` } };
  }
}

/** Run one step as a durable checkpoint, dispatching `uses:` vs `run:`. */
function executeStep(
  step: PlannedStep,
  job: PlannedJob,
  target: ExecutionTarget,
  workdir: string,
  deps: JobDeps,
  taskCtx: TaskContext,
  expr: StepExprCtx,
): Promise<StepResult> {
  return taskCtx.step<StepResult>(step.name, async () => {
    if (step.uses !== undefined) return runUsesStep(step, job, target, workdir, deps, expr);
    return runShellStep(step, job, target, workdir, deps.ctx, expr);
  });
}

/** Outcome of running a job's steps: the results, their captured outputs, and
 *  whether anything failed (used to gate job-output resolution). */
interface StepsOutcome {
  steps: StepResult[];
  stepOutputs: Record<string, OutputBag & { result?: string }>;
  failed: boolean;
}

/** Run a job's steps in order on the provisioned target, applying `if:`/skip
 *  gating and capturing per-step outputs. Disposes the target when done. */
async function runSteps(
  job: PlannedJob,
  deps: JobDeps,
  target: ExecutionTarget,
  workdir: string,
  taskCtx: TaskContext,
  needs: NeedsContext,
): Promise<StepsOutcome> {
  const { ctx } = deps;
  const steps: StepResult[] = [];
  // by step id, for steps.<id>.outputs / steps.<id>.result
  const stepOutputs: Record<string, OutputBag & { result?: string }> = {};
  let failed = false;

  const exprCtx = (): StepExprCtx => ({ needs, steps: stepOutputs });

  /** Build the condition context as of "now" (current failed-state + outputs). */
  const condCtx = (): ConditionContext => ({
    inputs: deps.inputs,
    needs: toConditionBags(needs),
    steps: toConditionBags(stepOutputs),
    ...(deps.event ? { event: deps.event } : {}),
    ...(job.matrix ? { matrix: job.matrix } : {}),
    status: { success: !failed, failure: failed },
  });

  /** Record a step's result: capture outputs/result for `id`ed steps, mark the job failed. */
  const recordStep = (step: PlannedStep, result: StepResult): void => {
    if (step.id) stepOutputs[step.id] = { outputs: result.outputs ?? {}, result: result.status };
    steps.push(result);
    if (result.status === "failure") failed = true;
  };

  try {
    for (const step of job.steps) {
      const decision = decideStep(step, condCtx(), failed);
      if (decision.kind === "error") {
        ctx.hooks?.onStepStart?.(job.id, step.name);
        ctx.hooks?.onStepEnd?.(job.id, decision.result);
        recordStep(step, decision.result);
        continue;
      }
      if (decision.kind === "skip") {
        recordStep(step, { name: step.name, status: "skipped", exitCode: 0, stdout: "", stderr: "" });
        continue;
      }

      ctx.hooks?.onStepStart?.(job.id, step.name);
      // A throw from executeStep means the step never reached a verdict — the
      // target/VM was torn out under it. Surface it to the presenter (so the step
      // isn't left "running"), then raise `JobInterrupted` so the job *task* fails
      // and a later invocation can resume from here. This is distinct from a step
      // that runs and exits non-zero (a normal failure StepResult below).
      let result: StepResult;
      try {
        result = await executeStep(step, job, target, workdir, deps, taskCtx, exprCtx());
      } catch (err) {
        const interrupted: StepResult = { name: step.name, status: "failure", exitCode: 1, stdout: "", stderr: `step interrupted: ${(err as Error).message}` };
        ctx.hooks?.onStepEnd?.(job.id, interrupted);
        recordStep(step, interrupted);
        throw new JobInterrupted(step.name, err);
      }
      ctx.hooks?.onStepEnd?.(job.id, result);
      recordStep(step, result);
    }
  } finally {
    await target.dispose();
  }

  return { steps, stepOutputs, failed };
}

async function runJobInTask(
  job: PlannedJob,
  deps: JobDeps,
  taskCtx: TaskContext,
  needs: NeedsContext,
): Promise<JobResult> {
  const { ctx } = deps;
  ctx.hooks?.onJobStart?.(job.id);

  // Anything after onJobStart that throws (staging, an output interpolation, an
  // unexpected target/handler error) must still fire onJobEnd — otherwise the
  // job task fails up top but the presenter is left showing it stuck "running".
  try {
    const workdir = join(ctx.workRoot, job.id);

    await stageWorkspace(ctx, workdir);

    const prov = await provisionTarget(job, deps, workdir);
    if ("failure" in prov) {
      ctx.hooks?.onStepEnd?.(job.id, prov.failure);
      const jobResult: JobResult = { id: job.id, status: "failure", steps: [prov.failure] };
      ctx.hooks?.onJobEnd?.(job.id, jobResult);
      return jobResult;
    }

    const { steps, stepOutputs, failed } = await runSteps(job, deps, prov.target, workdir, taskCtx, needs);

    // Resolve job outputs from collected step outputs (and needs).
    let outputs: Record<string, string> | undefined;
    if (job.outputs && !failed) {
      outputs = {};
      for (const [k, expr] of Object.entries(job.outputs)) {
        outputs[k] = interpolate(expr, { needs, steps: stepOutputs });
      }
    }

    const jobResult: JobResult = { id: job.id, status: failed ? "failure" : "success", steps };
    if (outputs) jobResult.outputs = outputs;
    ctx.hooks?.onJobEnd?.(job.id, jobResult);
    return jobResult;
  } catch (err) {
    const interrupted = err instanceof JobInterrupted;
    const jobResult: JobResult = {
      id: job.id,
      status: "failure",
      steps: [{ name: `${job.id}/error`, status: "failure", exitCode: 1, stdout: "", stderr: interrupted ? (err as JobInterrupted).message : `job crashed: ${(err as Error).message}` }],
    };
    ctx.hooks?.onJobEnd?.(job.id, jobResult);
    // An interruption fails the *task* (re-thrown) so the run can resume it later;
    // any other unexpected error stays an in-task terminal failure.
    if (interrupted) throw err;
    return jobResult;
  }
}

/**
 * A shell `run` step on the ExecutionTarget; captures `$WORK_OUTPUT`.
 *
 * The output file lives in the staged job workspace, which the target shares
 * with the host (the `/workspace` mount for the gondolin guest; the workdir
 * directly for a test host double). So `$WORK_OUTPUT` points at the path *the
 * command sees* (`target.workspacePath`) while the host reads the same file back
 * from `workdir` — making output capture work uniformly across targets.
 */
async function runShellStep(
  step: PlannedStep,
  job: PlannedJob,
  target: ExecutionTarget,
  workdir: string,
  ctx: RunContext,
  expr: { needs: NeedsContext; steps: Record<string, OutputBag> },
): Promise<StepResult> {
  const command = interpolate(step.run!, expr);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env)) env[k] = interpolate(v, expr);

  const outName = `.work-output-${step.name.replace(/[^\w-]/g, "_")}`;
  const hostOutFile = join(workdir, outName); // host reads here
  env["WORK_OUTPUT"] = `${target.workspacePath}/${outName}`; // the command writes here
  await rm(hostOutFile, { force: true });

  const run = await target.run(command, {
    env,
    onOutput: (chunk) => ctx.hooks?.onOutput?.(job.id, step.name, chunk),
  });

  const result: StepResult = {
    name: step.name,
    status: run.ok ? "success" : "failure",
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
  };
  if (run.ok) {
    const text = await readFile(hostOutFile, "utf-8").catch(() => "");
    if (text) result.outputs = parseOutputFile(text);
  }
  return result;
}

/**
 * A `uses:` step — dispatch to the registered handler for its scheme. The core
 * resolves expressions in `with` (needs/steps) but knows nothing about what the
 * handler does (agents, etc. are composed in from outside).
 *
 * The handler receives an `exec` bound to the job's target, so a `uses:` step
 * runs **where the job runs** (inside the gondolin guest VM) — the same
 * isolation a `run:` step gets. Output capture / staging uses the shared
 * `target.workspacePath`, exactly like `runShellStep`.
 */
async function runUsesStep(
  step: PlannedStep,
  job: PlannedJob,
  target: ExecutionTarget,
  workdir: string,
  deps: JobDeps,
  expr: { needs: NeedsContext; steps: Record<string, OutputBag> },
): Promise<StepResult> {
  const emit = (chunk: { stream: "stdout" | "stderr"; text: string }) =>
    deps.ctx.hooks?.onOutput?.(job.id, step.name, chunk);
  const fail = (message: string): StepResult => {
    emit({ stream: "stderr", text: message });
    return { name: step.name, status: "failure", exitCode: 1, stdout: "", stderr: message };
  };

  const uses = step.uses!;
  const scheme = uses.split("/", 1)[0]!;
  const handler = deps.usesHandlers.find((h) => h.scheme === scheme);
  if (!handler) {
    return fail(`no handler registered for uses: "${uses}" (scheme "${scheme}")`);
  }

  // Resolve ${{ needs.* }} / ${{ steps.* }} in string `with` values; the handler
  // receives concrete values and never touches the expression engine.
  const resolvedWith: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.with ?? {})) {
    resolvedWith[k] = typeof v === "string" ? interpolate(v, expr) : v;
  }

  try {
    const workflowDir = deps.ctx.workflowDir ?? deps.ctx.workspaceSource;
    const res = await handler.run({
      uses,
      with: resolvedWith,
      workdir,
      ...(deps.ctx.workspaceSource ? { projectDir: deps.ctx.workspaceSource } : {}),
      ...(workflowDir ? { workflowDir } : {}),
      runsOn: job.runsOn,
      sandboxed: true, // every job runs in the gondolin sandbox — there is no host execution
      workspacePath: target.workspacePath,
      exec: (command, opts) => target.run(command, opts ?? {}),
      emit,
    });
    return {
      name: step.name,
      status: res.status,
      exitCode: res.status === "success" ? 0 : 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      ...(res.outputs ? { outputs: res.outputs } : {}),
    };
  } catch (err) {
    // Handlers shouldn't throw, but never let one crash the job task.
    return fail(`uses handler "${scheme}" threw: ${(err as Error).message}`);
  }
}
