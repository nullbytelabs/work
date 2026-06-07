/**
 * Loading user-space actions from `<actions-dir>/<name>/action.yaml`.
 *
 * An action is a project-owned directory (like a GitHub Actions local action),
 * the step-level reuse unit from docs/agent-primitive-and-actions.md. This
 * iteration loads **JavaScript** actions (`runs.using: node`): a `main` script the
 * engine runs in-guest with the `INPUT_*` / `$WORK_OUTPUT` ABI. Composite actions
 * (`runs.using: composite`) are a later phase and rejected with a clear message.
 *
 * The `action.yaml` `inputs:`/`outputs:` reuse the workflow input grammar
 * (`parseInputs`) and validator (`resolveInputs`), so an action's typed inputs are
 * the same surface authors already know — no second declaration language.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseInputs, type InputSpec } from "../spec/index.ts";
import { UserFacingError } from "../errors.ts";

/** A declared action output: a description and, for composite actions, a `value:`
 *  expression mapping the output to a step output (`${{ steps.x.outputs.y }}`). */
export interface ActionOutput {
  description?: string;
  value?: string;
}

/** One step of a composite action (a `run:` command or a `uses:` reference). */
export interface CompositeStep {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

/** A loaded action package (cached by resolved directory). `kind` selects how it
 *  runs: a `node` action runs a `main` script in-guest; a `composite` action runs
 *  its `steps` via the composite runner. */
export interface LoadedAction {
  name: string;
  /** Absolute path to the action's directory (staged into the guest to run). */
  dir: string;
  /** Declared inputs, in the shared `InputSpec` grammar (bound from `with:`). */
  inputs: Record<string, InputSpec>;
  /** Declared output names. */
  outputs: string[];
  /** How the action runs. */
  kind: "node" | "composite";
  /** node: the entry script, relative to `dir` (`runs.main`, default `index.mjs`). */
  main?: string;
  /** composite: the ordered steps to run. */
  steps?: CompositeStep[];
  /** composite: output name → `value:` expression, resolved after the steps run. */
  outputValues?: Record<string, string>;
}

// Keyed by resolved package directory — resolution is project-relative, so the
// same name in different projects must not collide (mirrors the agent cache).
const cache = new Map<string, LoadedAction>();

/** Parse a `uses:` value into an action name. Only `action/<name>[@ref]` today. */
export function parseActionUses(uses: string): { name: string; ref?: string } {
  const m = /^action\/([a-z0-9][a-z0-9-]*)(?:@(.+))?$/i.exec(uses.trim());
  if (!m) {
    throw new UserFacingError(`unsupported uses: "${uses}" — expected action/<name>[@ref]`);
  }
  const out: { name: string; ref?: string } = { name: m[1]! };
  if (m[2]) out.ref = m[2];
  return out;
}

/**
 * Load a JS action package `<actionsDir>/<name>/` (cached by resolved path).
 * `actionsDir` is supplied by the caller (the handler resolves it from the
 * workflow's directory) — actions are project-local, not shipped here.
 */
export async function loadAction(name: string, actionsDir: string): Promise<LoadedAction> {
  const dir = join(actionsDir, name);
  const cached = cache.get(dir);
  if (cached) return cached;

  let manifestText: string;
  try {
    manifestText = await readFile(join(dir, "action.yaml"), "utf-8");
  } catch {
    throw new UserFacingError(`unknown action "${name}" (no package at ${dir})`);
  }

  const manifest = (parseYaml(manifestText) ?? {}) as {
    inputs?: unknown;
    outputs?: Record<string, ActionOutput | null> | string[];
    runs?: { using?: string; main?: string; steps?: unknown };
  };

  const using = manifest.runs?.using;
  if (using !== "node" && using !== "composite") {
    throw new UserFacingError(
      `action "${name}" must declare runs.using: node | composite (got ${using ? `"${using}"` : "nothing"})`,
    );
  }

  const inputs = parseInputs(manifest.inputs, `${name}.inputs`) ?? {};
  const outputs = Array.isArray(manifest.outputs)
    ? manifest.outputs
    : Object.keys(manifest.outputs ?? {});

  const base = { name, dir, inputs, outputs };
  const action: LoadedAction =
    using === "composite"
      ? {
          ...base,
          kind: "composite",
          steps: parseCompositeSteps(manifest.runs?.steps, name),
          outputValues: parseOutputValues(manifest.outputs),
        }
      : { ...base, kind: "node", main: manifest.runs?.main ?? "index.mjs" };

  cache.set(dir, action);
  return action;
}

/** Names of the actions shipped inside the engine, reached via the `work/` scheme. */
export const BUILTIN_ACTIONS = ["checkout", "install-node"] as const;

/**
 * Load a built-in action shipped with the engine (`src/actions/builtin/<name>/`,
 * copied flat into `dist/` at publish). These back the `work/<name>` scheme.
 */
export function loadBuiltinAction(name: string): Promise<LoadedAction> {
  const builtinDir = fileURLToPath(new URL("./builtin", import.meta.url));
  return loadAction(name, builtinDir);
}

/** Parse a composite action's `runs.steps:` into typed steps. */
function parseCompositeSteps(raw: unknown, name: string): CompositeStep[] {
  if (!Array.isArray(raw)) {
    throw new UserFacingError(`composite action "${name}" must declare runs.steps: a list of steps`);
  }
  return raw.map((s, i) => {
    if (typeof s !== "object" || s === null) {
      throw new UserFacingError(`composite action "${name}" step ${i} must be a mapping`);
    }
    const step = s as Record<string, unknown>;
    const hasRun = typeof step["run"] === "string";
    const hasUses = typeof step["uses"] === "string";
    if (hasRun === hasUses) {
      throw new UserFacingError(`composite action "${name}" step ${i} must define exactly one of run/uses`);
    }
    const out: CompositeStep = {};
    if (typeof step["id"] === "string") out.id = step["id"];
    if (typeof step["name"] === "string") out.name = step["name"];
    if (hasRun) out.run = step["run"] as string;
    if (hasUses) out.uses = step["uses"] as string;
    if (step["with"] && typeof step["with"] === "object") out.with = step["with"] as Record<string, unknown>;
    if (step["env"] && typeof step["env"] === "object") out.env = step["env"] as Record<string, string>;
    return out;
  });
}

/** Extract composite output `value:` expressions (the mapping form only). */
function parseOutputValues(outputs: Record<string, ActionOutput | null> | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (outputs && !Array.isArray(outputs)) {
    for (const [k, v] of Object.entries(outputs)) {
      if (v && typeof v.value === "string") out[k] = v.value;
    }
  }
  return out;
}
