/**
 * `work create datasource <name>` — scaffold a `datasources.<name>` entry,
 * merged into the project's `work.json` (see config-merge.ts).
 *
 * The command is a small *generic core* parameterized by a preset table: the
 * core is "derive an env-var name, build the entry, merge it, print next steps,"
 * and the presets supply only the STABLE facts about a product — the shape of
 * its API base URL and (where it differs from the default) the header its token
 * rides in. Deployment-specific values (the real host, the `resolve` pin IP, the
 * token itself) are deliberately NOT baked into a preset: a preset that pinned
 * real infra would go stale and give false confidence, so we emit clearly-marked
 * placeholders and steer the user to fix them in the epilogue.
 *
 * Two security invariants the generator upholds (both from §9 / the datasource
 * egress resolver, src/egress/datasource.ts):
 *   - `token` is ALWAYS a `$VAR` env-ref, never a literal secret. The resolver
 *     injects the real value host-side, scoped to the datasource's host, so the
 *     guest never sees it.
 *   - We emit `tokenEnv` EXPLICITLY (matching the resolver's `<NAME>_TOKEN`
 *     derivation) — `work.json` is comment-free JSON, so the explicit field is
 *     how the user discovers which env var to export.
 */
import { UserFacingError } from "../errors.ts";
import { failUsage, prog } from "../cli-util.ts";
import { CODE, paint, shouldColor } from "../tui/palette.ts";
import { slug } from "./slug.ts";
import { planConfigMerge, writeConfigMerge } from "./config-merge.ts";

/**
 * A datasource preset: the stable facts about a product. `baseUrl` is a
 * placeholder with the *right shape/path* for that product (obvious example
 * host, conventional API base path) — the user edits the host, not the path.
 * `tokenHeader` is set only when it differs from the resolver/sandbox default
 * (`Authorization`); these LGTM-stack and Kubernetes endpoints all authenticate
 * with a `Bearer` token in `Authorization`, which IS the default — so the field
 * is omitted and we note it. `note` is one line of product-specific guidance.
 */
export interface DatasourcePreset {
  id: string;
  title: string;
  baseUrl: string;
  /** Outbound header the token rides in. Omitted when it's the default `Authorization`. */
  tokenHeader?: string;
  note: string;
}

/**
 * The preset table — Josh's actual stack: a Tailscale-brokered EKS fleet with an
 * LGTM observability stack (Loki, Grafana, Tempo, Mimir) plus Prometheus and
 * Alertmanager. Each `baseUrl` uses an obvious `*.example.com` placeholder host
 * and the product's conventional API base path; every entry authenticates with a
 * `Bearer` token in `Authorization` (the sandbox default header), so none sets
 * `tokenHeader`. `generic` is the bare fallback.
 */
export const DATASOURCE_PRESETS: Record<string, DatasourcePreset> = {
  kubernetes: {
    id: "kubernetes",
    title: "Kubernetes API server",
    baseUrl: "https://kubernetes.example.com",
    note: "Point baseUrl at the API server (e.g. your EKS endpoint); token is a ServiceAccount bearer token.",
  },
  prometheus: {
    id: "prometheus",
    title: "Prometheus",
    baseUrl: "https://prometheus.example.com/api/v1",
    note: "Query under /api/v1 (e.g. /api/v1/query?query=up).",
  },
  grafana: {
    id: "grafana",
    title: "Grafana",
    baseUrl: "https://grafana.example.com/api",
    note: "Use a Grafana service-account token; the HTTP API lives under /api.",
  },
  loki: {
    id: "loki",
    title: "Loki (logs)",
    baseUrl: "https://loki.example.com/loki/api/v1",
    note: "LogQL queries live under /loki/api/v1 (e.g. /loki/api/v1/query_range).",
  },
  tempo: {
    id: "tempo",
    title: "Tempo (traces)",
    baseUrl: "https://tempo.example.com/api",
    note: "Trace lookups live under /api (e.g. /api/traces/<id>).",
  },
  mimir: {
    id: "mimir",
    title: "Mimir (metrics)",
    baseUrl: "https://mimir.example.com/prometheus/api/v1",
    note: "Prometheus-compatible API under /prometheus/api/v1; set the X-Scope-OrgID header per-request if multi-tenant.",
  },
  alertmanager: {
    id: "alertmanager",
    title: "Alertmanager",
    baseUrl: "https://alertmanager.example.com/api/v2",
    note: "The v2 API lives under /api/v2 (e.g. /api/v2/alerts).",
  },
  generic: {
    id: "generic",
    title: "Generic HTTP datasource",
    baseUrl: "https://datasource.example.com",
    note: "A bare HTTP datasource — edit baseUrl to the real host and base path.",
  },
};

/**
 * The env-var name the datasource's token is injected under — kept in lockstep
 * with the resolver's `tokenEnvFor` (src/egress/datasource.ts): `<NAME>_TOKEN`
 * with non-alphanumerics collapsed to `_`, uppercased (e.g. `grafana` ->
 * `GRAFANA_TOKEN`, `my-grafana` -> `MY_GRAFANA_TOKEN`). We emit this EXPLICITLY
 * into the entry so the user can see which variable to export.
 */
export function tokenEnvFor(name: string): string {
  return `${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_TOKEN`;
}

/**
 * Resolve which preset to use: an explicit `--preset` wins; otherwise, if the
 * slugged name happens to match a preset id, infer it (so `create datasource
 * grafana` just works); otherwise fall back to `generic`. An explicit `--preset`
 * that names no known preset is a user error rather than a silent generic.
 */
export function resolvePreset(name: string, explicit: string | undefined): DatasourcePreset {
  if (explicit !== undefined) {
    const p = DATASOURCE_PRESETS[explicit];
    if (!p) {
      throw new UserFacingError(
        `unknown datasource preset "${explicit}" — choose one of: ${Object.keys(DATASOURCE_PRESETS).join(", ")}`,
      );
    }
    return p;
  }
  return DATASOURCE_PRESETS[name] ?? DATASOURCE_PRESETS["generic"]!;
}

/**
 * Build the `datasources.<name>` entry from a preset (or a `--url` override). The
 * token is always a `$VAR` ref to the derived env var — never a literal secret —
 * and `tokenEnv` is emitted explicitly. `tokenHeader` is included only when the
 * preset sets a non-default one.
 */
export function buildDatasourceEntry(
  name: string,
  preset: DatasourcePreset,
  urlOverride: string | undefined,
): Record<string, unknown> {
  const env = tokenEnvFor(name);
  const entry: Record<string, unknown> = {
    baseUrl: urlOverride ?? preset.baseUrl,
    token: `$${env}`,
    tokenEnv: env,
  };
  if (preset.tokenHeader !== undefined) entry.tokenHeader = preset.tokenHeader;
  return entry;
}

interface DatasourceOptions {
  rawName: string;
  preset: string | undefined;
  url: string | undefined;
  force: boolean;
  dryRun: boolean;
}

function usage(): string {
  const p = prog();
  const presets = Object.keys(DATASOURCE_PRESETS).join(" | ");
  return (
    `Usage:\n` +
    `  ${p} create datasource <name> [--preset <id>] [--url <baseUrl>] [--force] [--dry-run]\n\n` +
    `Presets: ${presets}\n` +
    `If <name> matches a preset id it is inferred; otherwise "generic" is used.\n`
  );
}

function parseArgs(argv: string[]): DatasourceOptions {
  let rawName: string | undefined;
  let preset: string | undefined;
  let url: string | undefined;
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--preset" || arg === "-p") {
      const v = argv[++i];
      if (!v) failUsage(`${arg} requires a preset id (${Object.keys(DATASOURCE_PRESETS).join(" | ")})`);
      preset = v;
    } else if (arg === "--url" || arg === "-u") {
      const v = argv[++i];
      if (!v) failUsage(`${arg} requires a base URL`);
      url = v;
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      failUsage(`unknown flag for create datasource: ${arg}`);
    } else if (rawName === undefined) {
      rawName = arg;
    } else {
      failUsage(`unexpected argument: ${arg}`);
    }
  }

  if (rawName === undefined) failUsage("create datasource requires a name, e.g. `create datasource grafana`");
  return { rawName, preset, url, force, dryRun };
}

/** Run `create datasource`. Resolves with the process exit code. */
export async function runCreateDatasource(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const opts = parseArgs(argv);
  const name = slug(opts.rawName);
  const preset = resolvePreset(name, opts.preset);
  const entry = buildDatasourceEntry(name, preset, opts.url);

  const plan = await planConfigMerge(cwd, "datasources", name, entry, opts.force);
  const color = shouldColor(Boolean(process.stdout.isTTY));
  await writeConfigMerge(plan, { dryRun: opts.dryRun, color });
  if (opts.dryRun) return 0;

  printNextSteps(name, preset, color);
  return 0;
}

/**
 * "Next steps" epilogue — styled like the workflow-create epilogue. Walks the
 * user through making the placeholder entry real and reachable, in the order they
 * need it, and reinforces the security model (token via the injected header, not
 * workflow `env:`).
 */
function printNextSteps(name: string, preset: DatasourcePreset, color: boolean): void {
  const env = tokenEnvFor(name);
  process.stdout.write(`\n${paint(color, CODE.bold, "Next steps:")}\n`);
  process.stdout.write(`  ${paint(color, CODE.dim, preset.note)}\n`);
  process.stdout.write(`  1. export the token:   export ${env}=...  (the real secret — kept out of work.json)\n`);
  process.stdout.write(`  2. set the real host:  edit datasources.${name}.baseUrl in work.json\n`);
  process.stdout.write(
    `  3. for a private host:  add "resolve": "<ip>" to the entry if public DNS can't name it\n` +
      `     ${paint(color, CODE.dim, "(an SSH tunnel, a loopback/kind service, a Tailscale peer — pinning also lifts the sandbox private-range block for that IP)")}\n`,
  );
  process.stdout.write(
    `  4. use it from a run: step — the token rides the injected header via mediated egress;\n` +
      `     ${paint(color, CODE.dim, `reference $${env} in the request, never put the secret in workflow env:`)}\n`,
  );
}
