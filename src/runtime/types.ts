/**
 * Runtime — the "how durably" layer.
 *
 * A Runtime takes a compiled ExecutionPlan and runs it. The engine's runtime is
 * `AbsurdRuntime` (durable execution on Absurd + PGLite): a whole run is one
 * Absurd task and each step is a `ctx.step(name, fn)` checkpoint, so completed
 * steps are memoized and never recomputed. The interface stays small so the
 * Postgres provider (in-process PGLite vs. a server) is a config choice, not a
 * runtime swap.
 */
import type { ExecutionPlan } from "../compiler/index.ts";

export interface StepResult {
  name: string;
  status: "success" | "failure" | "skipped";
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Outputs this step produced ($PI_OUTPUT lines, or an agent's declared outputs). */
  outputs?: Record<string, string>;
}

export interface JobResult {
  id: string;
  status: "success" | "failure" | "skipped";
  steps: StepResult[];
  /** Resolved job `outputs:` (exposed to dependents as needs.<job>.outputs.*). */
  outputs?: Record<string, string>;
}

export interface WorkflowResult {
  name: string;
  status: "success" | "failure";
  jobs: JobResult[];
}

export interface RunHooks {
  onJobStart?: (jobId: string) => void;
  onStepStart?: (jobId: string, stepName: string) => void;
  onOutput?: (jobId: string, stepName: string, chunk: { stream: "stdout" | "stderr"; text: string }) => void;
  onStepEnd?: (jobId: string, result: StepResult) => void;
  /** Fired when a job finishes (success or failure) — the point to flush buffered per-job output. */
  onJobEnd?: (jobId: string, result: JobResult) => void;
}

export interface RunContext {
  /** Base working directory; each job gets a subdirectory under this. */
  workRoot: string;
  /**
   * Directory whose contents are staged into every job's working directory
   * before its steps run (the workflow's own folder — analogous to a checkout).
   * Lets a workflow run committed companion files (e.g. `script.sh`). Omit for
   * an empty workspace.
   */
  workspaceSource?: string;
  hooks?: RunHooks;
}

export interface Runtime {
  readonly kind: string;
  run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult>;
}
