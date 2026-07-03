/**
 * Errors that carry a message meant for the end user — printed as a clean
 * one-liner by the CLI rather than as an "unexpected error" stack trace.
 * Used for actionable conditions like a missing optional dependency or an
 * unavailable execution target.
 *
 * Beyond the message, a user-facing error may carry structured context that makes
 * it locate-able and actionable for BOTH humans and the agents that author/run
 * workflows here:
 *   - `path` — the logical location of the offending node (`jobs.build.steps[0]`),
 *     prefixed onto the message and exposed as a field.
 *   - `hint` — a one-line, actionable remediation.
 *   - `docs` — a documentation URL for deeper context.
 * `formatUserFacing` renders these uniformly across every CLI surface; the web
 * surface reads the fields directly into its JSON response.
 */

/** Doc-site anchors referenced by error `docs:` links — centralized so the URLs
 *  don't scatter across throw sites. Served from GitHub Pages. */
const DOCS_BASE = "https://nullbytelabs.github.io/work";
export const DOCS = {
  workflowSyntax: `${DOCS_BASE}/reference/workflow-syntax`,
  configuration: `${DOCS_BASE}/reference/configuration`,
  reusableWorkflows: `${DOCS_BASE}/guide/reusable-workflows`,
} as const;

/** Structured context attached to a {@link UserFacingError}. All optional. */
export interface UserFacingErrorInit {
  /** Logical location of the offending node, e.g. `jobs.build.steps[0]`. */
  path?: string;
  /** A one-line, actionable remediation ("declare it under inputs:"). */
  hint?: string;
  /** A documentation URL for deeper context (see {@link DOCS}). */
  docs?: string;
}

export class UserFacingError extends Error {
  readonly path?: string;
  readonly hint?: string;
  readonly docs?: string;
  constructor(message: string, init: UserFacingErrorInit = {}) {
    super(init.path ? `${init.path}: ${message}` : message);
    this.name = "UserFacingError";
    if (init.path !== undefined) this.path = init.path;
    if (init.hint !== undefined) this.hint = init.hint;
    if (init.docs !== undefined) this.docs = init.docs;
  }
}

/**
 * Render a user-facing error for a terminal: the (path-prefixed) message, then
 * optional `hint:` and `see:` lines. Every CLI surface routes through this so the
 * shape is uniform for humans, while the structured `.path`/`.hint`/`.docs` fields
 * stay available for programmatic (agent) consumers.
 */
export function formatUserFacing(err: UserFacingError): string {
  const lines = [err.message];
  if (err.hint) lines.push(`  hint: ${err.hint}`);
  if (err.docs) lines.push(`  see:  ${err.docs}`);
  return lines.join("\n");
}
