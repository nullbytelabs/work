/**
 * DirectRuntime — Phase 1 in-process runner.
 *
 * Walks the plan's `jobOrder`, provisions an ExecutionTarget per job, and runs
 * steps sequentially. No persistence or crash recovery — that is exactly the
 * boundary the Absurd runtime fills in Phase 2. The control flow here is
 * deliberately written the way the durable version will be (resolve order ->
 * per-job target -> step-by-step), so the upgrade is a substitution, not a
 * rewrite.
 *
 * Semantics chosen to match GitHub Actions:
 *  - a failing step fails its job and skips the remaining steps in that job
 *  - a failed job marks the workflow failed and skips not-yet-run jobs
 *    (Phase 2 will refine this to only skip the failed job's dependents)
 */
import { join } from "node:path";
import { makeTarget } from "../targets/index.ts";
import type { ExecutionPlan, PlannedJob } from "../compiler/index.ts";
import type { JobResult, RunContext, Runtime, StepResult, WorkflowResult } from "./types.ts";

export class DirectRuntime implements Runtime {
  readonly kind = "direct";

  async run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult> {
    const jobs: JobResult[] = [];
    let aborted = false;

    for (const jobId of plan.jobOrder) {
      const job = plan.jobs[jobId]!;
      if (aborted) {
        jobs.push({ id: jobId, status: "skipped", steps: [] });
        continue;
      }
      const result = await this.runJob(job, ctx);
      jobs.push(result);
      if (result.status === "failure") aborted = true;
    }

    return {
      name: plan.name,
      status: jobs.some((j) => j.status === "failure") ? "failure" : "success",
      jobs,
    };
  }

  private async runJob(job: PlannedJob, ctx: RunContext): Promise<JobResult> {
    ctx.hooks?.onJobStart?.(job.id);
    const workdir = join(ctx.workRoot, job.id);
    const target = makeTarget(job.runsOn, { workdir });
    const steps: StepResult[] = [];
    let failed = false;

    try {
      await target.provision();

      for (const step of job.steps) {
        if (failed) {
          steps.push({ name: step.name, status: "skipped", exitCode: 0, stdout: "", stderr: "" });
          continue;
        }

        // Phase 1 supports `run` steps only. `uses` (agentic) steps arrive with Pi in Phase 2.
        if (step.run === undefined) {
          const result: StepResult = {
            name: step.name,
            status: "failure",
            exitCode: 1,
            stdout: "",
            stderr: `step "${step.name}" uses "${step.uses}" — "uses" steps are not supported in Phase 1`,
          };
          ctx.hooks?.onStepStart?.(job.id, step.name);
          ctx.hooks?.onStepEnd?.(job.id, result);
          steps.push(result);
          failed = true;
          continue;
        }

        ctx.hooks?.onStepStart?.(job.id, step.name);
        const run = await target.run(step.run, {
          env: step.env,
          onOutput: (chunk) => ctx.hooks?.onOutput?.(job.id, step.name, chunk),
        });
        const result: StepResult = {
          name: step.name,
          status: run.ok ? "success" : "failure",
          exitCode: run.exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
        };
        ctx.hooks?.onStepEnd?.(job.id, result);
        steps.push(result);
        if (!run.ok) failed = true;
      }
    } finally {
      await target.dispose();
    }

    return { id: job.id, status: failed ? "failure" : "success", steps };
  }
}
