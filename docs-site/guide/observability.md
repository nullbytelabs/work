# Observability (OpenTelemetry)

Every run can emit **OpenTelemetry traces and metrics** over OTLP: a trace per run
with a span for each job and step (and each AI call), plus the usual counters and
histograms. It's **off by default** and turned on with one config block; when off,
nothing about OpenTelemetry is loaded, so you pay nothing.

Point it at any OTLP collector (a local [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/),
[Grafana Alloy](https://grafana.com/docs/alloy/latest/), Jaeger, which ingests OTLP
directly, or a hosted backend) and your runs show up as standard distributed traces.

## Enable it

Add an `observability` block to [`work.json`](../reference/configuration#observability):

```json
{
  "observability": {
    "enabled": true,
    "otlpEndpoint": "http://localhost:4318",
    "headers": { "Authorization": "Bearer $OTEL_EXPORTER_TOKEN" }
  }
}
```

- `otlpEndpoint` is the OTLP/HTTP base; the exporters append `/v1/traces` and
  `/v1/metrics`. For a local collector that's usually `http://localhost:4318`.
- `headers` are added to every export — typically auth for a hosted collector. Values
  support `$VAR` expansion, so the token lives in your environment, not the file.

Prefer environment variables? The standard ones work with **no config at all** — setting
`OTEL_EXPORTER_OTLP_ENDPOINT` alone turns telemetry on:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
work run ci
```

Explicit `work.json` config wins where both are set. Full field reference:
[Configuration › observability](../reference/configuration#observability).

## What you get

### Traces

One trace per run, named for the workflow and keyed by the run id. Jobs nest under the
run, steps under their job, and an AI step adds a `chat {model}` span:

```
run ci                                   work.run.id, cicd.pipeline.result
└─ job checks            host.image.name=work:base   cicd.pipeline.task.run.result
   ├─ step install       work.step.kind=run
   ├─ step typecheck     ● ERROR  error.type=exit_1  (continue-on-error → job still succeeds)
   └─ step review        work.step.kind=uses
      └─ chat <model>     gen_ai.request.model, gen_ai.usage.input_tokens / output_tokens
```

Each span carries standard semantic-convention attributes where they exist — `cicd.*`
for the run/job (it maps cleanly onto the CI/CD conventions), `gen_ai.*` for AI calls,
`host.image.*` for the micro-VM image, plus a `work.*` namespace for engine specifics
(`work.run.id`, `work.job.name`, `work.step.kind`, …). A failed step is an `ERROR` span
with `error.type`; a `continue-on-error` step shows that error while its job still rolls
up `success`.

### Metrics

The usual counters, histograms, and a gauge (Prometheus-style names shown):

| Metric | Type | Labels |
|---|---|---|
| `work_runs_total` | counter | `workflow`, `result` |
| `work_jobs_total` | counter | `workflow`, `job`, `result` |
| `work_steps_total` | counter | `workflow`, `job`, `result` |
| `work_run_duration_seconds` | histogram | `workflow`, `result` |
| `work_job_duration_seconds` | histogram | `workflow`, `job`, `result` |
| `work_step_duration_seconds` | histogram | `job`, `result` |
| `work_jobs_in_flight` | gauge | `workflow` |
| `work_agent_requests_total` | counter | `model`, `result` |
| `work_agent_tokens_total` | counter | `model`, `direction` (`input`/`output`) |

Run/job/step **names** are labels; unbounded ids (the run id, trace id) are not — they
live on the spans, so metric cardinality stays bounded.

### AI token usage

Agent steps record their cumulative token usage for the whole loop: on the `chat` span
as `gen_ai.usage.input_tokens` / `output_tokens` (plus cache-token subsets when the
provider reports them), and as the `work_agent_tokens_total{direction}` counter. So you
can see, per run and per model, exactly what was sent and received.

## Viewing it

Anything that speaks OTLP works. A common local setup is a collector that fans traces to
a trace store and metrics to a time-series database, viewed together in one dashboard;
for quick local inspection, a single-binary OTLP trace viewer is the lowest-friction
option. The engine doesn't care which — it just pushes OTLP to `otlpEndpoint`.

::: tip Verify it's flowing
Counters from a one-shot `work run` are pushed and flushed before the process exits, so a
short run still reports. On a long-lived [`work serve`](./web-ui), the SDK starts once and
streams for the host's lifetime.
:::

## Notes

- **Off by default.** No endpoint configured (and no `OTEL_*` env) ⇒ no telemetry, no
  overhead.
- **Counters are per-process.** Each `work run` is its own process, so a counter starts at
  zero each run — query these with `rate()` / `increase()` (which handle the resets), not
  as an all-time total.
- **CLI and serve are equivalent.** Both drive the same engine, so a run emits the same
  trace and metrics whether you launched it from the CLI or the serve host.
