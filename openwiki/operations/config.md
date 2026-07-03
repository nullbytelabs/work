# Configuration (`work.json`)

`work.json` is the project's configuration file — providers, models, secrets, webhooks, and observability. It's loaded by `src/config/index.ts` and feeds the agent egress resolver, the webhook receiver, the scheduler, and the telemetry bootstrap.

A minimal config (agent steps need a model):

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
      "maxTokens": 32768
    }
  },
  "defaultModel": "kimi"
}
```

See [`work.example.json`](../../work.example.json) for a complete, self-documenting starter.

## The Full Shape

```typescript
interface WorkConfig {
  providers: Record<string, ProviderConfig>;   // required
  models: Record<string, ModelConfig>;          // required
  defaultModel?: string;                         // model alias for steps with no `with.model`
  secrets?: Record<string, string>;              // whitelist of host secrets
  webhooks?: Record<string, WebhookConfig>;      // named webhook receivers
  observability?: ObservabilityConfig;           // OTLP traces + metrics
}
```

| Field | Purpose |
|---|---|
| `providers` | Named OpenAI-compatible endpoints — `baseUrl` + `apiKey`. |
| `models` | Named model aliases, each pointing at a `provider` + native model id. Optional `maxTokens` / `temperature`. |
| `defaultModel` | The alias used when an agent step omits `with.model`. |
| `secrets` | A whitelist of host secrets addressable as `${{ secrets.<name> }}` in workflows. |
| `webhooks` | Named webhook receivers — see [Serving, Triggers & Observability](serve-and-triggers.md). |
| `observability` | OTLP traces + metrics — see [Serving, Triggers & Observability](serve-and-triggers.md). |

`WebhookConfig` per entry: `workflow` (required), `enabled?` (absent = enabled — an operator toggle), `auth?` (`"hmac-sha256"` | `"bearer"`), `secret?`, `signatureHeader?` (e.g. `X-Hub-Signature-256`).

`ObservabilityConfig`: `enabled?`, `otlpEndpoint?`, `headers?` (with `$VAR` expansion, takes precedence over `OTEL_EXPORTER_OTLP_HEADERS`), `metricExportIntervalMs?` (default 15000), `traces?: { enabled? }`, `metrics?: { enabled? }` — independent signal toggles so you can emit traces without metrics or vice versa. An empty `traces: {}` is valid and means "enable traces with defaults" (defaults to `true` in `resolveTelemetry`).

## `$VAR` Expansion

`apiKey`, webhook `secret`, and observability `headers` values support `$VAR` / `${VAR}` environment-variable expansion — secrets stay in your environment, never committed to the file. The expansion regex is **case-insensitive** (the `gi` flag), so `$var` and `$VAR` both work. There are two expansion modes (`src/config/index.ts`):

- **`expandEnv`** (lenient) — a missing variable expands to `""`. Used for optional probes (e.g. the webhook secret check, which then fails closed).
- **`expandEnvStrict`** (strict) — a missing variable **throws**. Used for credentials that are actually injected and used (an unset `apiKey` is a loud error, not a silent empty string).

## Secrets

The `secrets` block is a flat `name → value` whitelist. Values are literals or `$VAR` / `${VAR}` env references:

```json
{
  "secrets": {
    "DEPLOY_TOKEN": "$DEPLOY_TOKEN",
    "grafana_token": "$GRAFANA_TOKEN"
  }
}
```

Whitelisted secrets are resolved **host-side** and flow into the guest environment, where a step or action reads them (e.g. a CLI that must hold the credential to sign — `aws`/`gcloud`/`kubectl` — or an action that forwards the token in a request header). **Anything not listed is unaddressable.** A workflow that references `${{ secrets.foo }}` where `foo` isn't in the whitelist fails before any work begins — `startRun()` (`src/run.ts`) scans the plan for `secrets.*` references and fails fast against the whitelist.

> Secrets are resolved at **runtime** only and never baked into the durable journal — see the two-phase expression resolution in [Architecture](../architecture/architecture.md). They are also deliberately excluded from the condition context and job-output interpolation to prevent leaking via skip-pattern branches or journaled outputs.

## Layered Config (Global + Project)

Config is loaded in layers (lowest precedence first), merged, then cross-validated once (`src/config/index.ts`):

1. **Global layer** (optional, read-only at run time) — the first existing of:
   - `$XDG_CONFIG_HOME/work/work.json`
   - `~/.config/work/work.json` (the XDG default)
   - `~/.work/work.json` (legacy read-only fallback for early adopters)

2. **Project layer** — exactly one of:
   - `--config <file>` (required to exist)
   - `$WORK_CONFIG` (required to exist)
   - `./work.json` (optional — absent = no project config)

`--no-global` drops the global layer for a hermetic run. The global config is the natural home for `providers` / `models` (shared across every project); project configs hold the per-project `webhooks` / `secrets` / `observability`. Note: `globalConfigWritePath()` (used by `work init --global`) writes to XDG only — the legacy `~/.work` fallback is deliberately **never** written to, only read.

### Merge Semantics

`mergeConfig(base, over)` (`src/config/index.ts`):

- `providers`, `models`, `webhooks`, `secrets` — merge **by key**; a colliding entry is replaced **wholesale** (predictable — no field-level merge). An omitted map inherits the lower layer.
- `defaultModel` — last-writer-wins.
- `observability` — later layer overrides the whole block wholesale.

### Cross-Reference Validation

`validateConfig()` runs **once** on the merged result (`src/config/index.ts`):

- Every `models.<alias>.provider` must exist in `providers`.
- `defaultModel` (if set) must name a model in `models`.
- Every `webhooks.<name>.workflow` must be a non-empty string.

## JSONC Support

`work.json` is parsed as **JSONC** — `//` line comments, `/* */` block comments, and trailing commas are all accepted (`stripJsonc`). The scaffolded starter config is itself self-documenting JSONC. `work doctor` and the config loader use the same parser.

## Key Source References

| Area | Key files |
|---|---|
| Config types, loading, merge, validation | `src/config/index.ts` |
| Starter config | `work.example.json` |
| Secrets fail-fast scan | `src/run.ts` |
| Webhook receiver | `src/web/server.ts` |
| Telemetry bootstrap | `src/observability/bootstrap.ts` |
