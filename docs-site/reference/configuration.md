# Configuration

`pi-workflows.config.json` declares the **providers** and **models** that
[agent steps](../guide/agent-steps) use. You only need it if your workflows run
`uses: agent/<name>` steps — plain `run:` workflows need no config at all.

## File resolution

Config is loaded in **two layers** — a machine-wide global file, then one project
layer that overrides it:

1. **Global** (lowest precedence) — `~/.config/work/config.json`
   (`$XDG_CONFIG_HOME/work/config.json` when set; `~/.work/config.json` is read as a
   legacy fallback). This is the natural home for your providers and models, shared
   across every project. Create it with `work init --global`. Skip it for a single
   run with `--no-global`.
2. **Project** (overrides global) — chosen by, in order:
   1. the path passed to `--config <file>`,
   2. the path in `$PI_WORKFLOWS_CONFIG`,
   3. `./pi-workflows.config.json` in the working directory, if it exists.

An absent config is fine until an agent step actually needs a model.

::: tip Scaffold it
`work init` writes a starter project `pi-workflows.config.json`, and
`work init --global` writes the machine-wide one. Neither ever overwrites an
existing config.
:::

## How the layers merge

The two layers are **deep-merged**, with the project layer winning:

- `providers` and `models` are unioned by key; on a collision the project layer's
  entry **replaces** the global one wholesale (no field-level merging).
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
      "maxTokens": 2048,
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

## Secrets and env expansion

`apiKey` values support `$VAR` and `${VAR}` expansion against the host environment,
so the file itself need not hold any secret:

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
[`pi-workflows.config.example.json`](https://github.com/nullbytelabs/pi-workflows/blob/main/pi-workflows.config.example.json).
Any OpenAI-compatible provider works — point `baseUrl` at your endpoint and set the
matching key.
