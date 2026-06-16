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

/** Cumulative token usage for one agent step (the whole Pi loop). */
export interface StepAgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Model calls in the loop — counts real requests, not steps. */
  requests?: number;
}

/** Telemetry for a `work/agent` step: the model and (once captured) token usage.
 *  Structural + primitive so the durable core stays agent-agnostic — it forwards
 *  this opaquely; the observability layer reads it. */
export interface StepAgentInfo {
  model: string;
  provider?: string;
  usage?: StepAgentUsage;
}

export interface StepResult {
  name: string;
  status: "success" | "failure" | "skipped";
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Outputs this step produced ($WORK_OUTPUT lines, or an agent's declared outputs). */
  outputs?: Record<string, string>;
  /** Present only for `work/agent` steps — model + token usage for telemetry. */
  agent?: StepAgentInfo;
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
  /**
   * `success` / `failure` are run-to-verdict outcomes. `interrupted` means the run
   * did NOT finish — its orchestrator was torn out mid-flight (the platform
   * stopped) — so it's resumable, distinct from a `failure` where a job ran and
   * exited non-zero. Recovery differs: `interrupted` → resume; `failure` → re-run.
   */
  status: "success" | "failure" | "interrupted";
  jobs: JobResult[];
}

/** Run-level metadata for `onWorkflowStart` (telemetry's trace-root seed). */
interface WorkflowHookMeta {
  runId: string;
  workflow: string;
  /** True when this invocation is resuming a prior interrupted run. */
  resumed?: boolean;
}

/** Per-job metadata carried on `onJobStart` (beyond the id) — the dimensions
 *  telemetry attaches to the job span / metrics. */
export interface JobHookMeta {
  runsOn: string;
  /** Author-given label, for the span name (the `jobId` stays the stable identity). */
  title?: string;
  /** The VM image identity (the `work:<image>` selector, or stock target key). */
  image?: string;
  arch?: string;
  matrix?: Record<string, string | number | boolean>;
  /** Upstream job ids this job `needs` — fan-in span links. */
  needs?: string[];
}

/** Per-step metadata carried on `onStepStart`. */
export interface StepHookMeta {
  kind: "run" | "uses";
  uses?: string;
  /** Author-given label, for the span name (the stable step name stays the identity). */
  title?: string;
}

/**
 * The run lifecycle event stream. Consumers (TUI/web presenters, the observability
 * emitter) implement the subset they need. The metadata args are optional so a
 * consumer that only wants ids/results can implement the narrow form, and a caller
 * (e.g. the presenter test) can drive the hooks without the metadata.
 */
export interface RunHooks {
  onWorkflowStart?: (meta: WorkflowHookMeta) => void;
  onJobStart?: (jobId: string, meta?: JobHookMeta) => void;
  onStepStart?: (jobId: string, stepName: string, meta?: StepHookMeta) => void;
  onOutput?: (jobId: string, stepName: string, chunk: { stream: "stdout" | "stderr"; text: string }) => void;
  onStepEnd?: (jobId: string, result: StepResult) => void;
  /** Fired when a job finishes (success or failure) — the point to flush buffered per-job output. */
  onJobEnd?: (jobId: string, result: JobResult) => void;
  onWorkflowEnd?: (result: WorkflowResult) => void;
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
   * Directory holding the workflow definition and its local assets (action
   * packages under `<workflowDir>/actions/`). Distinct from `workspaceSource`
   * when the workflow lives in a `.workflows/` folder: the checkout staged into
   * jobs is the project root, while actions resolve from `.workflows/actions/`.
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
 * for that scheme and maps the result into a step result. The `work` handler
 * (work/agent + built-ins) and the `action` handler are composed in at the
 * CLI/test layer — the runtime imports none of the agent/Pi/config code.
 */
export interface UsesContext {
  /** The raw `uses:` value, e.g. "work/agent" or "action/review". */
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
  /** Telemetry for a `work/agent` handler — model + token usage; carried onto the
   *  step result for the observability layer. Absent for non-agent handlers. */
  agent?: StepAgentInfo;
}

export interface UsesHandler {
  /** The `uses:` scheme this handles (the segment before the first `/`), e.g. "agent". */
  readonly scheme: string;
  /** Should not throw — return a failure result (and `emit` the reason) instead. */
  run(ctx: UsesContext): Promise<UsesResult>;
}
