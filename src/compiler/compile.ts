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
import type { JobSpec, MatrixSpec, StepSpec, WorkflowSpec } from "../spec/index.ts";
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
import { parseRunsOn } from "./runs-on.ts";
import { interpolate } from "./expr.ts";
import { expandMatrix, cellId, cellLabel, type MatrixCell } from "./matrix.ts";
import { resolveMachine } from "./machines.ts";
import { inlineCall, rewriteOutputRefs, REUSABLE_DEPTH_CAP, type InlineResult, type ResolveWorkflow } from "./reusable.ts";

/** A runaway guard on the total number of jobs an expansion (matrix × reusable) may produce. */
const MAX_PLAN_JOBS = 1000;

/** Options for compiling a workflow. */
export interface CompileOptions {
  /** Raw input values (e.g. parsed from `--inputs '<json>'`), validated against the spec. */
  inputs?: Record<string, unknown>;
  /**
   * The resolved webhook/dispatch payload, exposed as `${{ event.* }}`. When
   * provided, event expressions are baked into strings at compile time (just like
   * `inputs`); when omitted, `${{ event.* }}` is left intact for a later phase.
   */
  event?: Record<string, unknown>;
  /**
   * Resolver for reusable-workflow `uses:` references. Injected by the caller (the
   * CLI) so the compiler stays filesystem-pure. When absent, a `uses:` job is a
   * compile error (reusable workflows aren't available in that context).
   */
  resolveWorkflow?: ResolveWorkflow;
  /** @internal Recursion state: resolved callee file paths, for cycle detection. */
  _chain?: string[];
  /** @internal Recursion state: current nesting depth, for the depth cap. */
  _depth?: number;
  /** @internal Recursion state: directory of the workflow being compiled, for relative `./` refs. */
  _fromDir?: string;
  /** @internal Reusable-call state: input names whose value is a runtime
   *  expression (`${{ needs.* }}` passed via the caller's `with:`), to be
   *  substituted verbatim rather than compile-time-validated. */
  _deferredInputs?: Set<string>;
}

export const DEFAULT_RUNS_ON = "gondolin";

/**
 * Validate a job's `runs-on` (shape only). The supported targets are the stock
 * `gondolin` guest and a `work:<image>` custom image — every job runs in the
 * sandbox either way. `runs-on: local` (host execution) was removed outright:
 * allowing it would let a step run on the host, defeating the isolation the engine
 * exists to provide. Whether a `work:<image>` actually resolves/builds is a
 * runtime concern; here we only check the value is well-formed. Throws on an
 * invalid value.
 */
function validateRunsOn(jobId: string, runsOn: string | undefined): void {
  if (runsOn === undefined) return;
  try {
    parseRunsOn(runsOn);
  } catch (err) {
    throw new WorkflowCompileError(`job "${jobId}": ${(err as Error).message}`);
  }
}

/**
 * Nudge authors to state the sandbox outright: an omitted `runs-on` defaults to
 * gondolin, which we'd rather have written explicitly. Returns a warning string
 * for an implicit `runs-on`, or undefined when it's explicit.
 */
function runsOnWarning(jobId: string, runsOn: string | undefined): string | undefined {
  if (runsOn === undefined) {
    return `job "${jobId}": no "runs-on" set — defaulting to "${DEFAULT_RUNS_ON}". Set "runs-on: gondolin" explicitly.`;
  }
  return undefined;
}

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
  event: Record<string, unknown> | undefined,
): PlannedStep {
  const stepKey = step.id ?? String(index);
  // Resolve ${{ inputs.x }} / ${{ matrix.x }} / ${{ event.* }} now; leave
  // ${{ needs.* }} / ${{ steps.* }} for runtime.
  const ictx = { inputs, ...(matrix ? { matrix } : {}), ...(event ? { event } : {}) };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(mergeEnv(baseEnv, step.env))) {
    env[k] = interpolate(v, ictx);
  }
  const planned: PlannedStep = { name: `${jobId}/${stepKey}`, env };
  if (step.name !== undefined) planned.title = step.name;
  if (step.id !== undefined) planned.id = step.id;
  if (step.continueOnError) planned.continueOnError = true;
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
  event: Record<string, unknown> | undefined,
): PlannedJob {
  const jobEnv = mergeEnv(workflowEnv, job.env);
  const planned: PlannedJob = {
    id: legId,
    runsOn: job.runsOn ?? DEFAULT_RUNS_ON,
    machine: resolveMachine(job.machine, legId),
    needs,
    steps: (job.steps ?? []).map((s, i) => compileStep(s, legId, i, jobEnv, inputs, matrix, event)),
  };
  if (title !== undefined) planned.title = title;
  if (job.if !== undefined) planned.if = job.if;
  if (matrix !== undefined) planned.matrix = matrix;
  if (job.outputs !== undefined) {
    // Job output expressions resolve at runtime (steps.*/needs.*); resolve any
    // inputs.*/matrix.*/event.* now, defer the rest.
    const ictx = { inputs, ...(matrix ? { matrix } : {}), ...(event ? { event } : {}) };
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(job.outputs)) {
      outputs[k] = interpolate(v, ictx);
    }
    planned.outputs = outputs;
  }
  return planned;
}

/**
 * Expand a matrix into its legs: one `{ id, title, cell }` per cell with a stable
 * `<base>::<cell>` id; colliding ids are disambiguated. Shared by `expandJob`
 * (a `steps:` job) and the reusable-workflow path (a `uses:` job that carries a
 * `strategy.matrix` fans the *call* out per cell).
 */
function matrixLegs(baseId: string, matrix: MatrixSpec): { id: string; title: string; cell: MatrixCell }[] {
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
 * Expand a base job into its legs: a list of `{ id, title, cell }`. Non-matrix
 * jobs yield exactly one leg whose id is the job id. Matrix jobs yield one leg
 * per cell. For a `uses:` job each leg is one call instance; inlining (pass 2)
 * turns it into the real job(s) a downstream `needs: [C]` attaches to.
 */
function expandJob(baseId: string, job: JobSpec): { id: string; title?: string; cell?: MatrixCell }[] {
  const matrix = job.strategy?.matrix;
  if (!matrix) return [{ id: baseId }];
  return matrixLegs(baseId, matrix);
}

/**
 * Kahn's algorithm with deterministic tie-breaking (alphabetical) so the same
 * spec always produces the same order — important for a durable runtime where
 * orchestration must be replay-stable.
 */
export function topoSort(jobs: Record<string, PlannedJob>): string[] {
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

type Legs = Map<string, { id: string; title?: string; cell?: MatrixCell }[]>;
interface InlinedJob {
  job: JobSpec;
  results: InlineResult[];
}

/** Pass 2: inline every `uses:` job up front to learn its leg ids (what a
 *  downstream `needs: [C]` attaches to) before any `needs` are wired. Returns the
 *  per-base leg ids, the inlined results to splice in pass 4, and the caller-side
 *  output-ref rewrites. Bubbles callee warnings into `warnings`. */
function inlineUsesJobs(
  spec: WorkflowSpec,
  expansions: Legs,
  inputs: ResolvedInputs,
  event: Record<string, unknown> | undefined,
  opts: CompileOptions,
  warnings: string[],
): { legIdsOf: Map<string, string[]>; inlined: Map<string, InlinedJob>; outputRewritesByBase: Map<string, Record<string, string>> } {
  const inlined = new Map<string, InlinedJob>();
  const outputRewritesByBase = new Map<string, Record<string, string>>();
  const legIdsOf = new Map<string, string[]>();
  for (const [jobId, job] of Object.entries(spec.jobs)) {
    if (job.uses === undefined) {
      legIdsOf.set(jobId, expansions.get(jobId)!.map((l) => l.id));
      continue;
    }
    const results = expansions.get(jobId)!.map((leg) => inlineCall({ baseId: jobId, job, leg, inputs, event, opts }));
    legIdsOf.set(jobId, results.flatMap((r) => r.legIds));
    inlined.set(jobId, { job, results });
    for (const r of results) {
      warnings.push(...r.warnings);
      if (Object.keys(r.outputRewrites).length > 0) {
        outputRewritesByBase.set(jobId, { ...(outputRewritesByBase.get(jobId) ?? {}), ...r.outputRewrites });
      }
    }
  }
  return { legIdsOf, inlined, outputRewritesByBase };
}

/** Pass 4: splice each inlined `uses:` job into the plan via `addJob`, injecting
 *  the caller's `needs` (and a call-level `if:`) into the callee's root jobs. */
function emitInlinedJobs(
  inlined: Map<string, InlinedJob>,
  legsOf: (baseId: string) => string[],
  addJob: (job: PlannedJob) => void,
): void {
  for (const [jobId, { job, results }] of inlined) {
    const needs = (job.needs ?? []).flatMap(legsOf);
    for (const r of results) {
      const byId = new Map(r.jobs.map((j) => [j.id, j]));
      for (const rootId of r.rootIds) {
        const root = byId.get(rootId)!;
        root.needs = [...needs];
        if (job.if !== undefined) {
          if (root.if !== undefined) {
            throw new WorkflowCompileError(
              `job "${jobId}": if: on a reusable call is not supported when callee root job "${root.id}" has its own if: (v1)`,
            );
          }
          root.if = job.if;
        }
      }
      for (const j of r.jobs) addJob(j);
    }
  }
}

/** Rewrite a caller job's `needs.<call>.outputs.<name>` references onto the real
 *  producer jobs (multi-job reusable callees), per the maps gathered at inline time. */
function applyOutputRewrites(job: PlannedJob, byBase: Map<string, Record<string, string>>): void {
  const rew = (s: string): string => {
    let out = s;
    for (const [callId, rewrites] of byBase) out = rewriteOutputRefs(out, callId, rewrites);
    return out;
  };
  if (job.outputs) {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(job.outputs)) o[k] = rew(v);
    job.outputs = o;
  }
  if (job.if !== undefined) job.if = rew(job.if);
  for (const st of job.steps) {
    if (st.run !== undefined) st.run = rew(st.run);
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(st.env)) e[k] = rew(v);
    st.env = e;
    if (st.if !== undefined) st.if = rew(st.if);
    if (st.with) for (const [k, v] of Object.entries(st.with)) if (typeof v === "string") st.with[k] = rew(v);
  }
}

/** Compile a validated spec into an execution plan, binding any provided inputs. */
export function compile(spec: WorkflowSpec, opts: CompileOptions = {}): ExecutionPlan {
  const inputs = resolveInputs(spec.inputs, opts.inputs ?? {}, opts._deferredInputs);
  const workflowEnv = spec.env ?? {};
  const event = opts.event;

  if ((opts._depth ?? 0) > REUSABLE_DEPTH_CAP) {
    throw new WorkflowCompileError(
      `reusable-workflow nesting too deep (> ${REUSABLE_DEPTH_CAP}): ${(opts._chain ?? []).join(" -> ")}`,
    );
  }

  // Pass 1: expand each base job into its legs (matrix fan-out; a non-matrix or
  // `uses:` job yields one leg).
  const expansions = new Map<string, { id: string; title?: string; cell?: MatrixCell }[]>();
  for (const [jobId, job] of Object.entries(spec.jobs)) {
    expansions.set(jobId, expandJob(jobId, job));
  }

  const warnings: string[] = [];

  // Pass 2: inline every `uses:` job (per leg) up front — this is how we learn its
  // *leg ids* (the real jobs a downstream `needs: [C]` attaches to: the collapsed
  // node, or a multi-job callee's leaves). Roots stay un-wired; pass 4 injects the
  // caller's `needs`. `outputRewritesByBase` collects caller-side output rewrites.
  const { legIdsOf, inlined, outputRewritesByBase } = inlineUsesJobs(spec, expansions, inputs, event, opts, warnings);
  const legsOf = (baseId: string): string[] => legIdsOf.get(baseId) ?? [];

  const jobs: Record<string, PlannedJob> = {};
  const addJob = (job: PlannedJob): void => {
    // `Object.hasOwn`, not `in` — `in` walks the prototype, so a job named
    // `toString`/`constructor` would be a false collision.
    if (Object.hasOwn(jobs, job.id)) {
      throw new WorkflowCompileError(`job id collision: "${job.id}" is produced by more than one job — rename one`);
    }
    jobs[job.id] = job;
  };

  // Pass 3: emit `steps:` jobs, rewriting `needs` to concrete leg ids. Warn once
  // per *base* job (not per matrix leg) about a deprecated/implicit runs-on.
  for (const [jobId, job] of Object.entries(spec.jobs)) {
    if (job.uses !== undefined) continue;
    validateRunsOn(jobId, job.runsOn);
    const w = runsOnWarning(jobId, job.runsOn);
    if (w) warnings.push(w);
    const needs = (job.needs ?? []).flatMap(legsOf);
    for (const leg of expansions.get(jobId)!) {
      addJob(compileLeg(leg.id, leg.title, job, needs, workflowEnv, inputs, leg.cell, event));
    }
  }

  // Pass 4: splice in each `uses:` job's inlined jobs, injecting the caller's
  // `needs` (and a call-level `if:`) into the callee's root jobs.
  emitInlinedJobs(inlined, legsOf, addJob);

  // Pass 5: rewrite caller-side `needs.<call>.outputs.<name>` onto the callee's
  // real producers (multi-job callees only; a collapsed single job needs none).
  if (outputRewritesByBase.size > 0) {
    for (const job of Object.values(jobs)) applyOutputRewrites(job, outputRewritesByBase);
  }

  if (Object.keys(jobs).length > MAX_PLAN_JOBS) {
    throw new WorkflowCompileError(
      `compiled plan has ${Object.keys(jobs).length} jobs, over the limit of ${MAX_PLAN_JOBS} (matrix/reusable expansion too large)`,
    );
  }

  const plan: ExecutionPlan = { name: spec.name, jobs, jobOrder: topoSort(jobs), inputs };
  if (event !== undefined) plan.event = event;
  if (warnings.length > 0) plan.warnings = warnings;
  return plan;
}
