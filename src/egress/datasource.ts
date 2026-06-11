/**
 * Per-job sandbox egress for plain `run:` steps that reach a configured datasource.
 *
 * This is the generalization of `makeAgentEgressResolver` (src/agent/egress.ts):
 * the egress mechanism is fully generic and already job-level — `GondolinTarget`
 * merges a job's `JobNetwork.secrets` placeholders into the VM-wide env every step
 * sees and swaps the real value into outbound headers host-side for allowlisted
 * hosts only. The only thing that was agent-only was the *resolver*. This resolver
 * grants a job access to named `datasources` (allowlist their host + inject their
 * token as a header-only secret), so a fact-finding `run: curl …` can reach an
 * allowlisted internal API with credentials it never actually sees.
 *
 * **Datasource creds must route through this resolver, never through workflow
 * `env:`** — `env:` is visible in-guest, whereas the resolver's `secrets` are
 * swapped in host-side and the real value never enters the guest (§9).
 *
 * SCOPING — deny-by-default. `opts.datasources` lists which datasources THIS job
 * may use (e.g. a webhook's `datasources` list). When omitted/empty, this resolver
 * grants NOTHING and returns `undefined`. Granting-all would silently widen every
 * job's egress to the operator's whole datasource catalog; deny-by-default keeps a
 * job's reachable hosts an explicit, auditable decision.
 */
import type { PlannedJob } from "../compiler/index.ts";
import { expandEnvStrict, type DatasourceConfig, type PiWorkflowsConfig } from "../config/index.ts";

/** Structural `JobNetwork` (kept local to avoid an egress→runtime import cycle). */
export interface DatasourceJobNetwork {
  allowedHosts?: string[];
  allowedInternalHosts?: string[];
  /** Host-side dial pins (hostname → IP literal), like curl `--resolve`. */
  hostResolves?: Record<string, string>;
  secrets?: Record<string, { hosts: string[]; value: string }>;
}

// The sandbox matches allowlist entries and secret scopes against the request's
// *hostname* (port stripped, lowercased) — so a baseUrl on a nonstandard port
// must contribute `hostname`, not `host` (which keeps the port and never matches).
function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

// URL-hostname form of a pinned IP — what the sandbox sees after the rewrite
// (IPv6 literals are bracketed in URL hostnames), so allowlist/secret entries
// and the rewrite target must all use this form.
function urlHostForm(ip: string): string {
  return ip.includes(":") ? `[${ip}]` : ip;
}

/**
 * The env-var name a datasource's token is injected under. Explicit `tokenEnv`
 * wins; otherwise derive `<NAME>_TOKEN` from the datasource key (e.g. `grafana`
 * -> `GRAFANA_TOKEN`), matching the §9 example. Non-alphanumerics become `_`.
 */
function tokenEnvFor(name: string, ds: DatasourceConfig): string {
  if (ds.tokenEnv) return ds.tokenEnv;
  return `${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_TOKEN`;
}

/**
 * Build the `resolveJobNetwork` callback for datasource egress. Returns
 * `undefined` for jobs that need no datasource egress (no config, nothing scoped,
 * or no resolvable datasource hosts/tokens).
 *
 * The returned shape is structurally a `JobNetwork`: `allowedHosts` lists the
 * scoped datasources' hosts, and each datasource with a token contributes a
 * `secrets[ENV] = { hosts:[host], value: expandEnvStrict(token) }` entry scoped to
 * just that datasource's host.
 */
export function makeDatasourceEgressResolver(
  config: PiWorkflowsConfig | undefined,
  opts?: { datasources?: string[] },
): (job: PlannedJob) => DatasourceJobNetwork | undefined {
  // Capture scope once — the same resolver applies to every job it's asked about.
  const scoped = opts?.datasources ?? [];
  return (_job) => {
    if (!config?.datasources) return undefined;
    if (scoped.length === 0) return undefined; // deny-by-default

    const hosts = new Set<string>();
    const internalHosts = new Set<string>();
    const resolves: Record<string, string> = {};
    const secrets: Record<string, { hosts: string[]; value: string }> = {};

    for (const name of scoped) {
      const ds = config.datasources[name];
      if (!ds) continue; // unknown datasource for this job's scope — skip, don't throw
      const host = hostOf(ds.baseUrl);
      if (!host) continue;
      hosts.add(host);
      // A pinned datasource (curl --resolve style): the sandbox rewrites the URL
      // host to the pinned IP before policy/secrets/dial, so the *IP* is what
      // every downstream check sees. Allowlist it, and lift the private-range
      // block for it — pinning an address is an explicit operator grant (for a
      // public pinned IP the internal entry is a no-op beyond allowlisting).
      const secretHosts = [host];
      if (ds.resolve) {
        const pinned = urlHostForm(ds.resolve);
        resolves[host] = pinned;
        internalHosts.add(pinned);
        secretHosts.push(pinned);
      }
      // Only datasources with a token contribute a secret; a token-less datasource
      // still gets host allowlisted (a public read endpoint, say).
      if (ds.token !== undefined) {
        secrets[tokenEnvFor(name, ds)] = { hosts: secretHosts, value: expandEnvStrict(ds.token, `datasource "${name}" token`) };
      }
    }

    if (hosts.size === 0) return undefined;
    const net: DatasourceJobNetwork = { allowedHosts: [...hosts] };
    if (internalHosts.size > 0) net.allowedInternalHosts = [...internalHosts];
    if (Object.keys(resolves).length > 0) net.hostResolves = resolves;
    if (Object.keys(secrets).length > 0) net.secrets = secrets;
    return net;
  };
}
