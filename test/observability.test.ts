/**
 * Observability emitter — Layer 1 (unit) spec.
 *
 * The OTel/metrics emitter is a pure hook consumer, exactly like the TUI and web
 * presenters (cf. `web-presenter.test.ts`): you drive its hook methods and assert on
 * what it emits. Here "what it emits" is OTel spans + metrics, captured by the SDK's
 * *in-memory* exporters — so the whole mapping (hook events → telemetry) is testable
 * in-process with no collector, no VM, and no inference. This is the bulk of the
 * telemetry test pyramid; see docs/observability-otel-metrics.md §11.
 *
 * The emitter takes INJECTED tracer/meter (never a global provider): required because
 * the suite runs under `--test-isolation=none` (a global provider would leak across
 * files), and the same seam as the opt-in / no-op design. A fresh provider + emitter
 * is built per test so the in-memory exporters never bleed between cases.
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
 * The in-memory ReadableSpan / metric data-point shapes are inspected loosely; typing
 * them fully against the SDK internals would add noise without catching bugs. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { createTelemetryHooks } from "../src/observability/index.ts";

/** Allowed metric label keys — the cardinality contract (§5.3). `run id` must NEVER appear. */
const ALLOWED_LABELS = new Set(["workflow", "job", "model", "result", "direction", "state", "phase"]);

interface Harness {
  hooks: any;
  spans: () => any[];
  metrics: () => Promise<Array<{ name: string; attributes: Record<string, unknown>; value: any }>>;
  shutdown: () => Promise<void>;
}

function makeHarness({ enabled = true }: { enabled?: boolean } = {}): Harness {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  const tracer = tracerProvider.getTracer("work-test");

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 2_147_483_647, // never auto-export; we force-flush on demand
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  const meter = meterProvider.getMeter("work-test");

  const hooks = createTelemetryHooks({ tracer, meter, enabled });

  return {
    hooks,
    spans: () => spanExporter.getFinishedSpans() as any[],
    async metrics() {
      await meterProvider.forceFlush();
      const out: Array<{ name: string; attributes: Record<string, unknown>; value: any }> = [];
      for (const rm of metricExporter.getMetrics())
        for (const sm of rm.scopeMetrics)
          for (const m of sm.metrics)
            for (const dp of m.dataPoints as any[]) out.push({ name: m.descriptor.name, attributes: dp.attributes, value: dp.value });
      return out;
    },
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

// ── canonical event drivers (a tiny ci-like run) ────────────────────────────────

/** A green `checks` job: install + a passing-or-failing typecheck step. */
function playChecksJob(h: any, { failTypecheck = false } = {}) {
  h.onJobStart("checks", { runsOn: "work:base", image: "work:base", arch: "arm64" });
  h.onStepStart("checks", "install", { kind: "run" });
  h.onStepEnd("checks", { name: "install", status: "success", exitCode: 0, stderr: "" });
  h.onStepStart("checks", "typecheck", { kind: "run" });
  h.onStepEnd("checks", {
    name: "typecheck",
    status: failTypecheck ? "failure" : "success",
    exitCode: failTypecheck ? 1 : 0,
    stderr: failTypecheck ? "tsc exited 1" : "",
  });
  // continue-on-error: a failed tool step does NOT fail the job.
  h.onJobEnd("checks", { id: "checks", status: "success" });
}

/** A `review` agent job: one `work/agent` step carrying token usage. */
function playReviewJob(h: any, jobId = "review__compiler__scan") {
  h.onJobStart(jobId, { runsOn: "work:base", image: "work:base", arch: "arm64" });
  h.onStepStart(jobId, "review compiler + spec", { kind: "uses", uses: "work/agent" });
  h.onStepEnd(jobId, {
    name: "review compiler + spec",
    status: "success",
    exitCode: 0,
    agent: { model: "claude-opus-4", usage: { inputTokens: 18200, outputTokens: 1450, requests: 3 }, setupMs: 30, runMs: 70 },
  });
  h.onJobEnd(jobId, { id: jobId, status: "success" });
}

const byName = (spans: any[], name: string) => spans.filter((s) => s.name === name);
const one = (spans: any[], name: string) => {
  const m = byName(spans, name);
  assert.equal(m.length, 1, `expected exactly one "${name}" span, got ${m.length}`);
  return m[0];
};
const spanId = (s: any) => s.spanContext().spanId;
const parentId = (s: any) => s.parentSpanContext?.spanId;

describe("observability emitter — Layer 1 (unit)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it("builds a run → job → step span tree with correct parent links", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playChecksJob(h.hooks);
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const spans = h.spans();
    const run = one(spans, "run ci");
    const job = one(spans, "job checks");
    const install = one(spans, "step install");

    assert.ok(!parentId(run), "run is the trace root (no parent)");
    assert.equal(parentId(job), spanId(run), "job parents to run");
    assert.equal(parentId(install), spanId(job), "step parents to job");
  });

  it("nests stage/provision/teardown phase spans under the job", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    h.hooks.onJobStart("checks", { runsOn: "work:base", image: "work:base", arch: "arm64" });
    h.hooks.onJobPhaseStart("checks", "stage");
    h.hooks.onJobPhaseEnd("checks", "stage");
    h.hooks.onJobPhaseStart("checks", "provision");
    h.hooks.onJobPhaseEnd("checks", "provision");
    h.hooks.onStepStart("checks", "install", { kind: "run" });
    h.hooks.onStepEnd("checks", { name: "install", status: "success", exitCode: 0, stderr: "" });
    h.hooks.onJobPhaseStart("checks", "teardown");
    h.hooks.onJobPhaseEnd("checks", "teardown");
    h.hooks.onJobEnd("checks", { id: "checks", status: "success" });
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const spans = h.spans();
    const job = one(spans, "job checks");
    for (const phase of ["stage", "provision", "teardown"]) {
      const ph = one(spans, phase);
      assert.equal(parentId(ph), spanId(job), `${phase} span parents to the job`);
      assert.equal(ph.attributes["work.job.phase"], phase);
    }
  });

  it("marks a failed provision phase ERROR with a phase-scoped error.type", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    h.hooks.onJobStart("checks", { runsOn: "work:base", image: "work:base" });
    h.hooks.onJobPhaseStart("checks", "provision");
    h.hooks.onJobPhaseEnd("checks", "provision", { error: "qemu: could not boot the guest" });
    h.hooks.onJobEnd("checks", { id: "checks", status: "failure" });
    h.hooks.onWorkflowEnd({ name: "ci", status: "failure" });

    const ERROR = 2; // SpanStatusCode.ERROR
    const prov = one(h.spans(), "provision");
    assert.equal(prov.status.code, ERROR);
    assert.equal(prov.attributes["error.type"], "provision_error");
  });

  it("emits the run span as a true root (empty parent) so backends recognize the trace root", () => {
    // Regression guard: a run span parented on a synthetic, never-emitted "anchor"
    // leaves the trace with no empty-parent span. Tempo (and every OTLP backend)
    // detects the root as the span whose parent is empty, so such a trace is
    // permanently rootless — "<root span not yet received>" / no name / no timeline
    // placement in Tempo Drilldown, while single-trace-by-id views still render fine.
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playChecksJob(h.hooks);
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const run = one(h.spans(), "run ci");
    assert.ok(!parentId(run), `run span must be a true root (empty parent), got parent=${parentId(run)}`);
  });

  it("sets cicd.* / work.* / host.image.* attributes at the right levels", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playChecksJob(h.hooks);
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const spans = h.spans();
    const run = one(spans, "run ci");
    assert.equal(run.attributes["cicd.pipeline.name"], "ci");
    assert.equal(run.attributes["work.run.id"], "4f9a2c");
    assert.equal(run.attributes["cicd.pipeline.result"], "success");

    const job = one(spans, "job checks");
    assert.equal(job.attributes["work.job.name"], "checks");
    assert.equal(job.attributes["host.image.name"], "work:base");
    assert.equal(job.attributes["host.arch"], "arm64");
  });

  it("emits a chat {model} child span with gen_ai.* from the agent usage", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playReviewJob(h.hooks);
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const spans = h.spans();
    const step = one(spans, "step review compiler + spec");
    const chat = one(spans, "chat claude-opus-4");
    assert.equal(parentId(chat), spanId(step), "chat span parents to its step");
    assert.equal(chat.attributes["gen_ai.operation.name"], "chat");
    assert.equal(chat.attributes["gen_ai.provider.name"], "anthropic");
    assert.equal(chat.attributes["gen_ai.request.model"], "claude-opus-4");
    assert.equal(chat.attributes["gen_ai.usage.input_tokens"], 18200);
    assert.equal(chat.attributes["gen_ai.usage.output_tokens"], 1450);
  });

  it("splits the agent step into setup vs model time (attributes, no extra span)", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playReviewJob(h.hooks);
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const spans = h.spans();
    const step = one(spans, "step review compiler + spec");
    const chat = one(spans, "chat claude-opus-4");
    // The split lives as attributes on the existing chat span — no new spans.
    assert.equal(chat.attributes["work.agent.setup_ms"], 30);
    assert.equal(chat.attributes["work.agent.run_ms"], 70);
    assert.equal(byName(spans, "chat claude-opus-4").length, 1, "no extra agent child spans");
    // The chat span starts at/after the step start (narrowed past the setup window).
    const ms = (s: any) => s.startTime[0] * 1000 + s.startTime[1] / 1e6;
    assert.ok(ms(chat) >= ms(step) - 1, "chat span starts no earlier than its step");
  });

  it("marks a failed step ERROR with error.type, but the continue-on-error job stays success", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playChecksJob(h.hooks, { failTypecheck: true });
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const spans = h.spans();
    const ERROR = 2; // SpanStatusCode.ERROR
    const step = one(spans, "step typecheck");
    assert.equal(step.status.code, ERROR);
    assert.equal(step.attributes["error.type"], "exit_1");
    assert.equal(step.attributes["work.step.result"], "failure");

    const job = one(spans, "job checks");
    assert.notEqual(job.status.code, ERROR, "continue-on-error: the job is not ERROR");
    assert.equal(job.attributes["cicd.pipeline.task.run.result"], "success");
  });

  it("links a fan-in job span to its upstream job spans (needs)", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playChecksJob(h.hooks);
    h.hooks.onJobStart("test", { runsOn: "work:nested", image: "work:nested", needs: ["checks"] });
    h.hooks.onJobEnd("test", { id: "test", status: "success" });
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const spans = h.spans();
    const checks = one(spans, "job checks");
    const test = one(spans, "job test");
    const linked = (test.links ?? []).some((l: any) => l.context?.spanId === spanId(checks));
    assert.ok(linked, "fan-in job links to its upstream job span");
  });

  it("parents step spans correctly when two jobs' events interleave (concurrency)", () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    // Interleave: A starts, B starts, A's step runs while B is open, B's step runs.
    h.hooks.onJobStart("a", { runsOn: "work:base", image: "work:base" });
    h.hooks.onJobStart("b", { runsOn: "work:base", image: "work:base" });
    h.hooks.onStepStart("a", "sa", { kind: "run" });
    h.hooks.onStepStart("b", "sb", { kind: "run" });
    h.hooks.onStepEnd("a", { name: "sa", status: "success", exitCode: 0 });
    h.hooks.onStepEnd("b", { name: "sb", status: "success", exitCode: 0 });
    h.hooks.onJobEnd("a", { id: "a", status: "success" });
    h.hooks.onJobEnd("b", { id: "b", status: "success" });
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const spans = h.spans();
    // Each step must parent to ITS OWN job — proving Map<jobId,ctx>, not ambient context.
    assert.equal(parentId(one(spans, "step sa")), spanId(one(spans, "job a")));
    assert.equal(parentId(one(spans, "step sb")), spanId(one(spans, "job b")));
  });

  it("records run/step counters and duration histograms with the right labels", async () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playChecksJob(h.hooks, { failTypecheck: true });
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const metrics = await h.metrics();
    const find = (name: string, match: (a: any) => boolean) => metrics.find((m) => m.name === name && match(m.attributes));

    assert.ok(find("work.runs", (a) => a.workflow === "ci" && a.result === "success"), "run counter");
    assert.ok(find("work.steps", (a) => a.job === "checks" && a.result === "failure"), "failed-step counter");
    const runDur = metrics.find((m) => m.name === "work.run.duration");
    assert.ok(runDur && runDur.value.count >= 1 && runDur.value.sum >= 0, "run duration histogram recorded");
  });

  it("balances work.jobs.in_flight back to zero after the run", async () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playChecksJob(h.hooks);
    playReviewJob(h.hooks);
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const metrics = await h.metrics();
    const inFlight = metrics.filter((m) => m.name === "work.jobs.in_flight");
    for (const dp of inFlight) assert.equal(dp.value, 0, "every in_flight series settles to 0");
  });

  it("counts agent tokens by direction equal to the reported usage", async () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playReviewJob(h.hooks); // 18200 in / 1450 out
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const metrics = await h.metrics();
    const tok = (dir: string) =>
      metrics.find((m) => m.name === "work.agent.tokens" && m.attributes.model === "claude-opus-4" && m.attributes.direction === dir);
    assert.equal(tok("input")?.value, 18200);
    assert.equal(tok("output")?.value, 1450);
  });

  it("never puts an unbounded id on a metric label (cardinality guard)", async () => {
    h.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
    playChecksJob(h.hooks);
    playReviewJob(h.hooks);
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });

    const metrics = await h.metrics();
    for (const m of metrics)
      for (const key of Object.keys(m.attributes))
        assert.ok(ALLOWED_LABELS.has(key), `metric "${m.name}" carries disallowed label "${key}"`);
  });

  it("is a no-op when disabled: no spans, no throw", () => {
    const off = makeHarness({ enabled: false });
    try {
      off.hooks.onWorkflowStart({ runId: "4f9a2c", workflow: "ci" });
      playChecksJob(off.hooks, { failTypecheck: true });
      off.hooks.onWorkflowEnd({ name: "ci", status: "success" });
      assert.equal(off.spans().length, 0, "disabled emitter produces no spans");
    } finally {
      void off.shutdown();
    }
  });

  // ── Phase 4: the no-op re-drive guard ──────────────────────────────────────────

  it("suppresses a no-op re-drive (resumed run that executes zero jobs)", async () => {
    h.hooks.onWorkflowStart({ runId: "redrive-1", workflow: "ci", resumed: true });
    // No jobs run — e.g. `work serve` re-claiming an already-finished run on startup.
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });
    assert.equal(h.spans().length, 0, "a no-op re-drive emits no spans");
    const metrics = await h.metrics();
    assert.equal(metrics.find((m) => m.name === "work.runs"), undefined, "and no run counter");
  });

  it("marks + counts a genuine resume that re-runs work", async () => {
    h.hooks.onWorkflowStart({ runId: "resume-1", workflow: "ci", resumed: true });
    playChecksJob(h.hooks); // a job actually executes
    h.hooks.onWorkflowEnd({ name: "ci", status: "success" });
    assert.equal(one(h.spans(), "run ci").attributes["work.run.resumed"], true);
    const metrics = await h.metrics();
    const resumes = metrics.find((m) => m.name === "work.run.resumes" && m.attributes.workflow === "ci");
    assert.equal(resumes?.value, 1);
  });
});
