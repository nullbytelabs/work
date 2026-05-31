/**
 * Runtime — the "how durably" layer.
 *
 * A Runtime takes a compiled ExecutionPlan and runs it. Phase 1 ships
 * DirectRuntime (in-process, sequential, no persistence). Phase 2 adds an
 * Absurd-backed runtime that implements the SAME interface: each job becomes an
 * Absurd child task, each step a `ctx.step(name, fn)` checkpoint, and the plan's
 * `jobOrder` drives spawn/await. Because both implement `Runtime`, the CLI and
 * everything above it are unchanged when durability lands.
 */
import type { ExecutionPlan } from "../compiler/index.ts";

export interface StepResult {
  name: string;
  status: "success" | "failure" | "skipped";
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface JobResult {
  id: string;
  status: "success" | "failure" | "skipped";
  steps: StepResult[];
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
}

export interface RunContext {
  /** Base working directory; each job gets a subdirectory under this. */
  workRoot: string;
  hooks?: RunHooks;
}

export interface Runtime {
  readonly kind: string;
  run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult>;
}
