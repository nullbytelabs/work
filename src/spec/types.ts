/**
 * The declarative workflow spec — the "what to run" layer.
 *
 * This mirrors the GitHub-Actions-style YAML described in the README
 * (workflows -> jobs -> steps): name, env, inputs, jobs, `run`/`uses` steps,
 * `needs`, `runs-on`, `if`/`when`, and `strategy.matrix` — all compiled and
 * executed by the engine.
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
  /** Stable id, used to reference this step's outputs (`steps.<id>.outputs.*`). */
  id?: string;
  /** Shell command / script to execute. Mutually exclusive with `uses`. */
  run?: string;
  /** A `uses:` reference (`work/agent`, `action/<name>`, `work/checkout`, …). Mutually exclusive with `run`. */
  uses?: string;
  /** Inputs for a `uses` step. */
  with?: Record<string, unknown>;
  /** Conditional guard. Evaluated at runtime; a false result skips the step. */
  if?: string;
  /**
   * When true, a non-zero exit from this step does not fail the job — the run
   * continues to later steps and the job can still succeed (GitHub Actions
   * `continue-on-error`). The step's real outcome is still recorded, so
   * downstream consumers can react to it: `${{ steps.<id>.outcome }}` reads
   * `failure` in expressions, and `steps.<id>.result` does the same in an
   * `if:`/`when:` condition.
   */
  continueOnError?: boolean;
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

/**
 * A job's machine sizing (`machine:`) — either a **named type** from the
 * built-in catalog (`machine: large`) or an **inline custom spec**
 * (`machine: { cpus: 8, memory: 16G }`). A custom spec may set either dimension;
 * an unset one inherits from the default type. The compiler resolves either form
 * against the catalog in `src/compiler/machines.ts`.
 */
export type MachineSpec =
  | string
  | {
      /** vCPU count. */
      cpus?: number;
      /** RAM in qemu syntax (e.g. "8G"). */
      memory?: string;
    };

/**
 * A job: an isolated execution unit. It is **either** a `steps:` job (the usual
 * case) **or** a `uses:` job that calls a whole reusable workflow as a unit
 * (`uses: workflow/<name>` + `with:`) — never both. The parser enforces the
 * exclusivity; the compiler inlines a `uses:` job's callee into the flat plan.
 */
export interface JobSpec {
  /** Where the job runs. Default applied by the compiler (`DEFAULT_RUNS_ON`, "work:base"). Forbidden on a `uses:` job. */
  runsOn?: string;
  /** Machine sizing (named type or inline cpu/memory). Resolved by the compiler against the built-in catalog. Forbidden on a `uses:` job. */
  machine?: MachineSpec;
  /** IDs of jobs that must complete before this one (the `needs` DAG). */
  needs?: string[];
  /** Conditional guard. Evaluated at runtime; a false result skips the job. */
  if?: string;
  /** Fan-out strategy (matrix). Expanded into independent legs by the compiler. */
  strategy?: StrategySpec;
  /** Job-level env, layered over workflow env. Forbidden on a `uses:` job. */
  env?: EnvMap;
  /** Outputs exposed to dependents as `needs.<job>.outputs.<name>`; values are expressions. Forbidden on a `uses:` job (outputs come from the callee). */
  outputs?: Record<string, string>;
  /**
   * A reusable-workflow reference (`workflow/<name>` or `./path.yaml`). Mutually
   * exclusive with `steps`. The job delegates to the referenced workflow; the
   * compiler binds `with:` to its inputs and inlines it.
   */
  uses?: string;
  /** Inputs to a `uses:` callee, validated against its declared `inputs:`. */
  with?: Record<string, unknown>;
  /** Ordered steps. Required unless the job is a `uses:` job. */
  steps?: StepSpec[];
}

/**
 * A `webhook` trigger declaration under `on:`.
 *
 * `on: webhook` (string shorthand) opts the workflow in to remote, authenticated
 * POST triggering with no further config. The expanded mapping form lets the
 * author *name a config entry* that holds the actual secret — the workflow stays
 * secret-free (`webhook: { secret: <name> }` references `webhooks.<name>` in the
 * operator's config; this type does NOT resolve config, it only types the shape).
 * `source` is a free-form hint of the expected sender (e.g. `alertmanager`) for a
 * receiver to branch on. The interface is intentionally extensible — additional
 * receiver-side fields land here as the trigger machinery grows.
 */
export interface WebhookTrigger {
  /** Names a config entry (`webhooks.<name>`) holding the hook's auth secret. A reference, never a literal secret. */
  secret?: string;
  /** Free-form hint of the expected sender shape (e.g. "alertmanager", "grafana"). */
  source?: string;
}

/**
 * A `workflow_call` trigger declaration under `on:` — the opt-in that makes a
 * workflow callable as a reusable unit by another workflow's `uses:` job (the
 * GitHub-Actions `on: workflow_call` analog). `on: workflow_call` (string
 * shorthand) / `true` opts in with no published outputs; the mapping form
 * declares the flat `outputs:` surface the callee exposes to its caller, each
 * value an expression in the callee's vocabulary (`${{ jobs.<id>.outputs.<k> }}`).
 *
 * Unlike `webhook`, this trigger IS load-bearing: the compiler asserts a callee
 * has opted in, and reads `outputs` to expose the call's outputs on the inlined
 * producer job.
 */
export interface WorkflowCallSpec {
  /** Outputs exposed to the caller as `needs.<callJob>.outputs.<name>`; values are `${{ jobs.<id>.outputs.<key> }}` expressions. */
  outputs?: Record<string, string>;
}

/** One cron-scheduled trigger. Mirrors GitHub Actions' `schedule: [{ cron }]` list form. */
export interface ScheduleTrigger {
  /** A cron expression (POSIX 5-field `minute hour day-of-month month day-of-week`), validated at parse time. */
  cron: string;
}

/**
 * The typed `on:` trigger block. `webhook` gates remote triggering; `workflow_call`
 * gates reusable-workflow callability; `schedule` declares cron triggers. `true` is
 * the opt-in with no options; a mapping carries each trigger's details.
 *
 * NOTE: `webhook` is **not load-bearing for execution** (the receiver reads it).
 * `workflow_call`, by contrast, IS read by the compiler (opt-in assert + outputs).
 * `schedule` carries cron expressions, validated here at parse time.
 */
export interface OnSpec {
  webhook?: WebhookTrigger | boolean;
  workflow_call?: WorkflowCallSpec | boolean;
  /** Zero or more cron expressions for time-based triggering (`on: { schedule: [{ cron }] }`). */
  schedule?: ScheduleTrigger[];
}

/** A whole workflow file. */
export interface WorkflowSpec {
  /** Workflow name. */
  name: string;
  /** Trigger declaration (`on:`). Validated but not acted on by the engine; the webhook receiver reads it. */
  on?: OnSpec;
  /** Declared inputs, provided at run time and read via `${{ inputs.<name> }}`. */
  inputs?: Record<string, InputSpec>;
  /** Workflow-level env, the base layer for all jobs/steps. */
  env?: EnvMap;
  /** Named jobs. */
  jobs: Record<string, JobSpec>;
}
