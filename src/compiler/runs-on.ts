/**
 * `runs-on` grammar. Two namespaces:
 *
 *   gondolin          the stock upstream guest (today's behavior)
 *   work:<variant>    one of our custom images (a Gondolin build-config we resolve
 *                     + build, booted by image selector) — e.g. `work:base`
 *
 * Parsing is shared by the compiler (which validates shape at compile time) and
 * the target factory (which acts on it at run time). It is pure — resolving and
 * building a `work:*` image is a runtime concern, not the grammar's.
 */

export interface RunsOnSpec {
  namespace: "gondolin" | "work";
  /** The image variant for the `work` namespace (kebab-case), e.g. `base`. */
  variant?: string;
}

/** Image variant: kebab-case (lowercase letters/digits, hyphen-separated). */
const VARIANT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parse a `runs-on` value into its namespace + optional variant. Throws an `Error`
 * with a human-readable message on a malformed value; callers map it to their own
 * error type (the compiler to a `WorkflowCompileError`, the factory trusts
 * already-compiled input).
 */
export function parseRunsOn(value: string): RunsOnSpec {
  if (value === "gondolin") return { namespace: "gondolin" };
  if (value === "local") {
    throw new Error(
      `"runs-on: local" has been removed — every job runs in the gondolin sandbox. ` +
        `Drop the line (gondolin is the default) or set "runs-on: gondolin".`,
    );
  }
  const m = /^work:(.*)$/.exec(value);
  if (m) {
    const variant = m[1]!;
    if (!VARIANT_RE.test(variant)) {
      throw new Error(
        `invalid work image "${variant}" in "runs-on: ${value}" — use a kebab-case name (lowercase letters, digits, hyphens), e.g. "work:base".`,
      );
    }
    return { namespace: "work", variant };
  }
  throw new Error(`unknown runs-on "${value}" (supported: "gondolin", or a "work:<image>" custom image).`);
}
