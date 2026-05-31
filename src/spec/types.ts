/**
 * The declarative workflow spec — the "what to run" layer.
 *
 * This mirrors the GitHub-Actions-style YAML described in the README
 * (workflows -> jobs -> steps). Phase 1 implements the subset needed to run
 * `test/e2e/hello-world-local/workflow.yaml`: name, env, jobs, and `run` steps. Fields that
 * later phases will use (`needs`, `runsOn`, `uses`, `if`, `matrix`) are modeled
 * here so the schema is stable, even where the runtime does not yet act on them.
 */

/** Environment variables declared at any level. Values are always strings. */
export type EnvMap = Record<string, string>;

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
  /** Conditional guard (Phase 2+). */
  if?: string;
  /** Step-level env, layered over job and workflow env. */
  env?: EnvMap;
}

/** A job: an isolated execution unit containing ordered steps. */
export interface JobSpec {
  /** Where the job runs. Defaults handled by the compiler. Phase 1: "local". */
  runsOn?: string;
  /** IDs of jobs that must complete before this one (Phase 2+ DAG). */
  needs?: string[];
  /** Job-level env, layered over workflow env. */
  env?: EnvMap;
  /** Ordered steps. */
  steps: StepSpec[];
}

/** A whole workflow file. */
export interface WorkflowSpec {
  /** Workflow name. */
  name: string;
  /** Trigger declaration (Phase 2+). Parsed but not acted on in Phase 1. */
  on?: unknown;
  /** Workflow-level env, the base layer for all jobs/steps. */
  env?: EnvMap;
  /** Named jobs. */
  jobs: Record<string, JobSpec>;
}
