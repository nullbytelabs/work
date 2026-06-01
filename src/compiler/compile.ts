/**
 * spec -> ExecutionPlan.
 *
 * Responsibilities (all runtime-agnostic):
 *  - layer env (workflow <- job <- step)
 *  - apply the default `runs-on`
 *  - assign stable, unique step names
 *  - expand `strategy.matrix` into one independent job per cell
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
import { expandMatrix, cellId, cellLabel, type MatrixCell } from "./matrix.ts";

/** Options for compiling a workflow. */
export interface CompileOptions {
  /** Raw input values (e.g. parsed from `--inputs '<json>'`), validated against the spec. */
  inputs?: Record<string, unknown>;
}

export const DEFAULT_RUNS_ON = "gondolin";

function mergeEnv(...layers: (Record<string, string> | undefined)[]): Record<string, string> {
  return Object.assign({}, ...layers.filter(Boolean));
}

function compileStep(
  step: StepSpec,
  jobId: string,
  index: number,
  baseEnv: Record<string, string>,
  inputs: ResolvedInputs,
  matrix: MatrixCell | undefined,
): PlannedStep {
  const stepKey = step.id ?? String(index);
  // Resolve ${{ inputs.x }} / ${{ matrix.x }} now; leave ${{ needs.* }} / ${{ steps.* }} for runtime.
  const ictx = { inputs, ...(matrix ? { matrix } : {}) };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(mergeEnv(baseEnv, step.env))) {
    env[k] = interpolate(v, ictx);
  }
  const planned: PlannedStep = { name: `${jobId}/${stepKey}`, env };
  if (step.name !== undefined) planned.title = step.name;
  if (step.id !== undefined) planned.id = step.id;
  if (step.run !== undefined) planned.run = interpolate(step.run, ictx);
  if (step.uses !== undefined) planned.uses = step.uses;
  if (step.with !== undefined) {
    // Interpolate string `with` values now (inputs/matrix); defer needs/steps.
    const w: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.with)) {
      w[k] = typeof v === "string" ? interpolate(v, ictx) : v;
    }
    planned.with = w;
  }
  if (step.if !== undefined) planned.if = step.if;
  return planned;
}

/**
 * Compile a single job *leg* (a non-matrix job is its sole leg). `legId`/`title`
 * and the resolved `matrix` cell are supplied by the caller; `needs` are already
 * expanded to concrete leg ids.
 */
function compileLeg(
  legId: string,
  title: string | undefined,
  job: JobSpec,
  needs: string[],
  workflowEnv: Record<string, string>,
  inputs: ResolvedInputs,
  matrix: MatrixCell | undefined,
): PlannedJob {
  const jobEnv = mergeEnv(workflowEnv, job.env);
  const planned: PlannedJob = {
    id: legId,
    runsOn: job.runsOn ?? DEFAULT_RUNS_ON,
    needs,
    steps: job.steps.map((s, i) => compileStep(s, legId, i, jobEnv, inputs, matrix)),
  };
  if (title !== undefined) planned.title = title;
  if (job.if !== undefined) planned.if = job.if;
  if (matrix !== undefined) planned.matrix = matrix;
  if (job.outputs !== undefined) {
    // Job output expressions resolve at runtime (steps.*/needs.*); resolve any
    // inputs.*/matrix.* now, defer the rest.
    const ictx = { inputs, ...(matrix ? { matrix } : {}) };
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(job.outputs)) {
      outputs[k] = interpolate(v, ictx);
    }
    planned.outputs = outputs;
  }
  return planned;
}

/**
 * Expand a base job into its legs: a list of `{ id, title, cell }`. Non-matrix
 * jobs yield exactly one leg whose id is the job id. Matrix jobs yield one leg
 * per cell with a stable `<base>::<cell>` id; colliding ids are disambiguated.
 */
function expandJob(baseId: string, job: JobSpec): { id: string; title?: string; cell?: MatrixCell }[] {
  const matrix = job.strategy?.matrix;
  if (!matrix) return [{ id: baseId }];

  const axisOrder = Object.keys(matrix.axes);
  const cells = expandMatrix(matrix);
  if (cells.length === 0) {
    throw new WorkflowCompileError(`job "${baseId}": strategy.matrix produced no combinations`);
  }

  const seen = new Set<string>();
  return cells.map((cell) => {
    let suffix = cellId(cell, axisOrder);
    if (suffix === "") suffix = "1";
    let id = `${baseId}::${suffix}`;
    for (let n = 2; seen.has(id); n++) id = `${baseId}::${suffix}-${n}`;
    seen.add(id);
    return { id, title: cellLabel(baseId, cell, axisOrder), cell };
  });
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

  // First pass: expand each base job into its legs and record base -> leg ids,
  // so a dependency on a matrix base fans out to *all* its legs (converge).
  const expansions = new Map<string, { id: string; title?: string; cell?: MatrixCell }[]>();
  for (const [jobId, job] of Object.entries(spec.jobs)) {
    expansions.set(jobId, expandJob(jobId, job));
  }
  const legsOf = (baseId: string): string[] => (expansions.get(baseId) ?? []).map((l) => l.id);

  // Second pass: compile each leg, rewriting `needs` to concrete leg ids.
  const jobs: Record<string, PlannedJob> = {};
  for (const [jobId, job] of Object.entries(spec.jobs)) {
    const needs = (job.needs ?? []).flatMap(legsOf);
    for (const leg of expansions.get(jobId)!) {
      jobs[leg.id] = compileLeg(leg.id, leg.title, job, needs, workflowEnv, inputs, leg.cell);
    }
  }

  return { name: spec.name, jobs, jobOrder: topoSort(jobs), inputs };
}
