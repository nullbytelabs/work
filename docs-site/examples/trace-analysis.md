# Trace analysis: read a run back from Tempo

[Observability](../guide/observability) sends a trace for every run *out* to your
collector. This workflow brings one back *in*: give it a run id and it fetches that
run's OpenTelemetry trace from Grafana Tempo and has an AI agent analyze it —
critical path, per-step timing, per-model token usage, failures, and takeaways.

It's also dogfooding: the runs it analyzes are `work`'s own (the `ci` trace from
[Dogfooding](./dogfooding), say) — and, because observability is on, the analysis run
emits a trace too, so it can analyze *itself* (see [below](#the-observer-observed)).

## The correlation: run id ↔ trace

The run id you see in `work` output is **not** the trace id. `work` stamps the run id
onto its spans as the `work.run.id` attribute; the OTLP trace id is random per run. So
the workflow takes the run id, searches Tempo for the span carrying it
(`{ span.work.run.id = "<id>" }`), resolves the trace id, fetches the full trace, and
distills it into a readable span tree.

## Brokering Grafana access

The job reaches Grafana through a `grafana` [datasource](../reference/configuration#datasources)
in [`work.json`](../reference/configuration):

```json
{
  "datasources": {
    "grafana": {
      "baseUrl": "https://<stack>.grafana.net",
      "token": "$SERVICE_ACCOUNT_TOKEN",
      "tokenEnv": "SERVICE_ACCOUNT_TOKEN"
    }
  }
}
```

The service-account token is injected **host-side** into the `Authorization` header,
scoped to the Grafana host — it never enters the guest. That's the right call here
because the next step is an AI agent running in that same job with open egress: it can
read the trace but can never see or exfiltrate the token. A guest-side secret would
hand the agent the credential; the datasource doesn't.

## The workflow

```yaml
# .workflows/trace-analysis.yaml
name: trace-analysis

inputs:
  run_id:
    type: string
    required: true
    pattern: "^[0-9a-fA-F]{8}-...-[0-9a-fA-F]{12}$"   # a UUID
  lookback_hours:
    type: string
    default: "720"   # how far back to search Tempo (default 30 days)

jobs:
  analyze:
    runs-on: work:base
    machine: small
    steps:
      - id: fetch
        uses: action/tempo-trace
        with:
          run_id: ${{ inputs.run_id }}
          grafana_url: https://<stack>.grafana.net
          lookback_hours: ${{ inputs.lookback_hours }}

      - id: analyze
        uses: work/agent
        with:
          prompt: |
            Analyze this OpenTelemetry span tree for a single work run:
            critical path / long pole, per-step timing, per-model token
            usage (gen_ai.usage.* on chat spans), failures, and takeaways.

            ${{ steps.fetch.outputs.tree }}
```

Three steps: the action resolves the trace and distills it, the agent analyzes the
distilled tree, and a final step prints the report.

## The `tempo-trace` action

All the Grafana/Tempo logic lives in a reusable node [action](../guide/actions) under
`.workflows/actions/tempo-trace/`, so the workflow stays a few lines and any other
workflow can `uses: action/tempo-trace` at the step level. The action:

1. resolves the trace id from the run id (`{ span.work.run.id = "<id>" }`),
2. fetches the full trace over the brokered datasource egress,
3. distills it into the `run → job → step → chat` span tree (with the meaningful
   `work.*` / `cicd.*` / `gen_ai.*` attributes and per-span durations), and emits it as
   the `tree` output (plus `trace_id`).

Its inputs are `run_id`, `grafana_url`, and `lookback_hours`; the token arrives from
the datasource, never as an input.

## Run it

```bash
export SERVICE_ACCOUNT_TOKEN=glsa_...   # a Grafana service-account token

work run trace-analysis \
  --inputs '{"run_id":"<run-id>"}' \
  --datasources grafana
```

`--datasources grafana` scopes the run to that datasource — egress is deny-by-default
for datasources, so a run reaches only what you name. Grab a run id from any `work`
run's output. The agent's report comes back as the job's `analysis` output and is
printed at the end of the run.

## The observer, observed

Because observability is on, the `trace-analysis` run emits its own trace. Wait a few
seconds for ingestion, then feed *that* run's id back in:

```bash
work run trace-analysis --inputs '{"run_id":"<the-analysis-run-id>"}' --datasources grafana
```

Now the workflow analyzes itself — the agent's own `chat {model}` span shows up in the
tree it's reading, token usage and all. It's a neat end-to-end proof that the agent
telemetry path (`gen_ai.usage.input_tokens` / `output_tokens`, cache subsets) actually
lands in Tempo, not just a claim.

## What it exercises

| In the workflow | Engine feature it leans on |
|---|---|
| `grafana` datasource brokers the Tempo API token host-side | [Datasources](../reference/configuration#datasources) — scoped, deny-by-default egress with a header-injected credential the guest never sees |
| `uses: action/tempo-trace` keeps the fetch/distill logic reusable | [Actions](../guide/actions) — a node action with the `INPUT_*` / `$WORK_OUTPUT` ABI |
| `uses: work/agent` reads the distilled tree and writes the report | [Agent steps](../guide/agent-steps) — a real model in the job's sandbox |
| consumes `work.run.id` / `gen_ai.usage.*` spans | [Observability](../guide/observability) — the traces this reads back |
