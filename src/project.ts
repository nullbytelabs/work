/**
 * Project layout — where a workflow lives and what its "checkout" is.
 *
 * Mirrors GitHub Actions' `.github/workflows/` convention: a project keeps its
 * pipeline definitions (and workflow-local assets like agent packages) in a
 * `.workflows/` directory, and the *project root* — the parent of `.workflows/`
 * — is the checkout that jobs operate on (`npm install`, `npm start`, source
 * files, …). When a workflow file is NOT inside a `.workflows/` directory, its
 * own folder serves as both (the simple single-file-example case).
 */
import { basename, dirname, join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { UserFacingError } from "./errors.ts";

/** The directory name that marks a project's workflow assets (like `.github`). */
export const WORKFLOWS_DIR = ".workflows";

export interface WorkflowLayout {
  /** Absolute path to the workflow definition file. */
  file: string;
  /**
   * Directory holding the workflow file and its local assets — notably agent
   * packages under `<workflowDir>/agents/<name>/`.
   */
  workflowDir: string;
  /**
   * The project/checkout root staged into each job's working directory: the
   * parent of `.workflows/`, or the workflow's own folder otherwise.
   */
  workspaceSource: string;
}

/** Resolve a workflow file path into its {file, workflowDir, workspaceSource}. */
export function resolveWorkflowLayout(file: string): WorkflowLayout {
  const abs = resolve(file);
  const workflowDir = dirname(abs);
  const workspaceSource = basename(workflowDir) === WORKFLOWS_DIR ? dirname(workflowDir) : workflowDir;
  return { file: abs, workflowDir, workspaceSource };
}

/**
 * Resolve a workflow by its `name:` within a project's `.workflows/` directory.
 * Powers `pi-workflows [--workspace <dir>] run <name>`: a project keeps its
 * pipelines in `<workspace>/.workflows/*.yaml`, and you invoke one by the name
 * declared inside it (e.g. `run ci` finds the file whose `name: ci`). The
 * matched file flows through `resolveWorkflowLayout`, so the checkout is the
 * project root exactly as if the path had been passed directly.
 */
export async function findWorkflowByName(workspace: string, name: string): Promise<WorkflowLayout> {
  const root = resolve(workspace);
  const dir = join(root, WORKFLOWS_DIR);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new UserFacingError(
      `no ${WORKFLOWS_DIR}/ directory in ${root} — run from a project that has one, or pass --workspace <dir>`,
    );
  }

  // Top-level YAML files only (agents/ and other subdirs are not pipelines).
  const files = entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => join(dir, e.name))
    .sort();

  const matches: string[] = [];
  const available = new Set<string>();
  for (const file of files) {
    let wfName: unknown;
    try {
      wfName = (parseYaml(await readFile(file, "utf-8")) as { name?: unknown } | null)?.name;
    } catch {
      continue; // a malformed file isn't a candidate; the parser reports it if selected directly
    }
    if (typeof wfName === "string" && wfName.length > 0) {
      available.add(wfName);
      if (wfName === name) matches.push(file);
    }
  }

  if (matches.length === 0) {
    const list = available.size ? ` (available: ${[...available].sort().join(", ")})` : " (none found)";
    throw new UserFacingError(`no workflow named "${name}" in ${dir}${list}`);
  }
  if (matches.length > 1) {
    throw new UserFacingError(`workflow name "${name}" is ambiguous — defined in: ${matches.join(", ")}`);
  }
  return resolveWorkflowLayout(matches[0]!);
}

/**
 * Map of declared `name:` -> file path for the top-level workflows in
 * `<workspace>/.workflows/`. Empty when there's no `.workflows/` dir yet. Powers
 * the `create` name-uniqueness guard (a duplicate `name:` makes `run` ambiguous),
 * reusing the same top-level-YAML scan as `findWorkflowByName`.
 */
export async function listWorkflowNames(workspace: string): Promise<Map<string, string>> {
  const dir = join(resolve(workspace), WORKFLOWS_DIR);
  const names = new Map<string, string>();

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return names; // no .workflows/ yet — nothing to collide with
  }

  const files = entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => join(dir, e.name))
    .sort();

  for (const file of files) {
    let wfName: unknown;
    try {
      wfName = (parseYaml(await readFile(file, "utf-8")) as { name?: unknown } | null)?.name;
    } catch {
      continue; // malformed file isn't a real declaration
    }
    if (typeof wfName === "string" && wfName.length > 0 && !names.has(wfName)) names.set(wfName, file);
  }
  return names;
}
