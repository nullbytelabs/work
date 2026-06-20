# Configuration

`work.json` declares the **providers** and **models** that
[agent steps](../guide/agent-steps) use, and optionally the **datasources** a
`run:` step may reach and the **webhooks** that can trigger a workflow. You only
need it if your workflows run `uses: work/agent` steps, call out to a declared
datasource, or accept webhook triggers; plain `run:` workflows need no config at
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

- `providers`, `models`, `datasources`, and `webhooks` are unioned by key; on a
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

## `datasources`

A map of datasource name → an external HTTP service a `run:` step reaches with a
header secret injected **host-side**. Like a provider's `apiKey`, the `token` is
operator-owned and supports `$VAR` / `${VAR}` expansion, so the file need not hold
it. The point is **token isolation**: the guest sees a placeholder env var, never
the real token — the engine swaps it into the outbound header for the datasource's
host only. Reach for a datasource when a token must **never** enter the guest; for a
credential a CLI must hold to sign (`aws`/`kubectl`), use [`secrets`](#secrets)
instead.

```json
{
  "datasources": {
    "grafana": {
      "baseUrl": "https://grafana.example.com",
      "token": "$GRAFANA_TOKEN",
      "tokenHeader": "Authorization",
      "tokenEnv": "GRAFANA_TOKEN"
    }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `baseUrl` | string | **Required.** Its host scopes the injected token — the secret rides the outbound header for this host only. |
| `token` | string | Secret token; literal, or `$VAR` / `${VAR}`. Injected into the outbound request host-side. |
| `tokenHeader` | string | Outbound header the token rides in (defaults to the target's default, e.g. `Authorization`). |
| `tokenEnv` | string | Env-var name the `run:` step references for the placeholder (defaults to `<NAME>_TOKEN`). |
| `resolve` | string | Pin the address the engine dials, like `curl --resolve` — an IP literal the `baseUrl` hostname maps to host-side. For an upstream public DNS can't name: a local Postgres on loopback, a docker-published port, an SSH tunnel, a local kind cluster. Pinning is an explicit grant, so it also lifts the sandbox's private-address block for the pinned IP. |

Scoping is per run: a webhook-triggered run gets the hook's `datasources` list; a
CLI run opts in with `--datasources <a,b>`. Without either, jobs get no datasource
access.

## `secrets`

A flat whitelist of host secrets a workflow may address as
`${{ secrets.<name> }}`. Each value is a literal **or** a `$VAR` / `${VAR}` env
reference (the same pattern as a model `apiKey` or a datasource `token`), expanded
host-side at run time. A whitelisted secret is materialized **into the step's guest
environment** — so a CLI that must hold the credential to sign a request
(`aws`, `gcloud`, `kubectl`) just works. Only listed names are addressable; the file
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

`${{ secrets.* }}` resolves at run time (it never bakes into the durable plan or run
history) and works in `run:`, `env:`, and a step's `with:` — including a
`work/agent` step, when you intentionally hand an agent a credential. It is **not**
available in `if:` conditions (a condition can't branch on a secret).

::: tip secrets vs datasources
Both pull a credential from `work.json`. A **datasource** keeps the token *out* of
the guest (header-swap, host-side) — best when the workload only needs an HTTP call
made on its behalf. **secrets** put the value *in* the guest — necessary when the
tool itself must hold the credential (client-side signing: AWS SigV4, kubeconfig).
The micro-VM still isolates your host either way.
:::

::: info Egress is open
Jobs reach the network freely — there's no egress allowlist to maintain. The
sandbox's job is isolating your **host** (filesystem, processes), and provider
tokens are kept out of agent calls by the header-swap above; walling off the
network on a `run:` job you wrote yourself only added friction, so it's gone.
Reaching *internal/private* addresses still takes an explicit datasource
[`resolve`](#datasources) pin.
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
      "signatureHeader": "X-Hub-Signature-256",
      "datasources": ["grafana"]
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
| `datasources` | string[] | Datasource keys the triggered run may use — scopes egress for that run. |

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

`apiKey`, datasource `token`, webhook `secret`, and `observability` header values
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

For an agent step, the host resolves the model endpoint, allowlists it through the
sandbox's mediated egress, and injects the API key **host-side**. The key is never
written into the guest, so it isn't visible to anything running inside the micro-VM,
including the agent's own tools. See [How it works](../guide/how-it-works#agent-steps).

## Example

A complete example ships in the repo as
[`work.example.json`](https://github.com/nullbytelabs/work/blob/main/work.example.json).
Any OpenAI-compatible provider works — point `baseUrl` at your endpoint and set the
matching key.
