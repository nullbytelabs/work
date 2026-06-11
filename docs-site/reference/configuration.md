# Configuration

`work.json` declares the **providers** and **models** that
[agent steps](../guide/agent-steps) use, and — optionally — the **datasources** a
`run:` step may reach and the **webhooks** that can trigger a workflow. You only
need it if your workflows run `uses: work/agent` steps, call out to a declared
datasource, or accept webhook triggers — plain `run:` workflows need no config at
all.

## File resolution

Config is loaded in **two layers** — a machine-wide global file, then one project
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
- An omitted or empty map inherits the lower layer — so a project config can shrink
  to just `{ "defaultModel": "kimi" }` once the global file supplies the catalog.

Cross-references are validated **after** merging, not per file. That's what lets a
project layer reference a model whose `provider` is declared only in the global
file — a layer that looks "incomplete" on its own is still valid once merged.

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

A map of datasource name → an external HTTP service a plain `run:` step is allowed
to reach, with a header secret injected **host-side**. Like a provider's `apiKey`,
the `token` is operator-owned and supports `$VAR` / `${VAR}` expansion, so the file
need not hold it. Egress is **deny-by-default**: only the host derived from
`baseUrl` is allowlisted, and the guest sees a placeholder env var — never the real
token.

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
| `baseUrl` | string | **Required.** Its host is the egress allowlist entry for this datasource. |
| `token` | string | Secret token; literal, or `$VAR` / `${VAR}`. Injected into the outbound request host-side. |
| `tokenHeader` | string | Outbound header the token rides in (defaults to the target's default, e.g. `Authorization`). |
| `tokenEnv` | string | Env-var name the `run:` step references for the placeholder (defaults to `<NAME>_TOKEN`). |
| `resolve` | string | Pin the address the engine dials, like `curl --resolve` — an IP literal the `baseUrl` hostname maps to host-side. For an upstream public DNS can't name: a local Postgres on loopback, a docker-published port, an SSH tunnel, a [local kind cluster](../examples/kubernetes-triage). Pinning is an explicit grant, so it also lifts the sandbox's private-address block for the pinned IP. |

Scoping is per run: a webhook-triggered run gets the hook's `datasources` list; a
CLI run opts in with `--datasources <a,b>`. Without either, jobs get no datasource
access.

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
(replay protection), size-capped, and parsed only after auth — and the audit log
the web console shows never stores the payload or the secret. See the
[Web console guide](../guide/web-ui#webhook-triggers) for the end-to-end flow.

## Secrets and env expansion

`apiKey`, datasource `token`, and webhook `secret` values support `$VAR` and
`${VAR}` expansion against the host environment, so the file itself need not hold
any secret:

```json
{ "apiKey": "$FIREWORKS_API_KEY" }
```

::: danger Don't commit literal keys
Always reference an environment variable rather than pasting a literal key into the
file. A key committed to git is a leaked key — rotate it if that happens.
:::

## How the key reaches the model

For an agent step, the host resolves the model endpoint, allowlists it through the
sandbox's mediated egress, and injects the API key **host-side**. The key is never
written into the guest, so it isn't visible to anything running inside the micro-VM
— including the agent's own tools. See [How it works](../guide/how-it-works#agent-steps).

## Example

A complete example ships in the repo as
[`work.example.json`](https://github.com/nullbytelabs/work/blob/main/work.example.json).
Any OpenAI-compatible provider works — point `baseUrl` at your endpoint and set the
matching key.
