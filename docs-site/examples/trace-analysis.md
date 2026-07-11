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

Grafana access flows through the [`secrets:`](../reference/configuration#secrets)
whitelist in [`work.json`](../reference/configuration). Add a Grafana stack URL and a
service-account token, each reading its value from your shell environment:

```json
{
  "secrets": {
    "GRAFANA_URL": "$GRAFANA_URL",
    "GRAFANA_TOKEN": "$GRAFANA_SERVICE_ACCOUNT_TOKEN"
  }
}
```

The workflow then references them as <code v-pre>${{ secrets.GRAFANA_URL }}</code> and
<code v-pre>${{ secrets.GRAFANA_TOKEN }}</code>, passing the token into the
`tempo-trace` action's `with:` inputs. Each value is resolved host-side at run time
and lands in the guest of the step that reads it — the action that makes the Grafana
call.

The token is a credential, so we keep it away from the AI agent with a **job split**:
the `fetch` job holds the secret and exposes only its *result*; the `analyze` job runs
the agent and consumes that result via a job output, never seeing the token.

## The workflow

```yaml
# .workflows/trace-analysis.yaml
name: trace-analysis

inputs:
  run_id:
    type: string
    required: true
    pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"   # a UUID
  lookback_hours:
    type: number
    default: 720   # how far back to search Tempo (default 30 days)

jobs:
  # The only job that touches the secret.
  fetch:
    runs-on: work:base
    machine: small
    outputs:
      tree: ${{ steps.fetch.outputs.tree }}
    steps:
      - id: fetch
        uses: action/tempo-trace
        with:
          run_id: ${{ inputs.run_id }}
          grafana_url: ${{ secrets.GRAFANA_URL }}
          grafana_token: ${{ secrets.GRAFANA_TOKEN }}
          lookback_hours: ${{ inputs.lookback_hours }}

  # Feeds on fetch's distilled tree — no secret in scope.
  analyze:
    runs-on: work:pi
    machine: small
    needs: [fetch]
    steps:
      - id: analyze
        uses: work/agent
        with:
          prompt: |
            Analyze this OpenTelemetry span tree for a single work run:
            critical path / long pole, per-step timing, per-model token
            usage (gen_ai.usage.* on chat spans), failures, and takeaways.

            ${{ needs.fetch.outputs.tree }}

      - name: show analysis
        env:
          ANALYSIS: ${{ steps.analyze.outputs.output }}
        run: printf '%s\n' "$ANALYSIS"
```

Two jobs: `fetch` resolves the trace and distills it (passing the Grafana token in
from `secrets`), then `analyze` — which `needs: [fetch]` — runs the agent over the
distilled tree (via <code v-pre>${{ needs.fetch.outputs.tree }}</code>) and prints the
report. The token lives only in `fetch`; the agent job never sees it.

## The `tempo-trace` action

All the Grafana/Tempo logic lives in a reusable node [action](../guide/actions) under
`.workflows/actions/tempo-trace/`, so the workflow stays a few lines and any other
workflow can `uses: action/tempo-trace` at the step level. The action:

1. resolves the trace id from the run id (`{ span.work.run.id = "<id>" }`),
2. fetches the full trace from Tempo, authenticating with the service-account token,
3. distills it into the `run → job → step → chat` span tree (with the meaningful
   `work.*` / `cicd.*` / `gen_ai.*` attributes and per-span durations), and emits it as
   the `tree` output (plus `trace_id`).

Its inputs are `run_id`, `grafana_url`, `grafana_token`, and `lookback_hours`. The
workflow passes the token in as <code v-pre>${{ secrets.GRAFANA_TOKEN }}</code>; the
action reads it as `INPUT_GRAFANA_TOKEN` and forwards it in the request's
`Authorization` header.

## Run it

```bash
export GRAFANA_URL=https://<stack>.grafana.net      # your Grafana stack base URL
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_...        # a Grafana service-account token

work run trace-analysis --inputs '{"run_id":"<run-id>"}'
```

The two `secrets` entries read those env vars host-side, so once they're set the run
just works — no extra flags. Grab a run id from any `work` run's output. The agent's
report is printed at the end of the run.

## The observer, observed

Because observability is on, the `trace-analysis` run emits its own trace. Wait a few
seconds for ingestion, then feed *that* run's id back in:

```bash
work run trace-analysis --inputs '{"run_id":"<the-analysis-run-id>"}'
```

Now the workflow analyzes itself — the agent's own `chat {model}` span shows up in the
tree it's reading, token usage and all. It's a neat end-to-end proof that the agent
telemetry path (`gen_ai.usage.input_tokens` / `output_tokens`, cache subsets) actually
lands in Tempo, not just a claim.

## What it exercises

| In the workflow | Engine feature it leans on |
|---|---|
| `GRAFANA_TOKEN` passes into the `fetch` job, kept out of the agent job | [Secrets](../reference/configuration#secrets) — a host secret resolved at run time, isolated to one job by a `needs` split |
| `uses: action/tempo-trace` keeps the fetch/distill logic reusable | [Actions](../guide/actions) — a node action with the `INPUT_*` / `$WORK_OUTPUT` ABI |
| `uses: work/agent` reads the distilled tree and writes the report | [Agent steps](../guide/agent-steps) — a real model in the job's sandbox |
| consumes `work.run.id` / `gen_ai.usage.*` spans | [Observability](../guide/observability) — the traces this reads back |
