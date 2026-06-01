/**
 * The declarative workflow spec — the "what to run" layer.
 *
 * This mirrors the GitHub-Actions-style YAML described in the README
 * (workflows -> jobs -> steps). Phase 1 implements the subset needed to run
 * `test/e2e/hello-world-gondolin/workflow.yaml`: name, env, jobs, and `run` steps. Fields that
 * later phases will use (`needs`, `runsOn`, `uses`, `if`, `matrix`) are modeled
 * here so the schema is stable, even where the runtime does not yet act on them.
 */

/** Environment variables declared at any level. Values are always strings. */
export type EnvMap = Record<string, string>;

/** Declared scalar types for a workflow input. */
export type InputType = "string" | "boolean" | "number";

/**
 * A declared workflow input (GitHub-Actions-style). Provided at run time via a
 * JSON body (`--inputs`) and referenced with `${{ inputs.<name> }}`. The
 * shorthand `name:` (null value) means an optional string input; a scalar
 * (`age: 36`) is shorthand for a typed input with that default.
 */
export interface InputSpec {
  type?: InputType;
  required?: boolean;
  default?: string | number | boolean;
  description?: string;
  /** Allowed values; a provided value not in this list is rejected. */
  options?: (string | number | boolean)[];
  /**
   * Regex the (string) value must match (`test`, so include anchors as needed).
   * This is the general-purpose validator — e.g. a UUID is just a pattern. The
   * engine deliberately ships no named-`format` registry to maintain.
   */
  pattern?: string;
}

/** A single step within a job. */
export interface StepSpec {
  /** Human-readable name (defaults to the step's run command if omitted). */
  name?: string;
  /** Stable id, used to reference this step's outputs (Phase 2+). */
  id?: string;
  /** Shell command / script to execute. Mutually exclusive with `uses`. */
  run?: string;
  /** Action/agent reference (Phase 2+). Mutually exclusive with `run`. */
  uses?: string;
  /** Inputs for a `uses` step (Phase 2+). */
  with?: Record<string, unknown>;
  /** Conditional guard. Evaluated at runtime; a false result skips the step. */
  if?: string;
  /** Step-level env, layered over job and workflow env. */
  env?: EnvMap;
}

/** A matrix axis value (scalar). */
export type MatrixValue = string | number | boolean;

/**
 * `strategy.matrix` — fan-out a job into one leg per combination of axis values.
 *
 * The named keys are axes (`node: [20, 22]`); each is an array of scalars and
 * the legs are the full cartesian product. `include` appends/extends cells and
 * `exclude` prunes them, matching GitHub Actions semantics. The compiler expands
 * this into N independent `PlannedJob`s, each carrying its resolved cell so
 * `${{ matrix.<axis> }}` can be interpolated.
 */
export interface MatrixSpec {
  /** Named axes: axis name -> list of values to expand over. */
  axes: Record<string, MatrixValue[]>;
  /** Extra cells / extensions of existing cells (GHA `include`). */
  include?: Record<string, MatrixValue>[];
  /** Partial cells to remove from the product (GHA `exclude`). */
  exclude?: Record<string, MatrixValue>[];
}

/** A job's execution `strategy:` (currently just `matrix`). */
export interface StrategySpec {
  matrix?: MatrixSpec;
}

/** A job: an isolated execution unit containing ordered steps. */
export interface JobSpec {
  /** Where the job runs. Default applied by the compiler (`DEFAULT_RUNS_ON`, "gondolin"). */
  runsOn?: string;
  /** IDs of jobs that must complete before this one (Phase 2+ DAG). */
  needs?: string[];
  /** Conditional guard. Evaluated at runtime; a false result skips the job. */
  if?: string;
  /** Fan-out strategy (matrix). Expanded into independent legs by the compiler. */
  strategy?: StrategySpec;
  /** Job-level env, layered over workflow env. */
  env?: EnvMap;
  /** Outputs exposed to dependents as `needs.<job>.outputs.<name>`; values are expressions. */
  outputs?: Record<string, string>;
  /** Ordered steps. */
  steps: StepSpec[];
}

/** A whole workflow file. */
export interface WorkflowSpec {
  /** Workflow name. */
  name: string;
  /** Trigger declaration (Phase 2+). Parsed but not acted on in Phase 1. */
  on?: unknown;
  /** Declared inputs, provided at run time and read via `${{ inputs.<name> }}`. */
  inputs?: Record<string, InputSpec>;
  /** Workflow-level env, the base layer for all jobs/steps. */
  env?: EnvMap;
  /** Named jobs. */
  jobs: Record<string, JobSpec>;
}
