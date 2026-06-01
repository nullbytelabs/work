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
 * Step kinds: `run` (shell on the ExecutionTarget) and `uses: agent/<name>`
 * (an LLM call via the injected AgentRunner). Both are memoized checkpoints.
 *
 * Failure/skip: a job runs only if every `needs` dependency succeeded; otherwise
 * it's skipped. The workflow fails if any job failed.
 *
 * NOTE: cross-job orchestration lives in the runtime (JS), not a durable task,
 * so whole-workflow crash-resume isn't covered yet. See docs/phase-1.md.
 */
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { mkdir, cp, readFile, rm } from "node:fs/promises";
import type { TaskContext } from "absurd-sdk";
import { makeTarget } from "../../targets/index.ts";
import {
  interpolate,
  evaluateCondition,
  ConditionError,
  type OutputBag,
  type ConditionContext,
  type ConditionBag,
} from "../../compiler/index.ts";
import { createAbsurdEngine, type AbsurdEngine } from "./engine.ts";
import type { ExecutionPlan, PlannedJob, PlannedStep } from "../../compiler/index.ts";
import type { JobResult, RunContext, Runtime, StepResult, UsesHandler, WorkflowResult } from "../types.ts";

const QUEUE = "default";
const DEFAULT_MAX_CONCURRENCY = 16;

/** Upstream job outputs + status passed to a job's task (JSON-serializable). */
type NeedsBag = OutputBag & { result?: JobResult["status"] };
type NeedsContext = Record<string, NeedsBag>;

/** Resolved workflow inputs threaded to the runtime for `if:` evaluation. */
type WorkflowInputs = Record<string, string | number | boolean>;

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
}

/** Side dependencies captured by the per-job task handler (not serialized). */
interface JobDeps {
  ctx: RunContext;
  usesHandlers: UsesHandler[];
  /** Resolved workflow inputs, for `if:` evaluation inside steps. */
  inputs: WorkflowInputs;
}

export class AbsurdRuntime implements Runtime {
  readonly kind = "absurd";
  private engine: AbsurdEngine | null;
  private readonly ownsEngine: boolean;
  private readonly dataDir: string | undefined;
  private readonly maxConcurrency: number | undefined;
  private readonly usesHandlers: UsesHandler[];

  constructor(opts: AbsurdRuntimeOptions = {}) {
    this.engine = opts.engine ?? null;
    this.ownsEngine = opts.engine === undefined;
    this.dataDir = opts.dataDir;
    this.maxConcurrency = opts.maxConcurrency;
    this.usesHandlers = opts.usesHandlers ?? [];
  }

  private async ensureEngine(): Promise<AbsurdEngine> {
    if (!this.engine) this.engine = await createAbsurdEngine({ dataDir: this.dataDir });
    return this.engine;
  }

  async run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult> {
    const { app } = await this.ensureEngine();
    const runId = randomUUID();
    const deps: JobDeps = { ctx, usesHandlers: this.usesHandlers, inputs: plan.inputs ?? {} };

    const jobTaskName = `job:${plan.name}:${runId}`;
    app.registerTask(
      { name: jobTaskName, queue: QUEUE, defaultMaxAttempts: 1 },
      async (params: unknown, taskCtx: TaskContext) => {
        const p = params as { jobId: string; needs: NeedsContext };
        return runJobInTask(plan.jobs[p.jobId]!, deps, taskCtx, p.needs ?? {});
      },
    );

    const jobCount = Object.keys(plan.jobs).length;
    const concurrency = Math.max(1, this.maxConcurrency ?? Math.min(jobCount, DEFAULT_MAX_CONCURRENCY));
    const worker = await app.startWorker({ concurrency, batchSize: concurrency, claimTimeout: 600, pollInterval: 0.05 });

    try {
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

          // Gate the job. With no `if`, a job runs only if every dependency
          // succeeded (the default). An `if:` takes over entirely — letting
          // `always()` / `failure()` run a job after an upstream failure.
          if (job.if !== undefined) {
            let run: boolean;
            try {
              run = evaluateCondition(job.if, {
                inputs: deps.inputs,
                needs: toConditionBags(needs),
                ...(job.matrix ? { matrix: job.matrix } : {}),
                status: { success: depsAllSucceeded, failure: depsSomeFailed },
              });
            } catch (err) {
              if (err instanceof ConditionError) {
                return jobConditionError(jobId, `job if: ${err.message}`);
              }
              throw err;
            }
            if (!run) return { id: jobId, status: "skipped", steps: [] };
          } else if (!depsAllSucceeded) {
            return { id: jobId, status: "skipped", steps: [] };
          }

          const { taskID } = await app.spawn(
            jobTaskName,
            { jobId, needs },
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

async function awaitTaskTerminal(app: AbsurdEngine["app"], taskID: string) {
  for (;;) {
    const snap = await app.fetchTaskResult(taskID);
    if (snap && (snap.state === "completed" || snap.state === "failed" || snap.state === "cancelled")) {
      return snap;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Parse a step's $PI_OUTPUT file (GitHub-Actions `$GITHUB_OUTPUT` semantics):
 *   - `key=value` for single-line values, and
 *   - a heredoc block for multi-line values:
 *         key<<DELIMITER
 *         line 1
 *         line 2
 *         DELIMITER
 *     (everything up to the line that exactly equals DELIMITER is the value).
 * A later write to the same key wins.
 */
function parseOutputFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heredoc = /^([A-Za-z_][\w-]*)<<(\S+)\s*$/.exec(line);
    if (heredoc) {
      const [, key, delimiter] = heredoc as unknown as [string, string, string];
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) body.push(lines[i++]!);
      out[key] = body.join("\n");
      continue; // i sits on the delimiter line; the for-loop's i++ steps past it
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

async function runJobInTask(
  job: PlannedJob,
  deps: JobDeps,
  taskCtx: TaskContext,
  needs: NeedsContext,
): Promise<JobResult> {
  const { ctx } = deps;
  ctx.hooks?.onJobStart?.(job.id);
  const workdir = join(ctx.workRoot, job.id);

  await mkdir(workdir, { recursive: true });
  if (ctx.workspaceSource) {
    // Stage the checkout like a fresh `git checkout`: never carry a foreign
    // `node_modules` (a job installs its own — copying one across platforms
    // breaks native deps) or `.git`. Keeps staging fast and reproducible.
    await cp(ctx.workspaceSource, workdir, {
      recursive: true,
      filter: (src) => {
        const b = basename(src);
        return b !== "node_modules" && b !== ".git";
      },
    });
  }

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
  // by step id, for steps.<id>.outputs / steps.<id>.result
  const stepOutputs: Record<string, OutputBag & { result?: string }> = {};
  let failed = false;

  const exprCtx = () => ({ needs, steps: stepOutputs });

  /** Build the condition context as of "now" (current failed-state + outputs). */
  const condCtx = (): ConditionContext => ({
    inputs: deps.inputs,
    needs: toConditionBags(needs),
    steps: toConditionBags(stepOutputs),
    ...(job.matrix ? { matrix: job.matrix } : {}),
    status: { success: !failed, failure: failed },
  });

  try {
    for (const step of job.steps) {
      // Decide whether this step runs. With no `if`, a step runs only while the
      // job is still healthy (skip once something failed). An `if:` takes over:
      // `always()` / `failure()` let a step run after an earlier failure.
      let shouldRun: boolean;
      if (step.if !== undefined) {
        try {
          shouldRun = evaluateCondition(step.if, condCtx());
        } catch (err) {
          if (!(err instanceof ConditionError)) throw err;
          const result: StepResult = {
            name: step.name,
            status: "failure",
            exitCode: 1,
            stdout: "",
            stderr: `if: ${err.message}`,
          };
          ctx.hooks?.onStepStart?.(job.id, step.name);
          ctx.hooks?.onStepEnd?.(job.id, result);
          steps.push(result);
          if (step.id) stepOutputs[step.id] = { outputs: {}, result: "failure" };
          failed = true;
          continue;
        }
      } else {
        shouldRun = !failed;
      }

      if (!shouldRun) {
        steps.push({ name: step.name, status: "skipped", exitCode: 0, stdout: "", stderr: "" });
        if (step.id) stepOutputs[step.id] = { outputs: {}, result: "skipped" };
        continue;
      }

      ctx.hooks?.onStepStart?.(job.id, step.name);

      const result = await taskCtx.step<StepResult>(step.name, async () => {
        if (step.uses !== undefined) {
          return runUsesStep(step, job, workdir, deps, exprCtx());
        }
        return runShellStep(step, job, target!, workdir, ctx, exprCtx());
      });

      // Capture declared outputs + result for steps with an id.
      if (step.id) stepOutputs[step.id] = { outputs: result.outputs ?? {}, result: result.status };
      ctx.hooks?.onStepEnd?.(job.id, result);
      steps.push(result);
      if (result.status === "failure") failed = true;
    }
  } finally {
    await target.dispose();
  }

  // Resolve job outputs from collected step outputs (and needs).
  let outputs: Record<string, string> | undefined;
  if (job.outputs && !failed) {
    outputs = {};
    for (const [k, expr] of Object.entries(job.outputs)) {
      outputs[k] = interpolate(expr, exprCtx());
    }
  }

  const jobResult: JobResult = { id: job.id, status: failed ? "failure" : "success", steps };
  if (outputs) jobResult.outputs = outputs;
  ctx.hooks?.onJobEnd?.(job.id, jobResult);
  return jobResult;
}

/**
 * A shell `run` step on the ExecutionTarget; captures `$PI_OUTPUT`.
 *
 * The output file lives in the staged job workspace, which every target shares
 * with the host (the host workdir itself for `local`; the `/workspace` mount for
 * `gondolin`). So `$PI_OUTPUT` points at the path *the command sees*
 * (`target.workspacePath`) while the host reads the same file back from
 * `workdir` — making output capture work uniformly across targets.
 */
async function runShellStep(
  step: PlannedStep,
  job: PlannedJob,
  target: NonNullable<Awaited<ReturnType<typeof makeTarget>>>,
  workdir: string,
  ctx: RunContext,
  expr: { needs: NeedsContext; steps: Record<string, OutputBag> },
): Promise<StepResult> {
  const command = interpolate(step.run!, expr);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env)) env[k] = interpolate(v, expr);

  const outName = `.pi-output-${step.name.replace(/[^\w-]/g, "_")}`;
  const hostOutFile = join(workdir, outName); // host reads here
  env["PI_OUTPUT"] = `${target.workspacePath}/${outName}`; // the command writes here
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
 */
async function runUsesStep(
  step: PlannedStep,
  job: PlannedJob,
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
