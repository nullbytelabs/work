# Configuration

`pi-workflows.config.json` declares the **providers** and **models** that
[agent steps](../guide/agent-steps) use. You only need it if your workflows run
`uses: agent/<name>` steps — plain `run:` workflows need no config at all.

## File resolution

The engine looks for config in this order:

1. The path passed to `--config <file>`.
2. The path in `$PI_WORKFLOWS_CONFIG`.
3. `./pi-workflows.config.json` in the working directory, if it exists.

An absent config is fine until an agent step actually needs a model.

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
| `provider` | string | **Required.** A key in `providers`. Must exist, or config validation fails. |
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
