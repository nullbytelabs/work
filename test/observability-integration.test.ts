/**
 * Observability — Layer 2 (integration). The emitter driven by the REAL runtime hook
 * stream, through `startRun` with an injected in-memory telemetry handle and the
 * HostTarget double (no VM, no inference). Where the Layer 1 unit spec feeds the
 * emitter synthetic payloads, this proves the runtime actually fires the enriched
 * hooks — workflow start/end, job `host.image`/`needs`, step `kind` — and that the
 * full run→job→step tree (incl. continue-on-error + fan-in links) comes out right.
 * See docs/observability-otel-metrics.md §11.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory ReadableSpan shapes are inspected loosely. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { startRun } from "../src/run.ts";
import { AbsurdRuntime, createAbsurdEngine, type UsesHandler } from "../src/runtime/index.ts";
import { createTelemetryHooks } from "../src/observability/index.ts";
import { createWorkHandler, type AgentRunner } from "../src/agent/index.ts";
import type { PiWorkflowsConfig } from "../src/config/index.ts";
import { hostTargetFactory } from "./_support.ts";

const WORKFLOW = `
name: obs-itest
jobs:
  a:
    steps:
      - name: ok
        run: echo hi
      - name: boom
        continue-on-error: true
        run: exit 3
  b:
    needs: [a]
    steps:
      - name: done
        run: echo done
`;

// A shared TelemetryHandle backed by in-memory exporters. startRun builds its own
// per-run emitter from this handle's tracer/meter (exactly like the server injects one).
function inMemoryTelemetry() {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  const noopInstrument = () => ({ add() {}, record() {} });
  return {
    handle: {
      tracer: tracerProvider.getTracer("obs-itest"),
      // metrics aren't asserted here (Layer 1 covers them) — a no-op meter is enough.
      meter: { createCounter: noopInstrument, createUpDownCounter: noopInstrument, createHistogram: noopInstrument } as any,
      shutdown: () => tracerProvider.shutdown(),
    },
    spans: () => spanExporter.getFinishedSpans() as any[],
  };
}

const one = (spans: any[], name: string) => {
  const m = spans.filter((s) => s.name === name);
  assert.equal(m.length, 1, `expected exactly one "${name}" span, got ${m.length}`);
  return m[0];
};

describe("observability — Layer 2 (runtime integration)", () => {
  it("emits the run→job→step tree from the real hook stream, with image/kind/links and continue-on-error", async () => {
    const plan = compile(parseWorkflow(WORKFLOW));
    const workdir = await mkdtemp(join(tmpdir(), "obs-itest-"));
    const { handle, spans } = inMemoryTelemetry();
    try {
      const result = await startRun({ plan, workdir, makeTarget: hostTargetFactory, telemetry: handle });
      assert.equal(result.status, "success");

      const s = spans();
      // Run root, from onWorkflowStart/End.
      const run = one(s, "run obs-itest");
      assert.equal(run.attributes["cicd.pipeline.name"], "obs-itest");
      assert.equal(run.attributes["cicd.pipeline.result"], "success");

      // Job meta threaded by the runtime: the VM image is the (default) runs-on.
      const jobA = one(s, "job a");
      assert.equal(jobA.attributes["host.image.name"], "work:base");

      // Step kind threaded by the runtime.
      assert.equal(one(s, "step ok").attributes["work.step.kind"], "run");

      // continue-on-error: the failed step is ERROR, but job a rolls up success.
      const boom = one(s, "step boom");
      assert.equal(boom.status.code, 2); // SpanStatusCode.ERROR
      assert.equal(boom.attributes["error.type"], "exit_3");
      assert.equal(jobA.attributes["cicd.pipeline.task.run.result"], "success");

      // fan-in: job b needs a → span link to a's span.
      const jobB = one(s, "job b");
      const linked = (jobB.links ?? []).some((l: any) => l.context?.spanId === jobA.spanContext().spanId);
      assert.ok(linked, "job b links to upstream job a");

      // parent chain: step parents to its job, job to the run.
      assert.equal(jobA.parentSpanContext?.spanId, run.spanContext().spanId);
      assert.equal(boom.parentSpanContext?.spanId, jobA.spanContext().spanId);
    } finally {
      await handle.shutdown();
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("emits a chat {model} span with gen_ai.usage.* for a work/agent step (token capture)", async () => {
    const config: PiWorkflowsConfig = {
      providers: { anthropic: { baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test" } },
      models: { opus: { provider: "anthropic", model: "claude-opus-4" } },
      defaultModel: "opus",
    };
    // A runner that reports usage (no inference) — stands in for the in-guest Pi loop.
    const runner: AgentRunner = {
      async run() {
        return { text: "reviewed", usage: { inputTokens: 2200, outputTokens: 180, requests: 4 } };
      },
    };
    const plan = compile(parseWorkflow(`
name: agent-obs
jobs:
  review:
    steps:
      - name: scan
        uses: work/agent
        with:
          prompt: review this
`));

    const handlers: UsesHandler[] = [];
    const dispatch = (sub: { uses: string }) => {
      const h = handlers.find((x) => x.scheme === sub.uses.split("/", 1)[0]);
      return h ? h.run(sub as never) : Promise.resolve({ status: "failure" as const });
    };
    handlers.push(createWorkHandler({ config, runner, dispatch }));

    const engine = await createAbsurdEngine();
    const workRoot = await mkdtemp(join(tmpdir(), "agent-obs-"));
    const { handle, spans } = inMemoryTelemetry();
    try {
      const rt = new AbsurdRuntime({ engine, usesHandlers: handlers, makeTarget: hostTargetFactory });
      const hooks = createTelemetryHooks({ tracer: handle.tracer, meter: handle.meter });
      const result = await rt.run(plan, { workRoot, hooks, runId: "agent-obs-1" });
      assert.equal(result.status, "success");

      const s = spans();
      const step = one(s, "step scan");
      assert.equal(step.attributes["work.step.kind"], "uses");
      assert.equal(step.attributes["work.step.uses"], "work/agent");

      const chat = one(s, "chat claude-opus-4");
      assert.equal(chat.parentSpanContext?.spanId, step.spanContext().spanId);
      assert.equal(chat.attributes["gen_ai.provider.name"], "anthropic");
      assert.equal(chat.attributes["gen_ai.request.model"], "claude-opus-4");
      assert.equal(chat.attributes["gen_ai.usage.input_tokens"], 2200);
      assert.equal(chat.attributes["gen_ai.usage.output_tokens"], 180);
    } finally {
      await handle.shutdown();
      await engine.close();
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
