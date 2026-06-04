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
  /**
   * Directory holding the workflow definition and its local assets (agent
   * packages under `<workflowDir>/agents/`). Distinct from `workspaceSource`
   * when the workflow lives in a `.workflows/` folder: the checkout staged into
   * jobs is the project root, while agents resolve from `.workflows/agents/`.
   * Defaults to `workspaceSource` when omitted.
   */
  workflowDir?: string;
  hooks?: RunHooks;
  /**
   * Caller-supplied stable run id. The web layer mints this up front so the HTTP
   * route, the SSE stream, and the run record all key on the same id *before*
   * `run()` returns. Defaults to a random UUID when omitted (the CLI path).
   */
  runId?: string;
}

export interface Runtime {
  readonly kind: string;
  run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult>;
}

/**
 * The contract for `uses:` steps. The durable core stays agent-agnostic: it
 * dispatches a step whose `uses:` is `<scheme>/<…>` to the registered handler
 * for that scheme and maps the result into a step result. Agents are just one
 * handler (`scheme: "agent"`), composed in at the CLI/test layer — the runtime
 * imports none of the agent/Pi/config code.
 */
export interface UsesContext {
  /** The raw `uses:` value, e.g. "agent/summarize@v2". */
  uses: string;
  /** The step's `with:` — string values are already interpolated by the core. */
  with: Record<string, unknown>;
  /** The job's working directory (staged workspace). */
  workdir: string;
  /**
   * The project/checkout root (the run's `workspaceSource`) — the same tree
   * staged into `workdir`. Undefined for an inline run with no source folder.
   */
  projectDir?: string;
  /**
   * The directory holding the workflow definition and its local assets. A
   * handler resolves workflow-local packages relative to this — e.g. the agent
   * handler finds packages in `<workflowDir>/agents/<name>/`. Defaults to
   * `projectDir`; differs when the workflow lives in a `.workflows/` folder.
   */
  workflowDir?: string;
  /** The job's `runs-on` target key. */
  runsOn: string;
  /**
   * Always true — every job runs in an isolated gondolin sandbox (there is no
   * host-execution target). Kept on the context so a handler needn't re-derive it.
   */
  sandboxed: boolean;
  /**
   * Run a command in the job's execution environment — the gondolin guest VM.
   * Mirrors `ExecutionTarget.run`, so a handler places work where the job
   * actually runs: inside the sandbox, never the host. This is the seam that
   * lets `uses:` steps run exactly where `run:` steps do (an agent's whole loop
   * executes in the guest).
   */
  exec(
    command: string,
    opts?: {
      env?: Record<string, string>;
      onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; ok: boolean }>;
  /**
   * The staged workspace path **as a command run via `exec` sees it** — the
   * `/workspace` guest mount. It maps to the same files on the host `workdir`,
   * so it's the channel for staging a handler's request/response across the
   * boundary.
   */
  workspacePath: string;
  /** Stream output live (shown by the CLI, captured by hooks). */
  emit(chunk: { stream: "stdout" | "stderr"; text: string }): void;
}

export interface UsesResult {
  status: "success" | "failure";
  stdout?: string;
  stderr?: string;
  outputs?: Record<string, string>;
}

export interface UsesHandler {
  /** The `uses:` scheme this handles (the segment before the first `/`), e.g. "agent". */
  readonly scheme: string;
  /** Should not throw — return a failure result (and `emit` the reason) instead. */
  run(ctx: UsesContext): Promise<UsesResult>;
}
