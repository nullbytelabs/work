/**
 * One shared slug function for scaffolding. A generated workflow's filename, its
 * `name:`, and any `uses: agent/<name>` ref must all agree and all be valid — and
 * the strictest consumer is the agent parser, whose charset is `^[a-z0-9][a-z0-9-]*$`
 * (`parseAgentUses`, src/agent/index.ts). Slugging through here once guarantees a
 * generated `uses:` ref is always resolvable.
 */
import { UserFacingError } from "../errors.ts";

/** The charset enforced by `parseAgentUses` — the tightest downstream consumer. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Normalize a user-supplied name to a valid slug: lowercase, runs of
 * non-alphanumerics collapse to a single `-`, with leading/trailing `-` trimmed.
 * Throws a UserFacingError when nothing valid remains (e.g. "!!!" or "").
 */
export function slug(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!SLUG_RE.test(s)) {
    throw new UserFacingError(
      `"${input}" has no valid slug — names must contain letters or digits and become ` +
        `lowercase a-z, 0-9 and hyphens (e.g. "deploy", "build-and-test").`,
    );
  }
  return s;
}
