/**
 * work config — provider/model setup for agent (`uses: work/agent`) steps.
 *
 * A JSON file (default `./work.json`, or `--config`, or `WORK_CONFIG`) declares
 * OpenAI-compatible providers and named models.
 * Each deployment points this at its own endpoint/key. Secrets in `apiKey`
 * support `$VAR` / `${VAR}` env expansion so the file itself need not hold them.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { UserFacingError } from "../errors.ts";

export interface ProviderConfig {
  /** OpenAI-compatible base URL, e.g. https://api.fireworks.ai/inference/v1 */
  baseUrl: string;
  /** API key; literal, or `$VAR` / `${VAR}` to read from the environment. */
  apiKey: string;
}

export interface ModelConfig {
  /** Provider key in `providers`. */
  provider: string;
  /** Provider-native model id, e.g. accounts/fireworks/models/kimi-k2p6 */
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * A named webhook receiver entry (per §9). The committed workflow names this via
 * `on: webhook: { secret: <name> }` — a *reference*, never a secret. Each hook
 * carries its own `$ENV` secret (per-hook scoping).
 */
export interface WebhookConfig {
  /** Workflow name this hook triggers. */
  workflow: string;
  /** Whether this hook is live; an operator toggle. Absent = enabled by convention. */
  enabled?: boolean;
  /** Delivery auth scheme. */
  auth?: "hmac-sha256" | "bearer";
  /** Per-hook secret; literal, or `$VAR` / `${VAR}` — never a committed literal in practice. */
  secret?: string;
  /** Header the delivery signature/token arrives in, e.g. `X-Hub-Signature-256`. */
  signatureHeader?: string;
}

/**
 * Telemetry config: push OTLP (traces + metrics) to a collector (Grafana Alloy →
 * Tempo + Prometheus). Off unless explicitly enabled, or the standard
 * `OTEL_EXPORTER_OTLP_ENDPOINT` env var is set (resolved in `startTelemetry`). The
 * single `otlpEndpoint` is the OTLP/HTTP base; the exporters append `/v1/traces` and
 * `/v1/metrics`. See docs/observability-otel-metrics.md.
 */
export interface ObservabilityConfig {
  enabled?: boolean;
  /** OTLP/HTTP base, e.g. `http://alloy.host:4318` (or `$OTEL_EXPORTER_OTLP_ENDPOINT`). */
  otlpEndpoint?: string;
  /**
   * Headers added to every OTLP export — e.g. an auth token for a hosted collector
   * (Grafana Cloud, Honeycomb). Like `apiKey`/`token`, values support `$VAR` / `${VAR}`
   * expansion so the secret lives in the environment, not the file (fails loud if unset).
   * Takes precedence over the standard `OTEL_EXPORTER_OTLP_HEADERS` env var.
   */
  headers?: Record<string, string>;
  /** Periodic metric push interval (default 15000ms). */
  metricExportIntervalMs?: number;
  traces?: { enabled?: boolean };
  metrics?: { enabled?: boolean };
}

export interface PiWorkflowsConfig {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
  /** Model alias used when an agent step doesn't specify `with.model`. */
  defaultModel?: string;
  /**
   * Whitelist of host secrets a workflow may address as `${{ secrets.<name>}}`.
   * Each value is a literal or a `$VAR`/`${VAR}` env reference (the
   * `$FIREWORKS_TOKEN`/`$GRAFANA_TOKEN` pattern). Whitelisted secrets are resolved
   * host-side and flow into the guest env, where a step or action reads them (e.g.
   * a CLI that must hold the credential to sign, like aws/gcloud/kubectl, or an
   * action that forwards the token in a request header). Anything not listed is
   * unaddressable.
   */
  secrets?: Record<string, string>;
  /** Named webhook receivers (operator-owned; referenced by `on: webhook`). */
  webhooks?: Record<string, WebhookConfig>;
  /** OpenTelemetry traces + metrics, pushed over OTLP to a collector. */
  observability?: ObservabilityConfig;
}

/** A model + its provider's connection details, ready to call. */
export interface ResolvedModel {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Expand `$VAR` / `${VAR}` against the environment; pass literals through. A
 * **missing** variable expands to `""` — lenient on purpose, for callers where an
 * empty result means "not configured" and is handled as such (e.g. the webhook
 * secret probe, which then fails closed). For a credential that is *injected and
 * used*, prefer `expandEnvStrict`.
 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_m, a, b) => process.env[a ?? b] ?? "");
}

/**
 * Like `expandEnv`, but **throws** if a referenced variable is unset. Use for a
 * secret that gets injected and used (a model `apiKey`, a `secrets:` value),
 * where silently expanding `$MISSING` to `""` would inject a blank credential.
 * `label` names the config field in the error.
 */
export function expandEnvStrict(value: string, label: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_m, a, b) => {
    const name = a ?? b;
    const v = process.env[name];
    if (v === undefined) {
      throw new UserFacingError(`${label} references environment variable $${name}, which is not set`);
    }
    return v;
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip `//` line comments, `/* *\/` block comments, and trailing commas from
 * JSONC text. `work.json` is hand-edited, so we accept the comment-friendly
 * superset (the scaffolded starter is itself self-documenting). String-aware on
 * purpose: a `//` inside a URL or a `,]` inside a string is preserved, and
 * newlines are kept so a downstream `JSON.parse` error still points at the right
 * line.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < text.length) out += text[++i];
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      i--; // let the loop's i++ land on (and keep) the newline
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n"; // preserve line numbers
        i++;
      }
      i++; // land on the closing '/'
      continue;
    }
    out += ch;
  }
  return stripTrailingCommas(out);
}

/** Drop a comma that is followed only by whitespace before a `}` or `]`. Runs on
 *  comment-free text and stays string-aware so a comma inside a string survives. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < text.length) out += text[++i];
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue; // drop the trailing comma
    }
    out += ch;
  }
  return out;
}

/** Parse JSONC (JSON + comments + trailing commas) — `work.json`'s on-disk form. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

/**
 * Parse a config object's field types/shapes ONLY — deliberately no
 * cross-references. Because config is layered (global + project), a model whose
 * `provider` lives in a *different* layer must not be rejected here; cross-refs
 * are checked once, post-merge, by `validateConfig`. `providers`/`models` are
 * optional so a project layer can shrink to just `{ "defaultModel": "kimi" }`
 * once global supplies the catalog.
 */
export function parsePartialConfig(raw: unknown): PiWorkflowsConfig {
  if (!isObject(raw)) throw new UserFacingError("config must be a JSON object");

  const config: PiWorkflowsConfig = {
    providers: parseProviders(raw),
    models: parseModels(raw),
  };
  const defaultModel = parseDefaultModel(raw);
  if (defaultModel !== undefined) config.defaultModel = defaultModel;
  // `webhooks` is OPTIONAL — absent is fine. Shape-only validation here (no
  // cross-refs): cross-refs live in `validateConfig` post-merge, matching the
  // providers/models philosophy.
  const secrets = parseSecrets(raw);
  if (secrets) config.secrets = secrets;
  const webhooks = parseWebhooks(raw);
  if (webhooks) config.webhooks = webhooks;
  const observability = parseObservability(raw);
  if (observability) config.observability = observability;
  return config;
}

/** Validate an optional string field; throws `<label> must be a string` if present but not a string. */
function optStr(v: unknown, label: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new UserFacingError(`${label} must be a string`);
  return v;
}

function parseProviders(raw: Record<string, unknown>): Record<string, ProviderConfig> {
  if (raw.providers !== undefined && !isObject(raw.providers)) throw new UserFacingError("config.providers must be an object");
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(raw.providers ?? {})) {
    if (!isObject(p) || typeof p.baseUrl !== "string" || typeof p.apiKey !== "string") {
      throw new UserFacingError(`config.providers.${name} needs string baseUrl and apiKey`);
    }
    providers[name] = { baseUrl: p.baseUrl, apiKey: p.apiKey };
  }
  return providers;
}

function parseModels(raw: Record<string, unknown>): Record<string, ModelConfig> {
  if (raw.models !== undefined && !isObject(raw.models)) throw new UserFacingError("config.models must be an object");
  const models: Record<string, ModelConfig> = {};
  for (const [alias, m] of Object.entries(raw.models ?? {})) {
    if (!isObject(m) || typeof m.provider !== "string" || typeof m.model !== "string") {
      throw new UserFacingError(`config.models.${alias} needs string provider and model`);
    }
    const mc: ModelConfig = { provider: m.provider, model: m.model };
    if (typeof m.maxTokens === "number") mc.maxTokens = m.maxTokens;
    if (typeof m.temperature === "number") mc.temperature = m.temperature;
    models[alias] = mc;
  }
  return models;
}

function parseDefaultModel(raw: Record<string, unknown>): string | undefined {
  if (raw.defaultModel === undefined) return undefined;
  if (typeof raw.defaultModel !== "string") {
    throw new UserFacingError(`config.defaultModel must name a model in config.models`);
  }
  return raw.defaultModel;
}

/**
 * `secrets:` — a flat name → value whitelist. Each value is a string (literal or
 * `$VAR`/`${VAR}` env reference, expanded host-side at run time). Names are the
 * keys a workflow addresses as `${{ secrets.<name> }}`. Shape-only here; `$ENV`
 * expansion happens at injection time (`run.ts`).
 */
function parseSecrets(raw: Record<string, unknown>): Record<string, string> | undefined {
  if (raw.secrets === undefined) return undefined;
  if (!isObject(raw.secrets)) throw new UserFacingError("config.secrets must be an object of name → value strings");
  const secrets: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw.secrets)) {
    if (typeof v !== "string") {
      throw new UserFacingError(`config.secrets.${name} must be a string (a literal or a $VAR env reference)`);
    }
    secrets[name] = v;
  }
  return secrets;
}

function parseWebhooks(raw: Record<string, unknown>): Record<string, WebhookConfig> | undefined {
  if (raw.webhooks === undefined) return undefined;
  if (!isObject(raw.webhooks)) throw new UserFacingError("config.webhooks must be an object");
  const webhooks: Record<string, WebhookConfig> = {};
  for (const [name, w] of Object.entries(raw.webhooks)) {
    webhooks[name] = parseWebhookEntry(name, w);
  }
  return webhooks;
}

function parseWebhookEntry(name: string, w: unknown): WebhookConfig {
  if (!isObject(w) || typeof w.workflow !== "string") {
    throw new UserFacingError(`config.webhooks.${name} needs a string workflow`);
  }
  const label = `config.webhooks.${name}`;
  const wc: WebhookConfig = { workflow: w.workflow };
  if (w.enabled !== undefined) {
    if (typeof w.enabled !== "boolean") throw new UserFacingError(`${label}.enabled must be a boolean`);
    wc.enabled = w.enabled;
  }
  if (w.auth !== undefined) {
    if (w.auth !== "hmac-sha256" && w.auth !== "bearer") {
      throw new UserFacingError(`${label}.auth must be "hmac-sha256" or "bearer"`);
    }
    wc.auth = w.auth;
  }
  const secret = optStr(w.secret, `${label}.secret`);
  if (secret !== undefined) wc.secret = secret;
  const signatureHeader = optStr(w.signatureHeader, `${label}.signatureHeader`);
  if (signatureHeader !== undefined) wc.signatureHeader = signatureHeader;
  return wc;
}

/** Shape-validate the optional `observability` block (no cross-refs). */
function parseObservability(raw: Record<string, unknown>): ObservabilityConfig | undefined {
  if (raw.observability === undefined) return undefined;
  const o = raw.observability;
  if (!isObject(o)) throw new UserFacingError("config.observability must be an object");
  const out: ObservabilityConfig = {};
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== "boolean") throw new UserFacingError("config.observability.enabled must be a boolean");
    out.enabled = o.enabled;
  }
  const endpoint = optStr(o.otlpEndpoint, "config.observability.otlpEndpoint");
  if (endpoint !== undefined) out.otlpEndpoint = endpoint;
  if (o.metricExportIntervalMs !== undefined) {
    if (typeof o.metricExportIntervalMs !== "number") throw new UserFacingError("config.observability.metricExportIntervalMs must be a number");
    out.metricExportIntervalMs = o.metricExportIntervalMs;
  }
  if (o.headers !== undefined) {
    if (!isObject(o.headers)) throw new UserFacingError("config.observability.headers must be an object");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers)) {
      if (typeof v !== "string") throw new UserFacingError(`config.observability.headers.${k} must be a string`);
      headers[k] = v;
    }
    out.headers = headers;
  }
  const traces = parseSignalToggle(o.traces, "traces");
  if (traces) out.traces = traces;
  const metrics = parseSignalToggle(o.metrics, "metrics");
  if (metrics) out.metrics = metrics;
  return out;
}

/** Validate an optional `{ enabled?: boolean }` signal toggle. */
function parseSignalToggle(v: unknown, label: string): { enabled?: boolean } | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) throw new UserFacingError(`config.observability.${label} must be an object`);
  if (v.enabled === undefined) return {};
  if (typeof v.enabled !== "boolean") throw new UserFacingError(`config.observability.${label}.enabled must be a boolean`);
  return { enabled: v.enabled };
}

/**
 * Merge two config layers — `over` wins. `providers`/`models` merge by key, with
 * a colliding entry replaced *wholesale* (predictable beats field-merge); an
 * omitted/empty map inherits the lower layer. `defaultModel` is last-writer-wins.
 */
export function mergeConfig(base: PiWorkflowsConfig, over: PiWorkflowsConfig): PiWorkflowsConfig {
  const merged: PiWorkflowsConfig = {
    providers: { ...base.providers, ...over.providers },
    models: { ...base.models, ...over.models },
  };
  const defaultModel = over.defaultModel ?? base.defaultModel;
  if (defaultModel !== undefined) merged.defaultModel = defaultModel;

  // `webhooks` merges by key like providers/models — a colliding entry replaced
  // wholesale; an omitted map inherits the lower layer (so we only set the merged
  // key when at least one layer supplied it).
  if (base.secrets || over.secrets) {
    merged.secrets = { ...base.secrets, ...over.secrets };
  }
  if (base.webhooks || over.webhooks) {
    merged.webhooks = { ...base.webhooks, ...over.webhooks };
  }
  // Top-level field merge — a later layer overrides endpoint/headers/toggles wholesale.
  if (base.observability || over.observability) {
    merged.observability = { ...base.observability, ...over.observability };
  }
  return merged;
}

/** Cross-reference validation, run ONCE on the merged config. */
export function validateConfig(config: PiWorkflowsConfig): PiWorkflowsConfig {
  for (const [alias, m] of Object.entries(config.models)) {
    if (!(m.provider in config.providers)) {
      throw new UserFacingError(`config.models.${alias} references unknown provider "${m.provider}"`);
    }
  }
  if (config.defaultModel !== undefined && !(config.defaultModel in config.models)) {
    throw new UserFacingError(`config.defaultModel must name a model in config.models`);
  }

  // Cross-refs for the webhook section, run once post-merge.
  for (const [name, w] of Object.entries(config.webhooks ?? {})) {
    if (w.workflow.trim() === "") {
      throw new UserFacingError(`config.webhooks.${name}.workflow must be a non-empty string`);
    }
  }
  return config;
}

/** Parse + validate a single config object (shape + cross-refs). */
export function parseConfig(raw: unknown): PiWorkflowsConfig {
  return validateConfig(parsePartialConfig(raw));
}

/** Config filename — the same `work.json` everywhere (project root or XDG dir). */
export const PROJECT_CONFIG_FILENAME = "work.json";
const GLOBAL_CONFIG_BASENAME = "work.json";

/**
 * Candidate global-config paths in read precedence (first existing wins):
 * `$XDG_CONFIG_HOME/work/`, then `~/.config/work/` (the XDG default and CLI
 * convention), then `~/.work/` as a read-only fallback for early adopters.
 */
export function globalConfigCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const out: string[] = [];
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg) out.push(join(xdg, "work", GLOBAL_CONFIG_BASENAME));
  out.push(join(home, ".config", "work", GLOBAL_CONFIG_BASENAME));
  out.push(join(home, ".work", GLOBAL_CONFIG_BASENAME));
  return out;
}

/** The global config path to READ (first existing candidate), or undefined. */
export function resolveGlobalConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  return globalConfigCandidates(env, home).find((p) => existsSync(p));
}

/** The global config path to WRITE — XDG-first, never the legacy `~/.work` fallback. */
export function globalConfigWritePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env["XDG_CONFIG_HOME"];
  return join(xdg ?? join(home, ".config"), "work", GLOBAL_CONFIG_BASENAME);
}

/** One config file in the merge order, with whether its absence is an error. */
export interface ConfigLayer {
  path: string;
  required: boolean;
}

/**
 * The ordered config layers to load (lowest precedence first): the global file
 * (optional), then exactly one project layer — `--config` > `$WORK_CONFIG`
 * (both required-to-exist) > the default project file (optional). `--no-global`
 * drops the global layer for a hermetic run.
 */
export function resolveConfigLayers(cliPath: string | undefined, opts: { noGlobal?: boolean } = {}): ConfigLayer[] {
  const layers: ConfigLayer[] = [];
  if (!opts.noGlobal) {
    const g = resolveGlobalConfigPath();
    if (g) layers.push({ path: g, required: false });
  }
  if (cliPath) {
    layers.push({ path: resolve(cliPath), required: true });
  } else if (process.env["WORK_CONFIG"]) {
    layers.push({ path: resolve(process.env["WORK_CONFIG"]), required: true });
  } else {
    layers.push({ path: resolve(PROJECT_CONFIG_FILENAME), required: false });
  }
  return layers;
}

/**
 * Read, merge, and validate config layers. Optional layers that don't exist are
 * skipped; a required layer that's missing/unreadable throws. Cross-references
 * are validated once on the merged result. Returns `undefined` when no layer
 * loaded (so a project with no config behaves exactly as before).
 */
export async function loadMergedConfig(layers: ConfigLayer[]): Promise<PiWorkflowsConfig | undefined> {
  let merged: PiWorkflowsConfig = { providers: {}, models: {} };
  let loaded = false;
  for (const layer of layers) {
    if (!existsSync(layer.path)) {
      if (layer.required) throw new UserFacingError(`cannot read config file: ${layer.path}`);
      continue;
    }
    let text: string;
    try {
      text = await readFile(layer.path, "utf-8");
    } catch {
      throw new UserFacingError(`cannot read config file: ${layer.path}`);
    }
    let raw: unknown;
    try {
      raw = parseJsonc(text);
    } catch {
      throw new UserFacingError(`config file is not valid JSON: ${layer.path}`);
    }
    merged = mergeConfig(merged, parsePartialConfig(raw));
    loaded = true;
  }
  return loaded ? validateConfig(merged) : undefined;
}

/** Load + validate a single config file. Throws on bad JSON/shape/cross-ref. */
export async function loadConfig(path: string): Promise<PiWorkflowsConfig> {
  return (await loadMergedConfig([{ path, required: true }]))!;
}

/** Resolve a model alias (or the default) to connection details. */
export function resolveModel(config: PiWorkflowsConfig, alias?: string): ResolvedModel {
  const key = alias ?? config.defaultModel;
  if (!key) {
    throw new UserFacingError("no model specified and config has no defaultModel");
  }
  const model = config.models[key];
  if (!model) throw new UserFacingError(`model "${key}" is not defined in config.models`);
  const provider = config.providers[model.provider]!; // validated in parseConfig
  const resolved: ResolvedModel = {
    baseUrl: provider.baseUrl,
    apiKey: expandEnvStrict(provider.apiKey, `config provider "${model.provider}" apiKey`),
    model: model.model,
  };
  if (model.maxTokens !== undefined) resolved.maxTokens = model.maxTokens;
  if (model.temperature !== undefined) resolved.temperature = model.temperature;
  return resolved;
}
