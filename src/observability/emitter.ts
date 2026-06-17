/**
 * The telemetry emitter — a pure `RunHooks` consumer that maps the run's lifecycle
 * events onto OpenTelemetry spans and metrics. It is the third hook consumer alongside
 * the TUI and web presenters (docs/observability-otel-metrics.md §1): it owns no
 * presentation and no run logic, just the event → telemetry mapping.
 *
 * Design points it embodies:
 *   - **Injected `tracer`/`meter`** (not a global provider). Production wires the
 *     globally-registered SDK; tests pass in-memory-backed providers. This is what
 *     makes the whole mapping unit-testable (test/observability.test.ts) and is the
 *     same seam as the opt-in / no-op design (§7).
 *   - **Explicit parent contexts, never ambient** (§4.5). Jobs run concurrently, so
 *     each job/step span is parented from a stored `Context`, not `context.active()`.
 *   - **Outcome as an attribute, not span existence** (§3.4): a failed step is an
 *     ERROR span with `error.type`; a job that absorbs it (continue-on-error) stays
 *     non-error. Skipped steps are clean spans with `result=skip`.
 */
import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Meter, Span, Context, SpanContext, Attributes, Link } from "@opentelemetry/api";
import type { RunHooks, JobHookMeta, StepResult, JobResult, WorkflowResult, StepAgentInfo } from "../runtime/types.ts";
import { ATTR, GEN_AI_PROVIDER_ANTHROPIC, runResult, taskResult } from "./semconv.ts";

export interface TelemetryOptions {
  tracer: Tracer;
  meter: Meter;
  /** When false, returns a no-op so the engine pays nothing when telemetry is off. */
  enabled?: boolean;
}

const NOOP: RunHooks = {
  onWorkflowStart() {},
  onJobStart() {},
  onStepStart() {},
  onStepEnd() {},
  onJobEnd() {},
  onWorkflowEnd() {},
};

const stepKey = (jobId: string, stepName: string) => `${jobId} ${stepName}`;

/** Build the telemetry hook consumer (a `RunHooks` implementation). */
export function createTelemetryHooks(opts: TelemetryOptions): RunHooks {
  if (opts.enabled === false) return NOOP;
  const { tracer, meter } = opts;

  // Instruments (created once). Dotted OTel names; the exporter renders the
  // Prometheus wire names (work_runs_total, work_run_duration_seconds, …).
  const mRuns = meter.createCounter("work.runs");
  const mJobs = meter.createCounter("work.jobs");
  const mSteps = meter.createCounter("work.steps");
  const mRunDuration = meter.createHistogram("work.run.duration", { unit: "s" });
  const mJobDuration = meter.createHistogram("work.job.duration", { unit: "s" });
  const mStepDuration = meter.createHistogram("work.step.duration", { unit: "s" });
  const mJobsInFlight = meter.createUpDownCounter("work.jobs.in_flight");
  const mAgentRequests = meter.createCounter("work.agent.requests");
  const mAgentTokens = meter.createCounter("work.agent.tokens");
  const mAgentDuration = meter.createHistogram("work.agent.request.duration", { unit: "s" });
  const mResumes = meter.createCounter("work.run.resumes");

  // Per-run state. Parent contexts are captured explicitly so concurrent jobs and
  // their steps parent correctly without relying on the async-context stack.
  let runId = "";
  let workflow = "";
  let runStart = 0;
  let rootSpan: Span | undefined;
  let rootCtx: Context | undefined;
  /** This invocation re-used an existing run id (a resume, or a no-op re-drive). */
  let resumed = false;
  /** Jobs that actually executed this invocation — 0 + resumed ⇒ a no-op re-drive. */
  let jobsRun = 0;
  const jobs = new Map<string, { span: Span; ctx: Context; start: number }>();
  const stepEntries = new Map<string, { span: Span; ctx: Context; start: number }>();
  /** Persists past job end so a later fan-in job can link to it. */
  const jobSpanContexts = new Map<string, SpanContext>();

  /** Emit the GenAI `chat {model}` leaf span + agent metrics under a step. */
  function emitAgentSpan(agent: StepAgentInfo, stepCtx: Context, start: number, stepRes: string): void {
    const usage = agent.usage;
    const attributes: Attributes = {
      [ATTR.GEN_AI_OPERATION_NAME]: "chat",
      [ATTR.GEN_AI_PROVIDER_NAME]: agent.provider ?? GEN_AI_PROVIDER_ANTHROPIC,
      [ATTR.GEN_AI_REQUEST_MODEL]: agent.model,
      ...(usage
        ? {
            [ATTR.GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens,
            [ATTR.GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
            ...(usage.cacheReadTokens ? { [ATTR.GEN_AI_USAGE_CACHE_READ]: usage.cacheReadTokens } : {}),
            ...(usage.cacheCreationTokens ? { [ATTR.GEN_AI_USAGE_CACHE_CREATION]: usage.cacheCreationTokens } : {}),
          }
        : {}),
    };
    // The hook seam gives one start/end per step, not per model turn, so the leaf
    // span carries the loop's cumulative usage over the step's own time bounds.
    const chat = tracer.startSpan(`chat ${agent.model}`, { kind: SpanKind.INTERNAL, startTime: start, attributes }, stepCtx);
    chat.end();

    mAgentRequests.add(usage?.requests ?? 1, { model: agent.model, result: stepRes });
    mAgentDuration.record((Date.now() - start) / 1000, { model: agent.model, result: stepRes });
    if (usage) {
      mAgentTokens.add(usage.inputTokens, { model: agent.model, direction: "input" });
      mAgentTokens.add(usage.outputTokens, { model: agent.model, direction: "output" });
    }
  }

  return {
    onWorkflowStart(meta) {
      runId = meta.runId;
      workflow = meta.workflow;
      runStart = Date.now();
      resumed = meta.resumed ?? false;
      jobsRun = 0;
      jobs.clear();
      stepEntries.clear();
      jobSpanContexts.clear();
      const attributes: Attributes = {
        [ATTR.WORK_RUN_ID]: meta.runId,
        [ATTR.WORK_WORKFLOW_NAME]: meta.workflow,
        [ATTR.CICD_PIPELINE_NAME]: meta.workflow,
        [ATTR.CICD_PIPELINE_RUN_ID]: meta.runId,
        ...(resumed ? { [ATTR.WORK_RUN_RESUMED]: true } : {}),
      };
      // The run span IS the trace root — a true empty-parent span. OTLP backends detect
      // the root as the span with no parent (Tempo sources a trace's service name, root
      // name, and timeline placement from it), so `root: true` is load-bearing: parenting
      // the run on a synthetic, never-emitted span leaves the trace permanently rootless
      // ("<root span not yet received>" in Tempo Drilldown). Coalescing a resumed run's
      // attempts into one trace is a persistence concern, not faked via a derived id.
      rootSpan = tracer.startSpan(`run ${meta.workflow}`, { kind: SpanKind.SERVER, attributes, root: true });
      rootCtx = trace.setSpan(context.active(), rootSpan);
    },

    onJobStart(jobId, meta?: JobHookMeta) {
      const parent = rootCtx ?? context.active();
      const links: Link[] = (meta?.needs ?? [])
        .map((n) => jobSpanContexts.get(n))
        .filter((c): c is SpanContext => c !== undefined)
        .map((spanContext) => ({ context: spanContext }));
      const attributes: Attributes = {
        [ATTR.WORK_JOB_NAME]: jobId,
        [ATTR.CICD_TASK_NAME]: jobId,
        [ATTR.CICD_TASK_RUN_ID]: `${runId}:${jobId}`,
        ...(meta?.image ? { [ATTR.HOST_IMAGE_NAME]: meta.image } : {}),
        ...(meta?.arch ? { [ATTR.HOST_ARCH]: meta.arch } : {}),
        ...Object.fromEntries(Object.entries(meta?.matrix ?? {}).map(([k, v]) => [`work.matrix.${k}`, v])),
      };
      const span = tracer.startSpan(`job ${meta?.title ?? jobId}`, { kind: SpanKind.INTERNAL, links, attributes }, parent);
      const ctx = trace.setSpan(parent, span);
      jobs.set(jobId, { span, ctx, start: Date.now() });
      jobSpanContexts.set(jobId, span.spanContext());
      jobsRun++;
      mJobsInFlight.add(1, { workflow });
    },

    onStepStart(jobId, stepName, meta) {
      const parent = jobs.get(jobId)?.ctx ?? rootCtx ?? context.active();
      const kind = meta?.kind ?? "run";
      const attributes: Attributes = {
        [ATTR.WORK_STEP_NAME]: stepName,
        [ATTR.WORK_STEP_KIND]: kind,
        ...(meta?.uses ? { [ATTR.WORK_STEP_USES]: meta.uses } : {}),
      };
      const span = tracer.startSpan(`step ${meta?.title ?? stepName}`, { kind: SpanKind.INTERNAL, attributes }, parent);
      const ctx = trace.setSpan(parent, span);
      stepEntries.set(stepKey(jobId, stepName), { span, ctx, start: Date.now() });
    },

    onStepEnd(jobId, result: StepResult) {
      const entry = stepEntries.get(stepKey(jobId, result.name));
      if (!entry) return;
      stepEntries.delete(stepKey(jobId, result.name));
      const { span, ctx, start } = entry;
      const res = taskResult(result.status);
      span.setAttribute(ATTR.WORK_STEP_RESULT, result.status);
      if (result.status === "failure") {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(ATTR.ERROR_TYPE, `exit_${result.exitCode}`);
        if (result.stderr) span.recordException({ message: result.stderr.slice(0, 500) });
      }

      mSteps.add(1, { workflow, job: jobId, result: res });
      mStepDuration.record((Date.now() - start) / 1000, { workflow, job: jobId, result: res });

      if (result.agent) emitAgentSpan(result.agent, ctx, start, res);
      span.end();
    },

    onJobEnd(jobId, result: JobResult) {
      const job = jobs.get(jobId);
      if (!job) return;
      jobs.delete(jobId);
      const res = taskResult(result.status);
      job.span.setAttribute(ATTR.CICD_TASK_RESULT, res);
      if (result.status === "failure") job.span.setStatus({ code: SpanStatusCode.ERROR });
      mJobs.add(1, { workflow, job: jobId, result: res });
      mJobDuration.record((Date.now() - job.start) / 1000, { workflow, job: jobId, result: res });
      mJobsInFlight.add(-1, { workflow });
      job.span.end();
    },

    onWorkflowEnd(result: WorkflowResult) {
      if (!rootSpan) return;
      // No-op re-drive guard: a re-used run id that executed zero jobs (e.g. a worker
      // re-claiming an already-finished run on `work serve` startup) is not a real run —
      // emit nothing. Leaving the root span un-ended means it's never exported; no run
      // counter, no phantom sub-100ms "success" trace.
      if (resumed && jobsRun === 0) {
        rootSpan = undefined;
        rootCtx = undefined;
        return;
      }
      const res = runResult(result.status);
      rootSpan.setAttribute(ATTR.CICD_PIPELINE_RESULT, res);
      if (result.status === "failure") rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      mRuns.add(1, { workflow, result: res });
      mRunDuration.record((Date.now() - runStart) / 1000, { workflow, result: res });
      if (resumed) mResumes.add(1, { workflow });
      rootSpan.end();
      rootSpan = undefined;
      rootCtx = undefined;
    },
  };
}
