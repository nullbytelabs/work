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
import { parse as parseYaml } from "yaml";
import { parseInputs, type InputSpec } from "../spec/index.ts";
import { UserFacingError } from "../errors.ts";

/** A declared action output: a name plus an optional human description. */
export interface ActionOutput {
  description?: string;
}

/** A loaded JS action package (cached by resolved directory). */
export interface LoadedAction {
  name: string;
  /** Absolute path to the action's directory (staged into the guest to run). */
  dir: string;
  /** Declared inputs, in the shared `InputSpec` grammar (bound from `with:`). */
  inputs: Record<string, InputSpec>;
  /** Declared output names (only these are surfaced from `$WORK_OUTPUT`). */
  outputs: string[];
  /** The entry script, relative to `dir` (`runs.main`, default `index.mjs`). */
  main: string;
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
    runs?: { using?: string; main?: string };
  };

  const using = manifest.runs?.using;
  if (using === "composite") {
    throw new UserFacingError(
      `action "${name}" uses runs.using: composite — composite actions are not yet supported`,
    );
  }
  if (using !== "node") {
    throw new UserFacingError(
      `action "${name}" must declare runs.using: node (got ${using ? `"${using}"` : "nothing"})`,
    );
  }

  const inputs = parseInputs(manifest.inputs, `${name}.inputs`) ?? {};
  const outputs = Array.isArray(manifest.outputs)
    ? manifest.outputs
    : Object.keys(manifest.outputs ?? {});
  const main = manifest.runs?.main ?? "index.mjs";

  const action: LoadedAction = { name, dir, inputs, outputs, main };
  cache.set(dir, action);
  return action;
}
