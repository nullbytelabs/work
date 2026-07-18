/**
 * The compiled, runtime-agnostic execution plan.
 *
 * This is the seam between "what to run" (the spec) and "how durably / where"
 * (a Runtime + ExecutionTarget). The compiler resolves everything that does not
 * depend on a particular runtime: env layering, default `runs-on`, step naming,
 * and a deterministic job order from the `needs` DAG.
 *
 * The Absurd-backed runtime consumes this same plan — a job becomes an Absurd
 * task, a step becomes a `ctx.step(name, fn)` checkpoint, and `jobOrder` drives
 * the spawn/await sequence. Keeping the plan runtime-agnostic is what makes the
 * runtime swappable.
 */

import type { ResolvedMachine } from "./machines.ts";
import type { RunsOnSpec } from "./runs-on.ts";

/** A fully-resolved step ready for execution. */
export interface PlannedStep {
  /** Stable, unique-within-job name: `<jobId>/<stepId-or-index>`. */
  name: string;
  /** Author-given human-readable `name:`, for display (falls back to the id/index). */
  title?: string;
  /** Author-given step id (for `steps.<id>.outputs.*` references), if any. */
  id?: string;
  /** The shell command to run, if this is a `run` step. */
  run?: string;
  /** Agent reference (`agent/<name>[@ref]`), if this is a `uses` step. */
  uses?: string;
  /** Inputs for a `uses` step (string values may carry deferred expressions). */
  with?: Record<string, unknown>;
  /** Raw conditional guard, evaluated at runtime; a false result skips the step. */
  if?: string;
  /** When true, a non-zero exit doesn't fail the job (GitHub Actions `continue-on-error`). */
  continueOnError?: boolean;
  /** Resolved env (workflow <- job <- step); may carry deferred needs/steps expressions. */
  env: Record<string, string>;
}

/** A fully-resolved job. */
export interface PlannedJob {
  /** Stable, unique id. For a matrix leg this is `<base>::<cell>` (path-safe). */
  id: string;
  /** Human-readable label, e.g. `test (node=20)` for a matrix leg; defaults to `id`. */
  title?: string;
  /** Resolved execution target key (currently always "gondolin"). */
  runsOn: string;
  /**
   * The parsed form of `runsOn` (namespace + optional image variant). Parsed once
   * here at the compile boundary so downstream image resolution consumes structured
   * data instead of re-parsing the string at provision time.
   */
  runsOnSpec: RunsOnSpec;
  /** Resolved machine sizing (cpus/memory) for the job's micro-VM. */
  machine: ResolvedMachine;
  /** Resolved dependencies (job ids; matrix bases are already expanded to legs). */
  needs: string[];
  /** Raw conditional guard, evaluated at runtime; a false result skips the job. */
  if?: string;
  /** Resolved matrix cell for this leg, exposed as `${{ matrix.* }}`; absent for non-matrix jobs. */
  matrix?: Record<string, string | number | boolean>;
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
  /** Resolved workflow inputs, so the runtime can evaluate `if:` against them. */
  inputs?: Record<string, string | number | boolean>;
  /**
   * The resolved webhook/dispatch payload (`event`), threaded through from
   * `compile(spec, { event })`. Two roles: (1) `${{ event.* }}` references are
   * baked into `run:`/`env:`/`with:`/`outputs:` strings at compile time, exactly
   * like `inputs`; (2) the raw payload rides along so the runtime can evaluate
   * `event.*` in deferred `if:`/`when:` conditions (that runtime wiring is added
   * separately). Absent for non-webhook runs.
   */
  event?: Record<string, unknown>;
  /**
   * Non-fatal authoring warnings raised at compile time (e.g. a deprecated or
   * implicit `runs-on`). The CLI surfaces these on stderr; the run proceeds.
   */
  warnings?: string[];
}
