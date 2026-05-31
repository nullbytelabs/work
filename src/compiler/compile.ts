/**
 * spec -> ExecutionPlan.
 *
 * Responsibilities (all runtime-agnostic):
 *  - layer env (workflow <- job <- step)
 *  - apply the default `runs-on`
 *  - assign stable, unique step names
 *  - compute a deterministic topological job order from `needs`, detecting cycles
 */
import type { JobSpec, StepSpec, WorkflowSpec } from "../spec/index.ts";
import type { ExecutionPlan, PlannedJob, PlannedStep } from "./plan.ts";

export class WorkflowCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCompileError";
  }
}

// Imported after the error class so the (function-level) circular references
// with inputs.ts / expr.ts are resolved by the time these are called.
import { resolveInputs, type ResolvedInputs } from "./inputs.ts";
import { interpolate } from "./expr.ts";

/** Options for compiling a workflow. */
export interface CompileOptions {
  /** Raw input values (e.g. parsed from `--inputs '<json>'`), validated against the spec. */
  inputs?: Record<string, unknown>;
}

/**
 * Default execution target. The README treats `gondolin` as the eventual
 * default, but Phase 1 only ships LocalTarget, so we default to "local" here.
 * Phase 2 can flip this once GondolinTarget is wired in.
 */
export const DEFAULT_RUNS_ON = "local";

function mergeEnv(...layers: (Record<string, string> | undefined)[]): Record<string, string> {
  return Object.assign({}, ...layers.filter(Boolean));
}

function compileStep(
  step: StepSpec,
  jobId: string,
  index: number,
  baseEnv: Record<string, string>,
  inputs: ResolvedInputs,
): PlannedStep {
  const stepKey = step.id ?? String(index);
  // Resolve ${{ inputs.x }} now; leave ${{ needs.* }} / ${{ steps.* }} for runtime.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(mergeEnv(baseEnv, step.env))) {
    env[k] = interpolate(v, { inputs });
  }
  const planned: PlannedStep = { name: `${jobId}/${stepKey}`, env };
  if (step.id !== undefined) planned.id = step.id;
  if (step.run !== undefined) planned.run = interpolate(step.run, { inputs });
  if (step.uses !== undefined) planned.uses = step.uses;
  if (step.with !== undefined) {
    // Interpolate string `with` values now (inputs); defer needs/steps.
    const w: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.with)) {
      w[k] = typeof v === "string" ? interpolate(v, { inputs }) : v;
    }
    planned.with = w;
  }
  if (step.if !== undefined) planned.if = step.if;
  return planned;
}

function compileJob(
  jobId: string,
  job: JobSpec,
  workflowEnv: Record<string, string>,
  inputs: ResolvedInputs,
): PlannedJob {
  const jobEnv = mergeEnv(workflowEnv, job.env);
  const planned: PlannedJob = {
    id: jobId,
    runsOn: job.runsOn ?? DEFAULT_RUNS_ON,
    needs: job.needs ?? [],
    steps: job.steps.map((s, i) => compileStep(s, jobId, i, jobEnv, inputs)),
  };
  if (job.outputs !== undefined) {
    // Job output expressions resolve at runtime (steps.*/needs.*); resolve any
    // inputs.* now, defer the rest.
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(job.outputs)) {
      outputs[k] = interpolate(v, { inputs });
    }
    planned.outputs = outputs;
  }
  return planned;
}

/**
 * Kahn's algorithm with deterministic tie-breaking (alphabetical) so the same
 * spec always produces the same order — important for a durable runtime where
 * orchestration must be replay-stable.
 */
function topoSort(jobs: Record<string, PlannedJob>): string[] {
  const ids = Object.keys(jobs).sort();
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const id of ids) {
    for (const dep of jobs[id]!.needs) {
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      dependents.get(dep)!.push(id);
    }
  }

  const ready = ids.filter((id) => (indegree.get(id) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id)!.sort()) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  if (order.length !== ids.length) {
    const unresolved = ids.filter((id) => !order.includes(id));
    throw new WorkflowCompileError(`cycle detected in job dependencies among: ${unresolved.join(", ")}`);
  }
  return order;
}

/** Compile a validated spec into an execution plan, binding any provided inputs. */
export function compile(spec: WorkflowSpec, opts: CompileOptions = {}): ExecutionPlan {
  const inputs = resolveInputs(spec.inputs, opts.inputs ?? {});
  const workflowEnv = spec.env ?? {};
  const jobs: Record<string, PlannedJob> = {};
  for (const [jobId, job] of Object.entries(spec.jobs)) {
    jobs[jobId] = compileJob(jobId, job, workflowEnv, inputs);
  }
  return { name: spec.name, jobs, jobOrder: topoSort(jobs) };
}
