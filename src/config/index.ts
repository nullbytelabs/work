/**
 * pi-workflows config — provider/model setup for agentic (`uses: agent/…`) steps.
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
 * A named external data source a plain `run:` step may reach with an injected
 * header secret (e.g. grafana, an internal API). Like `providers`, the secret
 * `token` is operator-owned and supports `$VAR` / `${VAR}` expansion so the file
 * itself need not hold it. The `datasource` egress resolver derives the allowlist
 * host from `baseUrl` and injects `token` host-side only — the guest references
 * the placeholder env var (`tokenEnv`) but **never sees the real value** (Gondolin
 * swaps it into the outbound header for the allowlisted host only).
 */
export interface DatasourceConfig {
  /** Base URL; its host is the egress allowlist entry for this datasource. */
  baseUrl: string;
  /** Secret token; literal, or `$VAR` / `${VAR}` to read from the environment. */
  token?: string;
  /** Outbound header the swapped token rides in (default the target's default, e.g. Authorization). */
  tokenHeader?: string;
  /**
   * Env-var name the `run:` step references (e.g. `$GRAFANA_TOKEN`). The resolver
   * injects the real value under this name; the guest only ever sees the
   * placeholder. Defaults (per the resolver) to `<NAME>_TOKEN` from the datasource key.
   */
  tokenEnv?: string;
}

/**
 * A named webhook receiver entry (per §9). The committed workflow names this via
 * `on: webhook: { secret: <name> }` — a *reference*, never a secret. Each hook
 * carries its own `$ENV` secret (per-hook scoping) and may declare which
 * `datasources` its triggered run is allowed to use (passed to the datasource
 * egress resolver as the scoping allowlist).
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
  /** Datasource keys this hook's triggered run may use (scopes the egress resolver). */
  datasources?: string[];
}

export interface PiWorkflowsConfig {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
  /** Model alias used when an agent step doesn't specify `with.model`. */
  defaultModel?: string;
  /** Named external data sources a plain `run:` step may reach (egress + header secret). */
  datasources?: Record<string, DatasourceConfig>;
  /** Named webhook receivers (operator-owned; referenced by `on: webhook`). */
  webhooks?: Record<string, WebhookConfig>;
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
 * Expand `$VAR` / `${VAR}` against the environment; pass literals through.
 * Exported so the egress resolvers reuse the *same* secret-expansion semantics
 * the model `apiKey` uses (one secret surface: `$ENV` in config -> real value
 * injected host-side only).
 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_m, a, b) => process.env[a ?? b] ?? "");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  // `datasources`/`webhooks` are OPTIONAL — absent is fine. Shape-only validation
  // here (no cross-refs): a webhook may name a datasource defined in a *different*
  // layer, so we only reject malformed-in-isolation entries now; cross-refs live
  // in `validateConfig` post-merge, matching the providers/models philosophy.
  const datasources = parseDatasources(raw);
  if (datasources) config.datasources = datasources;
  const webhooks = parseWebhooks(raw);
  if (webhooks) config.webhooks = webhooks;
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

function parseDatasources(raw: Record<string, unknown>): Record<string, DatasourceConfig> | undefined {
  if (raw.datasources === undefined) return undefined;
  if (!isObject(raw.datasources)) throw new UserFacingError("config.datasources must be an object");
  const datasources: Record<string, DatasourceConfig> = {};
  for (const [name, d] of Object.entries(raw.datasources)) {
    if (!isObject(d) || typeof d.baseUrl !== "string") {
      throw new UserFacingError(`config.datasources.${name} needs a string baseUrl`);
    }
    const label = `config.datasources.${name}`;
    const dc: DatasourceConfig = { baseUrl: d.baseUrl };
    const token = optStr(d.token, `${label}.token`);
    if (token !== undefined) dc.token = token;
    const tokenHeader = optStr(d.tokenHeader, `${label}.tokenHeader`);
    if (tokenHeader !== undefined) dc.tokenHeader = tokenHeader;
    const tokenEnv = optStr(d.tokenEnv, `${label}.tokenEnv`);
    if (tokenEnv !== undefined) dc.tokenEnv = tokenEnv;
    datasources[name] = dc;
  }
  return datasources;
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
  if (w.datasources !== undefined) {
    if (!Array.isArray(w.datasources) || !w.datasources.every((s) => typeof s === "string")) {
      throw new UserFacingError(`${label}.datasources must be an array of strings`);
    }
    wc.datasources = w.datasources as string[];
  }
  return wc;
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

  // `datasources`/`webhooks` merge by key like providers/models — a colliding
  // entry replaced wholesale; an omitted map inherits the lower layer (so we only
  // set the merged key when at least one layer supplied it).
  if (base.datasources || over.datasources) {
    merged.datasources = { ...base.datasources, ...over.datasources };
  }
  if (base.webhooks || over.webhooks) {
    merged.webhooks = { ...base.webhooks, ...over.webhooks };
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

  // Cross-refs for the new sections, run once post-merge. Kept LENIENT: a webhook
  // may legitimately reference a datasource defined in another layer, so we only
  // validate a webhook's datasource refs when the merged config actually has a
  // `datasources` map (i.e. some layer declared one) — otherwise we can't tell a
  // typo from a still-to-be-merged layer and stay quiet.
  for (const [name, w] of Object.entries(config.webhooks ?? {})) {
    if (w.workflow.trim() === "") {
      throw new UserFacingError(`config.webhooks.${name}.workflow must be a non-empty string`);
    }
    if (w.datasources && config.datasources) {
      for (const ds of w.datasources) {
        if (!(ds in config.datasources)) {
          throw new UserFacingError(`config.webhooks.${name} references unknown datasource "${ds}"`);
        }
      }
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
      raw = JSON.parse(text);
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
    apiKey: expandEnv(provider.apiKey),
    model: model.model,
  };
  if (model.maxTokens !== undefined) resolved.maxTokens = model.maxTokens;
  if (model.temperature !== undefined) resolved.temperature = model.temperature;
  return resolved;
}
