/**
 * Small shared helpers for the per-command parsers (`doctor`, `create`, …).
 * Usage/argument errors exit 2 and are prefixed with the *invoked* name
 * (`work`/`workflow`/`pi-workflows`, plumbed by the bin shim as `PI_WF_PROG`) —
 * matching `printUsage` rather than the legacy hardcoded `pi-workflows:` prefix.
 */

/** The invoked command name, falling back to the dev launcher's name. */
export function prog(): string {
  return process.env["PI_WF_PROG"] ?? "pi-workflows";
}

/** A usage/argument error: prefix with the invoked name and exit 2. */
export function failUsage(msg: string): never {
  process.stderr.write(`${prog()}: ${msg}\n`);
  process.exit(2);
}
