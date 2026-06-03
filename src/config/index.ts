/**
 * pi-workflows config — provider/model setup for agentic (`uses: agent/…`) steps.
 *
 * A JSON file (default `./pi-workflows.config.json`, or `--config`, or
 * `PI_WORKFLOWS_CONFIG`) declares OpenAI-compatible providers and named models.
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

export interface PiWorkflowsConfig {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
  /** Model alias used when an agent step doesn't specify `with.model`. */
  defaultModel?: string;
}

/** A model + its provider's connection details, ready to call. */
export interface ResolvedModel {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/** Expand `$VAR` / `${VAR}` against the environment; pass literals through. */
function expandEnv(value: string): string {
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
  if (raw.providers !== undefined && !isObject(raw.providers)) throw new UserFacingError("config.providers must be an object");
  if (raw.models !== undefined && !isObject(raw.models)) throw new UserFacingError("config.models must be an object");

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(raw.providers ?? {})) {
    if (!isObject(p) || typeof p.baseUrl !== "string" || typeof p.apiKey !== "string") {
      throw new UserFacingError(`config.providers.${name} needs string baseUrl and apiKey`);
    }
    providers[name] = { baseUrl: p.baseUrl, apiKey: p.apiKey };
  }

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

  const config: PiWorkflowsConfig = { providers, models };
  if (raw.defaultModel !== undefined) {
    if (typeof raw.defaultModel !== "string") {
      throw new UserFacingError(`config.defaultModel must name a model in config.models`);
    }
    config.defaultModel = raw.defaultModel;
  }
  return config;
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
  return config;
}

/** Parse + validate a single config object (shape + cross-refs). */
export function parseConfig(raw: unknown): PiWorkflowsConfig {
  return validateConfig(parsePartialConfig(raw));
}

/** Project config filename — found with zero flags at the project root. */
export const PROJECT_CONFIG_FILENAME = "pi-workflows.config.json";
const GLOBAL_CONFIG_BASENAME = "config.json";

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
 * (optional), then exactly one project layer — `--config` > `$PI_WORKFLOWS_CONFIG`
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
  } else if (process.env["PI_WORKFLOWS_CONFIG"]) {
    layers.push({ path: resolve(process.env["PI_WORKFLOWS_CONFIG"]), required: true });
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
