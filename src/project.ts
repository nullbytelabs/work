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
import { basename, dirname, resolve } from "node:path";

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
