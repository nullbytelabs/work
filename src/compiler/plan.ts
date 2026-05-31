/**
 * The compiled, runtime-agnostic execution plan.
 *
 * This is the seam between "what to run" (the spec) and "how durably / where"
 * (a Runtime + ExecutionTarget). The compiler resolves everything that does not
 * depend on a particular runtime: env layering, default `runs-on`, step naming,
 * and a deterministic job order from the `needs` DAG.
 *
 * In Phase 2 the Absurd-backed runtime consumes this same plan — a job becomes
 * an Absurd child task, a step becomes `ctx.step(name, fn)`, and `jobOrder`
 * drives the spawn/await sequence. Keeping the plan runtime-agnostic is what
 * makes the runtime swappable.
 */

/** A fully-resolved step ready for execution. */
export interface PlannedStep {
  /** Stable, unique-within-job name: `<jobId>/<stepId-or-index>`. */
  name: string;
  /** Author-given step id (for `steps.<id>.outputs.*` references), if any. */
  id?: string;
  /** The shell command to run, if this is a `run` step. */
  run?: string;
  /** Agent reference (`agent/<name>[@ref]`), if this is a `uses` step. */
  uses?: string;
  /** Inputs for a `uses` step (string values may carry deferred expressions). */
  with?: Record<string, unknown>;
  /** Raw conditional expression (Phase 2+). */
  if?: string;
  /** Resolved env (workflow <- job <- step); may carry deferred needs/steps expressions. */
  env: Record<string, string>;
}

/** A fully-resolved job. */
export interface PlannedJob {
  id: string;
  /** Resolved execution target key, e.g. "local" or "gondolin". */
  runsOn: string;
  /** Resolved dependencies (job ids). */
  needs: string[];
  steps: PlannedStep[];
  /** Job outputs: name -> expression (resolved at runtime from step outputs). */
  outputs?: Record<string, string>;
}

/** The whole compiled workflow. */
export interface ExecutionPlan {
  name: string;
  jobs: Record<string, PlannedJob>;
  /** A valid topological execution order over `needs`. */
  jobOrder: string[];
}
