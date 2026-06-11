/**
 * Compose multiple per-job egress resolvers into one.
 *
 * The runtime accepts a single `resolveJobNetwork`, but egress now comes from
 * more than one source — the agent resolver (model host + key) and the datasource
 * resolver (allowlisted APIs + tokens). This unions their results into one
 * `JobNetwork` (§9: "composed with the agent resolver — union allowedHosts, merge
 * secrets by env-var name"):
 *
 *   - `allowedHosts` — set-union of every resolver's hosts. The `"*"` wildcard is
 *     absorbing: if ANY resolver returns `["*"]` (the agent resolver does), the
 *     composed allowlist is `["*"]` (a superset of any specific host). This keeps
 *     "allow everything" from being silently narrowed by a sibling resolver.
 *   - `secrets` — merged by env-var name. A name appearing in two resolvers would
 *     collide; we keep first-writer-wins (resolver order is the precedence) — in
 *     practice the agent key env and datasource token envs are distinct namespaces.
 *
 * Returns `undefined` only when every resolver returns `undefined` (nothing to
 * mediate), so a job with no egress need keeps the deny-by-default posture.
 */
import type { PlannedJob } from "../compiler/index.ts";

/** Structural `JobNetwork` (kept local to avoid an egress→runtime import cycle). */
export interface ComposedJobNetwork {
  allowedHosts?: string[];
  allowedInternalHosts?: string[];
  hostResolves?: Record<string, string>;
  secrets?: Record<string, { hosts: string[]; value: string }>;
}

type Resolver = (job: PlannedJob) => ComposedJobNetwork | undefined;

export function composeResolvers(...resolvers: Resolver[]): (job: PlannedJob) => ComposedJobNetwork | undefined {
  return (job) => {
    const parts = resolvers.map((r) => r(job)).filter((p): p is ComposedJobNetwork => p !== undefined);
    if (parts.length === 0) return undefined;

    const hostSet = new Set<string>();
    // No wildcard for internal hosts — reaching private ranges stays an explicit,
    // per-host grant even when a sibling resolver opens general egress.
    const internalSet = new Set<string>();
    let wildcard = false;
    const resolves: Record<string, string> = {};
    const secrets: Record<string, { hosts: string[]; value: string }> = {};

    for (const part of parts) {
      for (const h of part.allowedHosts ?? []) {
        if (h === "*") wildcard = true;
        else hostSet.add(h);
      }
      for (const h of part.allowedInternalHosts ?? []) internalSet.add(h);
      for (const [host, ip] of Object.entries(part.hostResolves ?? {})) {
        // First writer wins, same as secrets — two resolvers pinning one
        // hostname differently would be a config error, not a routine merge.
        if (!(host in resolves)) resolves[host] = ip;
      }
      for (const [env, secret] of Object.entries(part.secrets ?? {})) {
        // First writer wins — resolver order is the precedence. The agent and
        // datasource resolvers use disjoint env namespaces, so this is a guard,
        // not a routine merge.
        if (!(env in secrets)) secrets[env] = secret;
      }
    }

    const out: ComposedJobNetwork = {};
    const hosts = wildcard ? ["*"] : [...hostSet];
    if (hosts.length > 0) out.allowedHosts = hosts;
    if (internalSet.size > 0) out.allowedInternalHosts = [...internalSet];
    if (Object.keys(resolves).length > 0) out.hostResolves = resolves;
    if (Object.keys(secrets).length > 0) out.secrets = secrets;
    // Every part was defined, so at least one of hosts/secrets is non-empty.
    return out;
  };
}
