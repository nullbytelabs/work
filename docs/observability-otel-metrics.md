# Observability: OpenTelemetry traces + Prometheus metrics

A design record for instrumenting `work` with rich, standards-based telemetry:
**OpenTelemetry distributed traces** (a span tree per run) and **OpenTelemetry metrics**
(the usual counters/gauges/histograms). The goal is that every run emits a
trace rooted at the workflow and keyed by its run id, with jobs and steps as nested
spans carrying the metadata that matters — VM image, agent model, token usage,
success/failure, durations — and that both signals push over OTLP to a Grafana Alloy
collector that forwards traces to **Tempo** and metrics to **Prometheus**.

This record captures the research (the current OTel JS API surface, the relevant
semantic conventions, and prior art from durable orchestrators) and the design that
falls out of it. It is written for contributors; it is not user documentation.

**Committed backend (happy path).** `work` emits **OTLP only** — traces *and* metrics
pushed over OTLP to a **Grafana Alloy** collector, which forwards traces to **Tempo** and
metrics to **Prometheus** (remote-write). There is no `/metrics` HTTP endpoint on `work`
and no second metrics path: one OTLP exporter, one collector, two backends. Alternative
backends/exporters (Jaeger, an in-process Prometheus scrape endpoint, `prom-client`, a
deterministic-ID tracer) were considered and are explicitly out of scope here — see §4.4
and §5 for why, and git history for the menu. See **§9** for the topology and a concrete
Alloy config.

---

## 1. Why, and what "fully instrumented" means here

`work` already has the two things that make observability cheap to add and expensive to
omit: a clean **hooks seam** that every run drives (`RunHooks`, `src/runtime/types.ts:43`),
and a **durable journal** (Absurd + PGLite) that already knows the true lifecycle of every
job and step. We want to project that lifecycle onto OTLP and let **Alloy → Tempo +
Prometheus** do the rest, landing in the operator's existing Grafana stack.

Concretely, "fully instrumented" is:

- **Traces.** One trace per run. Root span named by the workflow, carrying `work.run.id`.
  Child span per job; grandchild span per step; for agent steps, a great-grandchild
  `chat {model}` span carrying GenAI attributes (model, token usage). Status, duration,
  and outcome on every span. Pushed via OTLP to Alloy → Tempo.
- **Metrics.** Counters for runs/jobs/steps by outcome, histograms for run/job/step
  durations, an up/down counter for in-flight jobs, and agent token/request counters —
  pushed via OTLP (a periodic exporting reader) to Alloy, which remote-writes them to
  Prometheus. No HTTP endpoint on `work`.
- **Off by default, zero-overhead when off.** The package must not force an OTel runtime
  on users who don't opt in (see §7).

This sits alongside the existing telemetry consumers, not on top of them. The TUI presenter
and the web SSE sink are already "pure consumers of runtime hooks" (per `AGENTS.md`); the
OTel emitter is **a third hook consumer**, composed in at `startRun` exactly the
same way. That is the whole architectural thesis: *observability is a composition-root
concern wired at the hooks seam, not a change to the durable core.*

---

## 2. The seam: hooks, and what they lack today

`RunHooks` (`src/runtime/types.ts:43-50`) is the single event stream:

```ts
export interface RunHooks {
  onJobStart?: (jobId: string) => void;
  onStepStart?: (jobId: string, stepName: string) => void;
  onOutput?: (jobId: string, stepName: string, chunk: { stream; text }) => void;
  onStepEnd?: (jobId: string, result: StepResult) => void;
  onJobEnd?: (jobId: string, result: JobResult) => void;
}
```

They fire from the runtime at exactly the right points
(`src/runtime/absurd/runtime.ts`: job start/end ~`562`/`593`, step start/end ~`530`/`545`).
But the payloads are **presentation-grade, not telemetry-grade** — they were shaped for a
log/board UI, so they carry names and statuses but not the dimensions we want as span
attributes and metric labels. The gaps:

1. **No workflow-level hook.** There is no `onWorkflowStart`/`onWorkflowEnd`; the root span
   and the run-duration histogram have no natural fire point. The TUI infers run boundaries
   from the first/last job. A tracer needs explicit run boundaries (and the run id, which is
   on `RunContext.runId` but not passed to any hook).
2. **No job metadata.** `onJobStart` passes only `jobId`. We want `runs-on`, the resolved
   **VM image** (`src/run.ts:156-161` resolves it via `ensureImageTag`), and matrix values.
3. **No step kind.** `onStepStart` passes `(jobId, stepName)`; we want `run:` vs `uses:` and
   the action name to set `work.step.kind` / span naming.
4. **No agent metadata.** The model and token usage of an agent step are entirely absent from
   the hook stream — and token usage isn't even captured upstream yet (see §6).

**Design choice.** Extend `RunHooks` with `onWorkflowStart(meta)` / `onWorkflowEnd(result)`
and enrich the existing payloads (a `JobMeta` on `onJobStart`, step kind on `onStepStart`,
optional `agent: { model, usage }` on the agent step's `StepResult`). This is a contained
core change that passes the deletion test (`AGENTS.md`): richer lifecycle events are
independently worth having — the TUI and web layers can use the same metadata — and the
seam already exists; we are widening a contract, not inventing a subsystem. The emitter
itself lives in a new `src/observability/` module that implements `RunHooks` and is added to
the hook fan-out in `startRun` (`src/run.ts`).

---

## 3. Trace model

### 3.1 Topology

```
run {workflow}                         span, SpanKind.SERVER     work.run.id, cicd.pipeline.*
└─ job {job}                           span, SpanKind.INTERNAL   work.job.*, host.image.*, runs-on
   └─ step {step}                      span, SpanKind.INTERNAL   work.step.*, cicd.pipeline.task.*
      └─ chat {model}   (agent steps)  span, SpanKind.INTERNAL   gen_ai.*
```

Three structural levels (run → job → step) plus a GenAI leaf for agent steps. This is the
hierarchy every comparable engine converges on (Temporal workflow→activity, Airflow
dag_run→task_instance, Argo workflow→node, the GH-Actions OTel exporters run→job→step), and
it is exactly what the OpenTelemetry **CI/CD semantic conventions** model.

### 3.2 Span names — low cardinality, detail in attributes

OTel's naming rule is "the most general string that identifies an interesting *class* of
spans" — per-instance values (run ids, step indices) go in attributes, never the name. So:

- run span: `run {workflow}` (the CICD convention is `{action} {pipeline}`; `run` is our action)
- job span: `job {job}`
- step span: `step {step}`
- agent span: `chat {model}` (the GenAI convention: `{gen_ai.operation.name} {gen_ai.request.model}`)

### 3.3 Attributes — adopt standard conventions, namespace the rest as `work.*`

Use standard semconv keys wherever one exists so any OTel-aware backend renders our runs as
first-class CI/CD pipelines and our agent calls as first-class LLM spans, and reserve a
`work.*` namespace for engine concepts that have no convention.

**Run + job spans — CI/CD semconv (`cicd.*`).** These are Release-Candidate on `main`
(Development in the latest tagged release) — stable enough to adopt, unstable enough to pin
deliberately and re-check on upgrade.

| Span | Key | Value |
|---|---|---|
| run | `cicd.pipeline.name` | workflow name |
| run | `cicd.pipeline.run.id` | run id (also mirrored to `work.run.id`) |
| run | `cicd.pipeline.result` | `success` / `failure` / `cancellation` (← our `interrupted`) |
| job | `cicd.pipeline.task.name` | job id |
| job | `cicd.pipeline.task.run.id` | `${runId}:${jobId}` (the Absurd idempotency key, `runtime.ts:351`) |
| job | `cicd.pipeline.task.run.result` | `success` / `failure` / `skip` |

The CICD convention only standardizes **two** levels (pipeline → task), and `task` has no
`other` type and no per-task run-state lifecycle. So **steps are not a standard tier** — they
get the `work.*` namespace. Map workflow→pipeline, job→task; everything finer is ours.

**Step spans + engine domain — `work.*`** (valid app-scoped prefix; lowercase, dotted
namespaces, snake_case segments, don't shadow an existing OTel namespace):

`work.run.id`, `work.workflow.name`, `work.job.name`, `work.step.name`, `work.step.index`,
`work.step.kind` (`run` | `uses`), `work.step.uses` (e.g. `work/agent`, `action/review`),
`work.matrix.<key>` for matrix dimensions, `work.run.resumed` (bool, set on a resumed run).

**VM image — `host.*`, not `container.*`.** A gondolin micro-VM is a *host*, not an OCI
container. OTel defines `host.image.name` literally as "the name of the VM image or OS
install" — the correct home for the resolved `work:<image>` tag. Set `host.image.name` and
`host.arch` on the job span (and/or as resource attributes if a run is single-image). Do
**not** use `container.image.*` (semantically wrong) and note there is no `vm.*` namespace.

**Agent steps — GenAI semconv (`gen_ai.*`).** Two load-bearing gotchas, both verified
against the live spec:

- The GenAI conventions **moved** to the `open-telemetry/semantic-conventions-genai` repo and
  are all **Development** (untagged, track `main`).
- `gen_ai.system` is **deprecated** → use **`gen_ai.provider.name`** (value `anthropic` for
  Claude). The token attributes were **renamed**: it is **`gen_ai.usage.input_tokens`** /
  **`gen_ai.usage.output_tokens`** now (not `prompt_tokens`/`completion_tokens`). Do not pin
  to the dead names.

| Key | Value |
|---|---|
| `gen_ai.operation.name` | `chat` |
| `gen_ai.provider.name` | `anthropic` (from the resolved provider) |
| `gen_ai.request.model` | requested model, e.g. `claude-opus-4` |
| `gen_ai.response.model` | model that answered (if surfaced) |
| `gen_ai.usage.input_tokens` | input tokens (see §6 — not captured yet) |
| `gen_ai.usage.output_tokens` | output tokens (see §6) |

### 3.4 Failure modeling

Outcome is a **span attribute**, not span existence. A skipped step is a clean span with
`result=skip` — not an error. On genuine failure:

1. Set span **Status = ERROR** (leave it `Unset` on success; do not set `Ok` from
   instrumentation).
2. Set **`error.type`** (Stable semconv) to a **low-cardinality class** — an exit-code class
   (`exit_1`) or exception class name, never the error *message*. Omit it on success. Mirror
   the same `error.type` onto the error counter so span and metric agree.
3. Record the exception **once** (`span.recordException`, or a log record — the spec is
   migrating exception capture from span events to logs; a span event is fine for now).

**Retries do not each spawn a sibling error span** (Temporal's hard-won lesson — it added a
specific guard against per-failed-attempt span storms). If/when `work` adds step retries,
model an attempt as a child span with a `work.step.attempt` attribute, or as events on the
step span — not as N top-level error spans.

---

## 4. The hard part: traces across resume

A run can be torn out mid-flight (`WorkflowResult.status: "interrupted"`,
`src/runtime/types.ts:31-41`) and resumed later **in a new process** (`work resume <id>`).
Naïve tracing breaks here: the original process's root and in-flight job spans are live
objects in memory that the resumed process cannot reattach to.

The good news is that this engine's durability model does most of the work for us, and the
prior-art pattern (Temporal, Airflow) tells us how to close the gap.

### 4.1 What the journal already gives us for free

Each step is a memoized `ctx.step(name, fn)` checkpoint; each job is idempotent on
`${runId}:${jobId}`. **On resume, completed steps are not re-executed — their `fn` never
runs, so `onStepStart`/`onStepEnd` never re-fire.** That is *exactly* the "skip-emission-on-
replay" behavior Temporal implements by hand (`_ReplaySafeSpan.end()` returns early during
replay): work already journaled complete must not re-emit its span. We get it for free
because we memoize rather than replay. So:

- A step that finished in the first process emitted its (short-lived) span there and **will
  not** emit again on resume. No duplicates.
- A step that was in-flight at the crash was *not* journaled complete → it re-runs fully on
  resume → its hooks fire → it emits one clean span in the resumed process. No orphan.

The per-step and per-job spans therefore come out clean across a crash **without any
deterministic-ID machinery**, as long as the resumed spans can find their parent.

### 4.2 Continuing the trace

> **Status.** The run span is a **true root span** (`root: true`, empty parent). OTLP backends
> identify a trace's root as its empty-parent span and source the trace's service name, root
> name, and timeline placement from it — so a real root is load-bearing, not cosmetic. Each run
> attempt is its own trace, correlated by `work.run.id`; resumed runs carry `work.run.resumed=true`
> and bump `work_run_resumes_total`. **Coalescing a resumed run's separate attempts into one
> trace is not done today** — the persist/restore design below is the way to add it when wanted.
> **No-op re-drive guard:** a resumed run that executes **zero** jobs (a worker re-claiming an
> already-finished run on `work serve` startup) emits nothing — the root span is left un-ended
> (so never exported) and no run counter fires, killing the phantom sub-100ms "success" traces.
>
> *Guardrail:* do **not** pin the trace id by parenting the run span on a synthetic,
> never-emitted "anchor" `SpanContext`. It leaves the trace with no empty-parent span, so Tempo
> reports it as rootless (`<root span not yet received>`) and drops it from list/timeline views,
> even though single-trace-by-id rendering still looks fine. Trace continuity belongs in
> persistence (below), not in a derived id.

The one thing that doesn't survive a crash is the **long-lived root span** (and any job span
open at the moment of the tear-out): with a `BatchSpanProcessor`, a span is only exported on
`end()`, so a span still open when the process dies is simply never exported — it vanishes
rather than corrupting anything. To keep the resumed work under the *same* trace, persist the
run-root's `SpanContext` when the run starts and restore it on resume:

The durable home is already there and shared by every resumable run: the **orchestrator
task's checkpoint** in the Absurd journal — the same `ctx.step()` checkpoint store that holds
step results (`c_<queue>`, idempotent on `(task_id, checkpoint_name)`). Persistence is gated on
persistent vs ad-hoc, *not* CLI vs web: a `.workflows/` project run (CLI or web) persists to
`.workflows/db` (`cli.ts:672-677`, `server.ts:95-114`); only an ad-hoc bare-file run is
in-memory, and resume is refused for those anyway (`--resume needs a .workflows/ project`). So
checkpoint the root SpanContext once at run start and it rides resume for free, for both paths:

```ts
// at run start — checkpoint the root SpanContext like any other step result
const sc = await ctx.step("otel:root-span-context", async () => {
  const { traceId, spanId, traceFlags } = rootSpan.spanContext();
  return { traceId, spanId, traceFlags };
});

// on resume — the checkpoint replays its stored value; rebuild a non-recording parent
const parent = trace.wrapSpanContext({ ...sc, isRemote: true });
const resumeCtx = trace.setSpan(context.active(), parent);
// new job/step spans are created with resumeCtx as their explicit parent
```

New work in the resumed process parents onto the restored context, so the resumed spans share
the original `traceId` — the backend stitches them into one trace keyed by `work.run.id`. Set
`work.run.resumed=true` on the resumed run's spans, and optionally add a **span link** from the
resumed root to the crashed root to document the "attempt N continues attempt N-1" causality
(links are the right tool for that non-hierarchical edge).

### 4.3 The known caveat, stated honestly

With this approach the **crashed attempt's root/in-flight-job spans are lost** (never
exported), so a resumed trace shows the original completed steps, then the resumed steps, with
a fresh root rather than a single root span whose duration spans the crash. This is standard
and acceptable — viewers render the trace by `traceId`, and the run-level wall-clock truth
lives in the `work.run.duration` metric and the run record, not in a single span. We are not
inventing a span timeline; we are reflecting that the run genuinely ran in two acts.

### 4.4 The alternative we are *not* adopting (yet)

The fully-robust option is Temporal/Airflow's **deterministic IDs from durable state**: derive
`traceId` from the run id and each `spanId` from the step's stable journal key, via a custom
OTel `IdGenerator`, so any process reconstructs byte-identical IDs and can re-emit a perfect
tree. It removes the §4.3 caveat entirely. We defer it because (a) §4.1+§4.2 already yields a
correct, non-duplicated trace for the common case, and (b) the JS `IdGenerator` is a
provider-global, so seeding it per-span needs an `AsyncLocalStorage` dance (Temporal uses a
workflow-scoped RNG) that is real complexity to add. Capture it here as the escalation path if
resumed-trace fidelity ever needs to be perfect.

### 4.5 Parallel jobs — explicit parent context, never ambient

Independent jobs run concurrently (the orchestrator fans out via `Promise.all`,
`runtime.ts:370`). The OTel active-context stack (`AsyncLocalStorage`) does **not** reliably
survive `Promise.all` fan-out or the durable-task boundary, so **do not** rely on
`context.active()` to parent job spans. Capture the root context once and pass it explicitly as
the third arg to `startSpan`:

```ts
const rootCtx = trace.setSpan(context.active(), rootSpan);
// per job, parented deterministically regardless of the async stack:
const jobSpan = tracer.startSpan(`job ${job.id}`, { kind: SpanKind.INTERNAL }, rootCtx);
const jobCtx  = trace.setSpan(rootCtx, jobSpan);
// per step in that job, parent = jobSpan:
const stepSpan = tracer.startSpan(`step ${step.name}`, {}, jobCtx);
```

Because the emitter is hook-driven and the hooks are keyed by `jobId`, the emitter keeps a
`Map<jobId, { span, ctx }>` so `onStepStart` can find its job's context without any ambient
state. For a `needs` fan-in, prefer a **span link** to the upstream job spans over pretending
one upstream is the parent.

---

## 5. Metrics model

### 5.1 OTel metrics API, pushed over OTLP

We use the OTel metrics API (`@opentelemetry/api` + `@opentelemetry/sdk-metrics`) with a
**`PeriodicExportingMetricReader`** feeding an **OTLP metrics exporter**
(`@opentelemetry/exporter-metrics-otlp-proto`) — the same OTLP push that carries traces, to the
same Alloy endpoint. `prom-client` and the in-process Prometheus scrape endpoint
(`@opentelemetry/exporter-prometheus`) are **not** used: with Alloy in front, `work` need not be
a scrape target, so it exposes no HTTP metrics surface at all.

Why this falls out cleanly:

- **One instrument API, one `Resource`, one lifecycle** across traces *and* metrics — consistent
  `service.name`/`service.version`, one SDK to start/stop.
- **CLI runs report too.** A push reader flushes on the periodic tick and on shutdown
  (`forceFlush` before `sdk.shutdown()`), so a one-shot `work run` exports its metrics before the
  process exits — no scrape window needed. (The earlier scrape design couldn't do this; push
  removes the CLI-vs-server split entirely.)
- **Exemplars** linking metric buckets to trace ids flow natively over OTLP (we hold the active
  span at `record()` time) — no OpenMetrics-format or `--enable-feature=exemplar-storage` dance,
  because the link rides OTLP to Tempo/Prometheus rather than a scrape.

OTel auto-appends `_total`/unit suffixes, so the wire names land as the Prometheus names in §5.2
after Alloy's OTLP→Prometheus conversion; histogram buckets are set via a `View` (§5.4). Set a
sane export interval (e.g. 15s) so a short run still ticks at least once before its shutdown
flush.

### 5.2 Metric catalog

Names follow Prometheus conventions (base units, `_total` on counters, `_seconds` on
durations). OTel instrument names use dots (`work.runs`, `work.run.duration` with unit `s`);
Alloy's OTLP→Prometheus conversion emits the wire names shown.

| Wire metric | Type | Labels | Meaning |
|---|---|---|---|
| `work_runs_total` | counter | `workflow`, `result` | runs completed by outcome |
| `work_jobs_total` | counter | `workflow`, `job`, `result` | jobs completed by outcome |
| `work_steps_total` | counter | `workflow`, `job`, `result` | steps completed by outcome |
| `work_run_duration_seconds` | histogram | `workflow`, `result` | run wall-clock |
| `work_job_duration_seconds` | histogram | `workflow`, `job`, `result` | job wall-clock |
| `work_step_duration_seconds` | histogram | `job`, `result` | step wall-clock |
| `work_jobs_in_flight` | UpDownCounter | `workflow` | currently-running jobs (vs the concurrency cap) |
| `work_run_resumes_total` | counter | `workflow` | crash-resumes (durable-engine-specific) |
| `work_agent_requests_total` | counter | `model`, `result` | agent model calls |
| `work_agent_tokens_total` | counter | `model`, `direction` (`input`/`output`) | token usage |
| `work_agent_request_duration_seconds` | histogram | `model`, `result` | agent call latency |

For the agent token histogram we can additionally emit the GenAI-semconv
`gen_ai.client.token.usage` (histogram, attr `gen_ai.token.type`) for portability; the
`work_agent_tokens_total` counter is the friendlier Prometheus-native view.

### 5.3 Cardinality rules (non-negotiable)

- **OK as labels** (bounded): `workflow`, `job`, `model`, `result`, `direction`. Treat
  `workflow`/`job` as *moderate* cardinality — Argo's metrics docs carry explicit warnings
  about per-name series blowup; fine at our scale, worth a note.
- **NEVER as labels** (unbounded): `run id`, `job execution id`, `step id`, `trace id`,
  prompts, paths. One id-label = one new time series per execution, forever. Run/step identity
  lives on **spans and exemplars**, not metric labels.

### 5.4 Histogram buckets

Durations span sub-second steps to multi-minute jobs, so the OTel default buckets (top out
~10s) are useless here. Use one shared explicit set (seconds):

```
[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800]
```

Set it via a `View` on the metric provider:

```ts
new View({
  instrumentName: 'work.*.duration',
  aggregation: new ExplicitBucketHistogramAggregation(
    [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800]),
})
```

No HTTP endpoint and no CLI-vs-server caveat: the push reader (§5.1) covers both a long-lived
`work serve` / `--web` process and a one-shot `work run`, and `work` exposes no scrape surface.

---

## 6. The token-capture gap (must close for the headline feature)

Capturing "what tokens were sent and received" is called out as very important — and it is the
one piece **not currently wired**. The agent result type carries only text and a finish reason
(`src/agent/index.ts:40-44`), the in-guest wrapper scrapes only the last assistant message's
text + `stopReason` and writes `{ text, finishReason }` (`guest-runner-script.mjs:112-124`), and
the host runner parses only `text`/`finishReason`/`error` (`guest-pi-runner.ts:186-194`). Pi's
usage data is dropped on the floor.

**The source is confirmed available.** Pi (`@earendil-works/pi-coding-agent@0.79.3`) exposes
`session.getSessionStats()`, whose `.tokens` is **cumulative over the whole loop** (every model
call, including compacted summaries):

```ts
// dist/core/agent-session.d.ts — SessionStats
tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
// also: assistantMessages, toolCalls  → a real model-call count for work_agent_requests_total
```

So a single `getSessionStats()` call after the loop gives the step's full token accounting — no
per-message summation needed. (Usage is normalized by `pi-ai` regardless of provider; under our
`api: "openai-completions"` registration `input`/`output` are always populated from
`prompt_tokens`/`completion_tokens`, while `cacheRead`/`cacheWrite` are best-effort — `0` when
the endpoint doesn't return cache fields.)

Closing it is a vertical slice:

1. **Guest wrapper** (`guest-runner-script.mjs`, after `session.prompt(...)`): call
   `const stats = session.getSessionStats?.();` (optional-chained so an older Pi degrades to
   "no usage" rather than crashing) and add `usage` to the result JSON:
   `{ inputTokens: stats.tokens.input, outputTokens: stats.tokens.output, cacheReadTokens:
   stats.tokens.cacheRead, cacheCreationTokens: stats.tokens.cacheWrite, requests:
   stats.assistantMessages }`. Update the file's contract comment (line 15) to match.
2. **`AgentResult`** (`src/agent/index.ts:40`): add `usage?: AgentUsage` with that field shape;
   **host runner** (`guest-pi-runner.ts:186-194`) parses `usage` and threads it through.
3. **Plumb to the hook without coupling the core to Pi.** The durable core imports no agent
   code (`AGENTS.md`), so define a structural `StepAgentInfo` (`{ model?, usage? }`, plain
   numbers) in `runtime/types.ts` and add `agent?: StepAgentInfo` to both `UsesResult` and
   `StepResult`. `work-handler.ts:97` attaches `agent: { model: model.model, usage: res.usage }`
   to the `UsesResult`; the runtime copies `UsesResult.agent → StepResult.agent` where it maps a
   uses-step result. The observability emitter reads `result.agent` in `onStepEnd` and sets
   `gen_ai.request.model` + `gen_ai.usage.{input,output}_tokens` (+ `cache_*` when non-zero) on
   the `chat {model}` span, increments `work_agent_tokens_total{direction}` and the
   `gen_ai.client.token.usage` histogram, and adds `requests` to `work_agent_requests_total`.

**Testing.** The stub `AgentRunner` tests inject (never mock the *real* runner, per project
memory) can return `usage`, so the whole `work-handler → UsesResult → StepResult → onStepEnd`
path is unit-testable with no VM. The only part that needs a real guest+model is the one
`getSessionStats()` call in the wrapper — verify it against `demo.sh` and a real `work run`
(e.g. `compiler-review`), not just the suite. Sequence this slice early if token accounting is a
priority; until it ships, `work_agent_tokens_total` and `gen_ai.usage.*` read zero.

---

## 7. Dependencies and the opt-in / no-op design

The package must not impose an OTel runtime on users who don't want it. OTel's API is built for
exactly this: with no SDK registered, `trace.getTracer(...).startSpan(...)` returns a **no-op**
span — no exporter, no cost.

- **`@opentelemetry/api`** → a **regular dependency** (small, stable 1.x). All engine code
  imports only from here and calls `trace.getTracer('work')` unconditionally; the calls no-op
  when no SDK is started.
- **`@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-proto`,
  `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-proto`,
  `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`** →
  **`optionalDependencies`**, mirroring how `@earendil-works/gondolin` and
  `@earendil-works/pi-coding-agent` are already declared (`package.json:48`). Both signals use
  the OTLP/proto exporters — no `@opentelemetry/exporter-prometheus`, no `prom-client`. A tiny
  `src/observability/bootstrap.ts` **lazily `import()`s** and starts the SDK only when telemetry
  is enabled (§8). With manual spans only (no auto-instrumentation), no `--import`/loader-preload
  dance is needed under Node ≥ 23.6.
- Keep `knip` happy: the lazy/optional packages must be declared so the unused-dep check and
  the `npm run check` gate stay green. Use `resourceFromAttributes()` (the 2.x factory; the old
  `new Resource()` is deprecated) and the `ATTR_SERVICE_NAME`/`ATTR_SERVICE_VERSION` constants.

Resource attributes: `service.name = "work"`, `service.version` from `package.json`,
`process.runtime.{name,version}`. Honor the standard `OTEL_*` env vars (`OTEL_SERVICE_NAME`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`) — they take precedence and let users
override without touching config.

**Lifecycle — process-scoped SDK, per-run emitter.** `startTelemetry` starts the SDK and
returns a shared `{ tracer, meter, shutdown }` **once per process**, NOT per run. The web/serve
composition root (`startWebServer`) starts it at boot and injects the handle into every run
(`RunManager` → `startRun`), shutting it down once at server close; a one-shot CLI `work run`
starts and shuts down its own. Registering the global OTel SDK is a once-per-process operation —
doing it per run on a long-lived server would re-register (and thrash) the global providers.
Critically, the **emitter is built fresh per run** (`createTelemetryHooks` from the shared
tracer/meter) because it holds per-run span state (root span, job map); the tracer/meter are
concurrency-safe and the instruments aggregate across runs, so several concurrent web runs share
the SDK but never cross-wire their spans. `startRun` does not own an injected handle (mirrors the
shared-`engine` rule).

---

## 8. Config surface

Extend `PiWorkflowsConfig` (`src/config/index.ts`) with an optional block, layered and
`$VAR`-expanded like the rest of the config (so OTLP auth tokens come from the environment):

```jsonc
{
  "observability": {
    "enabled": true,
    // Single OTLP endpoint (Alloy) for both traces and metrics. The OTLP/HTTP base;
    // the exporters append /v1/traces and /v1/metrics. $VAR-expanded.
    "otlpEndpoint": "http://alloy.your-tailnet.ts.net:4318",  // or $OTEL_EXPORTER_OTLP_ENDPOINT
    "metricExportIntervalMs": 15000,                          // periodic push tick
    "traces":  { "enabled": true },                           // toggle either signal
    "metrics": { "enabled": true }
  }
}
```

Enablement precedence: explicit config > `OTEL_*` env vars > off. When nothing opts in, the SDK
is never imported and every span/metric call no-ops (§7). A `create observability` scaffold and
a `*.example.json` snippet (config holds no secrets here, but keep parity with the existing
generators) round out the surface.

---

## 9. Deployment topology: Alloy → Tempo + Prometheus

```
                         ┌──────────────► Tempo        (traces)
work ──OTLP/HTTP──► Alloy │
 (traces+metrics)        └──remote_write► Prometheus   (metrics)   ──► Grafana
```

`work` pushes OTLP/HTTP to a single Alloy endpoint (4318). Alloy receives both signals and fans
out — OTLP to Tempo for traces, OTLP→Prometheus conversion + remote-write for metrics. The
operator views both in Grafana (Tempo + Prometheus datasources; trace→metric and metric→trace
correlation via exemplars). This is the engine's own dogfooding target — the same LGTM-over-
tailnet stack the fleet already runs (see [`tailnet-incident-response-research.md`](tailnet-incident-response-research.md)).

A minimal Alloy config for this path:

```alloy
otelcol.receiver.otlp "work" {
  http { }   // 0.0.0.0:4318
  output {
    traces  = [otelcol.exporter.otlp.tempo.input]
    metrics = [otelcol.exporter.prometheus.work.input]
  }
}

otelcol.exporter.otlp "tempo" {
  client { endpoint = "tempo:4317" }
}

otelcol.exporter.prometheus "work" {
  forward_to = [prometheus.remote_write.default.receiver]
}

prometheus.remote_write "default" {
  endpoint { url = "http://prometheus:9090/api/v1/write" }   // Prometheus needs
}                                                            // --web.enable-remote-write-receiver
```

Notes: OTLP/HTTP is 4318 (proto/JSON), gRPC is 4317. Default `work`'s exporters to
`@opentelemetry/exporter-{trace,metrics}-otlp-proto` (HTTP/protobuf — lighter than gRPC, more
efficient than JSON). Remote-write into stock Prometheus requires
`--web.enable-remote-write-receiver`; against Mimir, point `prometheus.remote_write` at the
distributor instead. For pure instrumentation debugging without a collector, a
`ConsoleSpanExporter` (one env toggle) dumps spans to stdout.

---

## 10. Implementation phases

1. **Traces, happy path.** New `src/observability/` module implementing `RunHooks`; add
   `onWorkflowStart/End` + enrich job/step payloads (§2); wire the emitter into `startRun`'s
   hook fan-out; opt-in SDK bootstrap (§7); run→job→step spans with `cicd.*`/`work.*`/`host.image.*`
   attributes and ERROR/`error.type` failure modeling. OTLP trace export. Ship behind config off
   by default.
2. **Agent token slice (§6).** Guest wrapper → `AgentResult.usage` → host runner → hook → the
   `chat {model}` GenAI child span with `gen_ai.usage.*`. Do this early if token accounting is a
   priority.
3. **Metrics.** OTel metrics + `PeriodicExportingMetricReader` → OTLP metrics exporter (to the
   same Alloy endpoint); the catalog (§5.2) with the shared bucket-set `View`; `forceFlush` on
   shutdown so CLI runs report. No HTTP endpoint.
4. **Resume marking + true root span.** ✅ **Shipped.** The run span is a true root
   (`root: true`, empty parent) so OTLP backends recognize the trace root (§4.2). Each attempt
   is its own trace, correlated by `work.run.id`; `work.run.resumed=true` + `work_run_resumes_total`
   on a genuine resume. The runtime passes `resumed = !spawned.created` to `onWorkflowStart`
   (moved to just after the orchestrator spawn, where `created` is known but before any job
   runs). **Replay/no-op guard:** a resumed run that executes **zero** jobs (a `work serve`
   worker re-claiming an already-finished run on startup — observed: a restart re-drove three
   leftover ci runs into three childless sub-100ms "success" traces) emits nothing — the root
   span is left un-ended (never exported) and no run counter fires. Covered by Layer-1 tests
   (true-root guard, suppression, resume marking/counter). **Not yet done:** coalescing a
   resumed run's separate attempts into one trace — the persist/restore design in §4.2.
5. **(Deferred) deterministic-ID tracer** (§4.4) — only if resumed-trace fidelity must be
   perfect.

Each phase is independently shippable and adds an e2e example under `test/e2e/` (per the
repo convention that workflow features come with a runnable example).

---

## 11. Testing strategy

The emitter is, architecturally, a sibling of the TUI/web presenters: a **pure `RunHooks`
consumer**. `test/web-presenter.test.ts:56-65` already shows the template — construct the
consumer, call `hooks.onStepStart!(…)` / `onStepEnd!(…)` directly, assert on what it emitted.
Swap "emitted frames" for "spans captured by an in-memory exporter" and that pattern carries the
bulk of the suite. The layers below run on the existing harness (`test/_support.ts`:
`useSharedRuntime`, `mockAgentRunner`, `HostTarget`, `hostTargetFactory`, `vmTestSkip`).

**Load-bearing design constraint.** The emitter takes **injected** `tracer`/`meter` handles, not
a globally-registered provider. This is forced by the suite running under `--test-isolation=none`
(one shared process — a global OTel provider leaks across files), and it is the *same* decision
that delivers the §7 zero-overhead-when-off property. Production `bootstrap.ts` registers
globally; unit tests pass providers backed by in-memory exporters and construct a fresh emitter
per test.

1. **Emitter unit (the bulk — no runtime/VM/inference).** `InMemorySpanExporter` +
   `SimpleSpanProcessor` (synchronous capture on `span.end()`), and a `MeterProvider` with an
   in-memory reader you `forceFlush()` before reading. Drive synthetic hook sequences and assert:
   the run→job→step→`chat` tree via `parentSpanId`; attributes (`cicd.*`/`work.*`/
   `host.image.*`/`gen_ai.*`); `status=ERROR`+`error.type` on a failed step while its job rolls up
   `success` (the continue-on-error case `ci` depends on); `span.links` on a `needs` fan-in;
   **correct parenting under interleaved (concurrent) events** — proving the `Map<jobId,ctx>`
   approach, not ambient context (§4.5); metric values/labels, histogram `count`/`sum`,
   `jobs_in_flight` balancing to 0, agent token counters equal to the injected usage; a
   **cardinality guard** (every metric data point's attribute keys ⊆
   `{workflow,job,model,result,direction}` — catches a `run_id`-label regression mechanically);
   and **no-op when disabled** (zero spans, no throw). Lands as `test/observability.test.ts`.
2. **Runtime integration (validates the real hook stream).** Reuse `useSharedRuntime()`
   (HostTarget + `mockAgentRunner`), attach the emitter as `hooks`, run a known fan-out/fan-in
   plan with a failing continue-on-error step and an agent step, assert the captured tree. This is
   the **only** tier that exercises the **hook enrichment** — that the runtime actually threads
   `runs-on`/image/step-kind/agent-info into the hooks (Layer 1 feeds synthetic payloads).
   Precedent: `integration.test.ts:326-334` already passes hooks. Run with `maxConcurrency>1`.
3. **Token path (split by VM-dependence).** (a) extend `mockAgentRunner` to return `{text,
   usage}`; assert `StepResult.agent.usage` reaches `onStepEnd` and the token metrics. (b)
   `GuestPiRunner` with a fake `exec` that writes a result JSON with `usage` (its docstring
   promises VM-free testability); assert `AgentResult.usage` parses. (c) **Wrapper contract** —
   child-process the real shipping `guest-runner-script.mjs` against a stub
   `node_modules/@earendil-works/pi-coding-agent` whose `createAgentSession().session
   .getSessionStats()` returns known tokens; assert the written result carries the usage shape.
   This pins the one piece outside the TS program with no inference.
4. **Resume continuity (empirical proof of §4.1).** Piggyback `run-resume.test.ts` /
   `durable-resume.test.ts` (two runtime passes, same `dataDir`+`runId`, `crashSecond` →
   `hostTargetFactory`). The in-memory exporter persists across both phases, so assert: the root
   SpanContext was checkpointed; resumed spans share the **phase-1 `traceId`**;
   `work.run.resumed=true`; and the already-completed job's step spans appear **exactly once**
   across both phases (memoized steps don't re-fire hooks → don't re-emit).
5. **Wire/export fidelity (thin).** Stand up a localhost OTLP/HTTP receiver (the **JSON** exporter
   variant, so the receiver just parses JSON) and point the real `bootstrap` at it; assert
   resource attributes (`service.name=work`, version) and that spans/metrics actually serialize
   and POST. This is the one tier that touches global registration — reset it in `t.after`
   (`trace.disable()` / `provider.shutdown()`).
6. **Real run (live `work.json` + QEMU, e2e tier).** Gated like `examples.test.ts`
   (`vmTestSkip()`): a real `work run compiler-review` with telemetry → the in-process OTLP
   receiver, asserting **non-zero** `gen_ai.usage.input_tokens`. The only place the real Pi
   `getSessionStats()` against a real model is exercised end-to-end — it confirms the layer-3c
   fake-Pi assumptions match reality. Also reachable via `demo.sh`.

Phase mapping: phase 1 → layers 1, 2, 5; phase 2 → layer 3; phase 3 → layers 1–2 (metric
assertions, cardinality guard); phase 4 → layer 4; real-run smoke → layer 6. Cross-cutting:
assert structure/attributes/relationships, **never** span ids, timestamps, or exact durations.
The in-memory exporters live in `@opentelemetry/sdk-trace-base` / `@opentelemetry/sdk-metrics`
(already `optionalDependencies`, pure JS so always installed) — fine to import from tests; keep
`knip` aware.

---

## 12. Open questions

- **Pin strategy for unstable semconv.** `cicd.*` (RC) and `gen_ai.*` (Development, separate
  repo) will move. Decide whether to vendor the attribute-key constants we use into a small
  `src/observability/semconv.ts` (so an upstream rename is a one-file change) vs depending on
  `@opentelemetry/semantic-conventions` for the stable ones and hand-defining the unstable ones.
- **Exemplars.** Over OTLP they ride to the backend without the scrape-side OpenMetrics dance,
  so the cost is low — but Prometheus still needs `--enable-feature=exemplar-storage` to retain
  them and Grafana to render the trace links. Wire in phase 3 or defer to a follow-up? Leaning
  defer until the trace↔metric correlation is actually wanted in Grafana.

---

## Appendix A: a worked example — `work run ci`

To make the model concrete, here is what a single run of the repo's own
[`ci.yaml`](../.workflows/ci.yaml) would emit. `ci` composes three reusable workflows via
job-level `uses:`, which inline at compile time into **11 jobs across 5 levels** (`work graph ci`):
`checks` → `test` → four `review__<subsystem>__scan` jobs (parallel) → four
`review__<subsystem>__collect` jobs (parallel) → `review__collect`. Nine of the steps are
`work/agent` model calls, so nine `chat {model}` leaf spans. The run below is one where
**typecheck fails** — it's `continue-on-error: true`, so the step errors but the `checks` job
stays green, which is exactly the case that exercises outcome-as-attribute (§3.4).

### A.1 Trace — job-level waterfall (the `needs` DAG + parallelism)

```
ci · run 4f9a2c · 312.4s · result=success                        0s        156s       312s
────────────────────────────────────────────────────────────────┬──────────┬──────────┤
checks                  work:base    ████████                    │          │          ✓ 47s
test                  ← checks       ········███████████████████████        │          ✓141s
review__compiler__scan  ← checks,test ·····························███████    │          ✓ 42s
review__runtime__scan   ← checks,test ·····························██████     │          ✓ 37s
review__security__scan  ← checks,test ·····························█████████  │          ✓ 53s  ← crit. path
review__web__scan       ← checks,test ·····························██████     │          ✓ 34s
review__compiler__collect ← cmp scan  ·····································████████        ✓ 50s
review__runtime__collect  ← rt  scan  ································████████             ✓ 47s
review__security__collect ← sec scan  ·······································█████████     ✓ 53s  ← crit. path
review__web__collect      ← web scan  ······························████████             ✓ 46s
review__collect       ← 4 collects    ·················································████ ✓ 18s
────────────────────────────────────────────────────────────────┴──────────┴──────────┤
   level0 → level1 → 4×scan ∥ → 4×collect ∥ → final collect.  work_jobs_in_flight peaks at 4.
```

### A.2 Span hierarchy (one subsystem expanded; the other three are identical shape)

```
▼ run ci                                    [   0.0s +312.4s] INTERNAL  result=success
  ▼ job checks                  work:base   [   0.0s + 47.0s] INTERNAL  result=success
      step install   (run npm ci)           [   0.4s + 21.6s]           result=success
      step lint                             [  22.1s +  5.8s]           result=success
      step typecheck                        [  28.0s +  4.9s] ● ERROR   result=failure  error.type=exit_1
      step knip                             [  33.1s +  3.9s]           result=success     ⤷ continue-on-error:
      step fan-in                           [  37.2s +  7.8s]           result=success        job stays green
  ▼ job test                    work:nested [  47.0s +141.0s] INTERNAL  result=success
      step install   (run npm ci)           [  47.4s + 19.8s]           result=success
      step test (full suite, nested VMs)    [  67.4s +120.6s]           result=success
  ▼ job review__compiler__scan  work:base   [ 188.0s + 42.0s] INTERNAL  result=success
    ▼ step review compiler + spec  (work/agent)  [188.3s +41.5s]        result=success
        chat claude-opus-4                  [ 188.4s + 41.3s] INTERNAL  gen_ai.usage.* → 18.2k in / 1.45k out
  ▼ job review__compiler__collect work:base [ 230.0s + 50.0s] INTERNAL  result=success
    ▼ step verify + cap the compiler findings  (work/agent) [230.2s +48.6s]  result=success
        chat claude-opus-4                  [ 230.3s + 48.4s] INTERNAL  gen_ai.usage.* → 22.5k in / 0.98k out
      step show review  (run printf)        [ 279.0s +  0.2s]           result=success
  ► job review__runtime__{scan,collect}     … same shape (scan→collect, 1 chat span each)
  ► job review__security__{scan,collect}    … same shape   ← the two longest (critical path)
  ► job review__web__{scan,collect}         … same shape
  ▼ job review__collect         work:base   [ 294.0s + 18.0s] INTERNAL  result=success
    ▼ step merge + prioritize the reviews  (work/agent) [294.2s +17.6s] result=success
        chat claude-opus-4                  [ 294.3s + 17.4s] INTERNAL  gen_ai.usage.* → 9.3k in / 1.12k out
      step show review  (run printf)        [ 311.8s +  0.2s]           result=success
```

### A.3 Span-attribute zoom (four representative spans)

```
┌ run ci ─────────────────────────────────────────────────────────────────────┐
│ name              "run ci"                          span.kind   INTERNAL       │
│ work.run.id       4f9a2c1e-…           cicd.pipeline.name      ci              │
│ cicd.pipeline.result  success          cicd.pipeline.run.id    4f9a2c1e-…      │
│ service.name      work                 service.version         0.3.0           │
└───────────────────────────────────────────────────────────────────────────────┘
┌ job test ───────────────────────────────────────────────────────────────────┐
│ name              "job test"           work.job.name           test            │
│ cicd.pipeline.task.name  test          cicd.pipeline.task.run.id  4f9a2c1e-…:test│
│ host.image.name   work:nested          host.arch               arm64           │
│ work.runs_on      work:nested          work.machine.cpus 8   work.machine.memory 64G│
│ cicd.pipeline.task.run.result  success                                          │
└───────────────────────────────────────────────────────────────────────────────┘
┌ step typecheck (the failure) ───────────────────────────────────────────────┐
│ name              "step typecheck"     work.step.name          typecheck       │
│ work.step.kind    run                  work.step.index         2               │
│ status            ERROR                 error.type              exit_1          │
│ work.step.result  failure              work.step.continue_on_error  true        │
│ event             exception { exception.message: "tsc exited 1" }               │
│  ⤷ parent job `checks` result = success — continue-on-error absorbs it           │
└───────────────────────────────────────────────────────────────────────────────┘
┌ chat claude-opus-4 (agent leaf) ────────────────────────────────────────────┐
│ name              "chat claude-opus-4"  gen_ai.operation.name  chat            │
│ gen_ai.provider.name  anthropic         gen_ai.request.model   claude-opus-4   │
│ gen_ai.response.model claude-opus-4     (model resolved from work.json)         │
│ gen_ai.usage.input_tokens   22480       gen_ai.usage.output_tokens   980        │
└───────────────────────────────────────────────────────────────────────────────┘
```

### A.4 What lands in Prometheus (post-OTLP-conversion samples)

```
# run / job / step counters
work_runs_total{workflow="ci",result="success"}                                    1
work_jobs_total{workflow="ci",job="checks",result="success"}                       1
work_jobs_total{workflow="ci",job="test",result="success"}                         1
work_jobs_total{workflow="ci",job="review__security__scan",result="success"}       1
  … (11 job series total)
work_steps_total{workflow="ci",job="checks",result="success"}                      4
work_steps_total{workflow="ci",job="checks",result="failure"}                      1   ← typecheck
work_steps_total{workflow="ci",job="test",result="success"}                        2

# durations (histograms — _bucket/_sum/_count; _sum shown)
work_run_duration_seconds_sum{workflow="ci",result="success"}                 312.4
work_run_duration_seconds_count{workflow="ci",result="success"}                    1
work_job_duration_seconds_sum{workflow="ci",job="test",result="success"}      141.0
work_job_duration_seconds_bucket{workflow="ci",job="test",result="success",le="300"} 1

# concurrency gauge (settles to 0; peaked at 4 during the scan/collect fan-out)
work_jobs_in_flight{workflow="ci"}                                                  0

# agent / model
work_agent_requests_total{model="claude-opus-4",result="success"}                  9
work_agent_tokens_total{model="claude-opus-4",direction="input"}              184320
work_agent_tokens_total{model="claude-opus-4",direction="output"}              9870
work_agent_request_duration_seconds_count{model="claude-opus-4",result="success"}  9
```

Two things this example makes concrete. The **typecheck failure stays contained** — the step
span is `ERROR`/`result=failure`, but `checks` and the run roll up `success` (the
`continue-on-error` semantics `review` depends on). And the **token totals are the one number
not available today**: `work_agent_tokens_total` and `gen_ai.usage.*` read zero until the §6
guest-wrapper slice lands. `work.run.id` is on every span but never a metric label — series stay
bounded by `workflow`/`job`/`model`/`result` (§5.3).

> Numbers (durations, token counts) are illustrative; the **structure** (11 spans' worth of jobs,
> 9 `chat` leaves, the attribute keys, the metric series and their labels) is what the design
> produces. Regenerate the job/level shape any time with `work graph ci`.

---

## 13. References

OpenTelemetry JS — getting started / manual instrumentation / context propagation / resources /
exporters: <https://opentelemetry.io/docs/languages/js/>. Span links:
<https://opentelemetry.io/docs/specs/otel/overview/>.

Semantic conventions — CI/CD spans <https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/>
and metrics <https://opentelemetry.io/docs/specs/semconv/cicd/cicd-metrics/>; GenAI (moved repo)
<https://github.com/open-telemetry/semantic-conventions-genai>; recording errors
<https://opentelemetry.io/docs/specs/semconv/general/recording-errors/>; host resource
<https://opentelemetry.io/docs/specs/semconv/resource/host/>.

Metrics — OTLP metrics exporter
<https://www.npmjs.com/package/@opentelemetry/exporter-metrics-otlp-proto>; Prometheus naming
<https://prometheus.io/docs/practices/naming/>.

Backend / collector — Grafana Alloy OTLP receiver
<https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.receiver.otlp/>,
`otelcol.exporter.prometheus`
<https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.exporter.prometheus/>,
`prometheus.remote_write`
<https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.remote_write/>;
Tempo OTLP ingest <https://grafana.com/docs/tempo/latest/configuration/>; Prometheus remote-write
receiver <https://prometheus.io/docs/prometheus/latest/feature_flags/#remote-write-receiver>.

Prior art — Temporal OTel contrib (replay-safe spans, deterministic IDs)
<https://github.com/temporalio/sdk-python/tree/main/temporalio/contrib/opentelemetry>; Airflow
traces <https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/logging-monitoring/traces.html>;
Argo Workflows metrics <https://github.com/argoproj/argo-workflows/blob/main/docs/metrics.md>;
GH-Actions OTel exporter <https://github.com/corentinmusard/otel-cicd-action>; OTel CI/CD WG
<https://www.cncf.io/blog/2024/11/04/opentelemetry-is-expanding-into-ci-cd-observability/>.

---

*See also: [`durable-orchestrator.md`](durable-orchestrator.md) (why resume exists and how the
journal walks the DAG), [`agent-primitive-and-actions.md`](agent-primitive-and-actions.md) (the
`work/agent` step the GenAI spans wrap), and
[`tailnet-incident-response-research.md`](tailnet-incident-response-research.md) (the LGTM-over-
tailnet stack Alloy forwards into).*
