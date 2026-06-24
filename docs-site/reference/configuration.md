# Configuration

`work.json` declares the **providers** and **models** that
[agent steps](../guide/agent-steps) use, and optionally the **secrets** a step or
action may read and the **webhooks** that can trigger a workflow. You only
need it if your workflows run `uses: work/agent` steps, pass a declared secret into a
step, or accept webhook triggers; plain `run:` workflows need no config at
all.

## File resolution

Config is loaded in **two layers**: a machine-wide global file, then one project
layer that overrides it:

1. **Global** (lowest precedence) — `~/.config/work/work.json`
   (`$XDG_CONFIG_HOME/work/work.json` when set; `~/.work/work.json` is read as a
   legacy fallback). This is the natural home for your providers and models, shared
   across every project. Create it with `work init --global`. Skip it for a single
   run with `--no-global`.
2. **Project** (overrides global) — chosen by, in order:
   1. the path passed to `--config <file>`,
   2. the path in `$WORK_CONFIG`,
   3. `./work.json` in the working directory, if it exists.

An absent config is fine until an agent step actually needs a model.

::: tip Scaffold it
`work init` writes a starter project `work.json`, and
`work init --global` writes the machine-wide one. Neither ever overwrites an
existing config.
:::

## How the layers merge

The two layers are **deep-merged**, with the project layer winning:

- `providers`, `models`, `secrets`, and `webhooks` are unioned by key; on a
  collision the project layer's entry **replaces** the global one wholesale (no
  field-level merging).
- `defaultModel` is last-writer-wins (the project layer's, if set).
- An omitted or empty map inherits the lower layer, so a project config can shrink
  to just `{ "defaultModel": "kimi" }` once the global file supplies the catalog.

Cross-references are validated **after** merging, not per file. That's what lets a
project layer reference a model whose `provider` is declared only in the global
file. A layer that looks "incomplete" on its own is still valid once merged.

## Shape

```json
{
  "providers": {
    "fireworks": {
      "baseUrl": "https://api.fireworks.ai/inference/v1",
      "apiKey": "$FIREWORKS_API_KEY"
    }
  },
  "models": {
    "kimi": {
      "provider": "fireworks",
      "model": "accounts/fireworks/models/kimi-k2p6",
      "maxTokens": 32768,
      "temperature": 0
    }
  },
  "defaultModel": "kimi"
}
```

### `providers`

A map of provider name → connection details. Providers are **OpenAI-compatible**
endpoints.

| Field | Type | Notes |
|---|---|---|
| `baseUrl` | string | **Required.** The OpenAI-compatible base URL. |
| `apiKey` | string | **Required.** The API key. Supports `$VAR` / `${VAR}` env expansion. |

### `models`

A map of model alias → model definition. The alias is what you reference (and what
`defaultModel` points at).

| Field | Type | Notes |
|---|---|---|
| `provider` | string | **Required.** A key in `providers` — in the *merged* config, so it may be declared in the global layer. Validation fails if it exists nowhere. |
| `model` | string | **Required.** The provider-native model id. |
| `maxTokens` | number | Optional. Max tokens for the response. |
| `temperature` | number | Optional. Sampling temperature. |

### `defaultModel`

| Field | Type | Notes |
|---|---|---|
| `defaultModel` | string | Optional. The model alias used when an agent step doesn't specify one. Must name a model in `models`. |

## `secrets`

A flat whitelist of host secrets a workflow may address as
<code v-pre>${{ secrets.&lt;name&gt; }}</code>. The secret's **name** is the key; its **value**
is a literal **or** a `$VAR` / `${VAR}` env reference (the same pattern as a model
`apiKey`), resolved host-side at run time. A referenced secret flows **into the guest
environment** of the step or action that reads it — so a CLI that must hold the
credential to sign a request (`aws`, `gcloud`, `kubectl`) just works, and an action
can forward the value in a request header. Only listed names are addressable; the file
is the explicit boundary between secrets on your host and secrets a guest may see.

```json
{
  "secrets": {
    "AWS_ACCESS_KEY_ID": "$AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY": "$AWS_SECRET_ACCESS_KEY",
    "DEPLOY_PAT": "ghp_xxx"
  }
}
```

```yaml
jobs:
  deploy:
    steps:
      - run: aws eks update-kubeconfig --name prod
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
      - run: kubectl get pods
```

<code v-pre>${{ secrets.* }}</code> resolves at run time (it never bakes into the durable plan or run
history) and works in `run:`, `env:`, and a step's `with:` — including a
`work/agent` step, when you intentionally hand an agent a credential. It is **not**
available in `if:` conditions (a condition can't branch on a secret).

If a workflow references a secret that **can't be fulfilled** — not declared here,
or declared as a `$VAR` that isn't set in the environment — the run **fails up
front** with a message naming each one, before any job starts. Only secrets the
workflow actually references are checked, so an unrelated declared secret with an
unset var never blocks a run.

::: tip Keep a secret out of an agent's reach
A secret flows into the env of the step that reads it. To use a credential
*without* exposing it to a later agent step, split the work across jobs: put the
secret-using step in one job (say `fetch`) that publishes its result as a job
[output](./workflow-syntax#outputs), then have a second job
(`analyze`, `needs: [fetch]`) consume <code v-pre>${{ needs.fetch.outputs.&lt;name&gt; }}</code>.
The agent job never has the secret in scope. The
[trace-analysis example](../examples/trace-analysis) does exactly this.
:::

::: info Egress is open
Jobs reach the network freely — there's no egress allowlist to maintain. The
sandbox's job is isolating your **host** (filesystem, processes), not walling jobs
off from the internet. The only secret kept out of the guest is the model API key,
injected **host-side** and scoped to the model endpoint for `work/agent` steps.
:::

## `webhooks`

A map of hook name → a [webhook receiver](../guide/web-ui#webhook-triggers) the web
console exposes at `POST /hooks/<name>`. Each entry names the `workflow` it
triggers and carries that hook's auth scheme and secret. A workflow is only
reachable if it **also** opts in with [`on: webhook`](./workflow-syntax#triggers) —
config alone can't make a workflow webhook-triggerable.

```json
{
  "webhooks": {
    "alertmanager": {
      "workflow": "alert-triage",
      "auth": "hmac-sha256",
      "secret": "$ALERTMANAGER_WEBHOOK_SECRET",
      "signatureHeader": "X-Hub-Signature-256"
    }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `workflow` | string | **Required.** The workflow `name:` this hook triggers. |
| `enabled` | boolean | Optional operator toggle. Absent means enabled; set `false` to disable the hook without removing its config. |
| `auth` | `"hmac-sha256"` \| `"bearer"` | Delivery auth scheme. |
| `secret` | string | Per-hook secret; literal, or `$VAR` / `${VAR}`. Verified constant-time. |
| `signatureHeader` | string | Header the signature/token arrives in, e.g. `X-Hub-Signature-256`. |

The receiver is **fail-closed**: a delivery is rejected unless the workflow opted
in, a matching hook exists, and the request authenticates. Deliveries are de-duped
(replay protection), size-capped, and parsed only after auth, and the audit log
the console shows never stores the payload or the secret. See the
[serve host guide](../guide/web-ui#webhook-triggers) for the end-to-end flow.

## `observability`

Opt-in [OpenTelemetry](../guide/observability) traces + metrics for your runs, pushed
over OTLP to any collector (a local one, or a hosted backend). Absent or `enabled: false`
⇒ off, and nothing about OTel is even loaded.

```json
{
  "observability": {
    "enabled": true,
    "otlpEndpoint": "http://localhost:4318",
    "headers": { "Authorization": "Bearer $OTEL_EXPORTER_TOKEN" },
    "metricExportIntervalMs": 15000
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `enabled` | boolean | Turn it on. Defaults off — but the standard `OTEL_EXPORTER_OTLP_ENDPOINT` env var also enables it. |
| `otlpEndpoint` | string | OTLP/HTTP base, e.g. `http://localhost:4318`. The exporters append `/v1/traces` and `/v1/metrics`. Defaults to `http://localhost:4318`. |
| `headers` | object | Headers added to every OTLP export — typically auth for a hosted collector. Values support `$VAR` / `${VAR}` (so the token stays in the environment). Takes precedence over `OTEL_EXPORTER_OTLP_HEADERS`. |
| `metricExportIntervalMs` | number | How often metrics are pushed. Default `15000`. |
| `traces` / `metrics` | `{ enabled?: boolean }` | Toggle either signal independently. Both on by default. |

The standard `OTEL_*` environment variables (`OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, …) are honored too, so you can run
fully config-free; explicit config wins where both are set. See the
[Observability guide](../guide/observability) for what lands and how to view it.

## Secrets and env expansion

`apiKey`, a `secrets` value, webhook `secret`, and `observability` header values
support `$VAR` and `${VAR}` expansion against the host environment, so the file itself
need not hold any secret:

```json
{ "apiKey": "$FIREWORKS_API_KEY" }
```

::: danger Don't commit literal keys
Always reference an environment variable rather than pasting a literal key into the
file. A key committed to git is a leaked key; rotate it if that happens.
:::

## How the key reaches the model

For an agent step, the host injects the API key into the model request **host-side**,
scoped to the model endpoint. The key is never written into the guest, so it isn't
visible to anything running inside the micro-VM, including the agent's own tools.
See [How it works](../guide/how-it-works#agent-steps).

## Example

A complete example ships in the repo as
[`work.example.json`](https://github.com/nullbytelabs/work/blob/main/work.example.json).
Any OpenAI-compatible provider works — point `baseUrl` at your endpoint and set the
matching key.
