/**
 * Webhook wiring — the two-sided handshake that lets a remote sender trigger a
 * workflow, scaffolded as one matched pair instead of two hand-edited files.
 *
 * A live webhook needs three name-matched references plus an auth mode, and the
 * engine only validates *some* of them at config-load — a mismatch otherwise
 * surfaces as a silently-dead hook (the receiver returns a deliberately generic
 * 404 that never says which side is wrong). This module emits both halves with
 * the names already in agreement:
 *
 *   - the config half — `webhooks.<hook>` merged into `work.json` (via
 *     config-merge.ts): `{ workflow, auth, secret: "$<HOOK>_SECRET", … }`. The
 *     secret is ALWAYS a `$VAR` ref, never a literal.
 *   - the workflow half — an `on: webhook: { secret: <hook>, source }` block,
 *     baked into a freshly-generated workflow (greenfield, see index.ts) or
 *     printed as a paste-in snippet for an existing one (retrofit, below).
 *
 * `--source` selects an auth preset matched to the sender (its auth mode and the
 * header its credential rides in), since that's the part operators get wrong.
 */
import { readFile } from "node:fs/promises";
import { parseWorkflow } from "../spec/index.ts";
import { listWorkflowNames } from "../project.ts";
import { UserFacingError } from "../errors.ts";
import { failUsage, prog } from "../cli-util.ts";
import { CODE, paint, shouldColor } from "../tui/palette.ts";
import { slug } from "./slug.ts";
import { planConfigMerge, writeConfigMerge } from "./config-merge.ts";

/**
 * A sender preset: the stable auth facts about a webhook source. `auth` is the
 * delivery scheme the receiver enforces; `signatureHeader` is set only when it
 * differs from the receiver default (HMAC's `X-Hub-Signature-256`, or bearer's
 * `Authorization`). `note` is one line of sender-specific guidance.
 */
export interface SourcePreset {
  id: string;
  title: string;
  auth: "bearer" | "hmac-sha256";
  /** Header the credential rides in, when non-default. */
  signatureHeader?: string;
  note: string;
}

/**
 * The source presets. Auth modes match the receiver (src/web/server.ts):
 * bearer reads `Authorization: Bearer` (or a raw token in `signatureHeader`);
 * HMAC reads the hex from `signatureHeader`, defaulting to GitHub's
 * `X-Hub-Signature-256`. `generic` is the bare bearer fallback.
 */
export const SOURCE_PRESETS: Record<string, SourcePreset> = {
  alertmanager: {
    id: "alertmanager",
    title: "Prometheus Alertmanager",
    auth: "bearer",
    note: "Alertmanager doesn't sign payloads — set its webhook_config http_config.authorization to send the bearer token.",
  },
  grafana: {
    id: "grafana",
    title: "Grafana (managed alerting)",
    auth: "hmac-sha256",
    signatureHeader: "X-Grafana-Alerting-Signature",
    note: "Grafana sends a bare-hex HMAC in X-Grafana-Alerting-Signature over the raw body.",
  },
  github: {
    id: "github",
    title: "GitHub",
    auth: "hmac-sha256",
    // X-Hub-Signature-256 is the receiver default, so it's left implicit.
    note: "GitHub signs the body as sha256=<hex> in X-Hub-Signature-256.",
  },
  generic: {
    id: "generic",
    title: "Generic bearer-token sender",
    auth: "bearer",
    note: "Any sender that presents a static bearer token in Authorization.",
  },
};

/**
 * The env var the hook's secret is read from. There is no resolver-side default
 * for a webhook secret (unlike datasource tokens), so we pick the convention
 * `<HOOK>_SECRET` and emit it as the `$VAR` ref — the user exports that var.
 */
export function webhookSecretEnv(hook: string): string {
  return `${hook.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_SECRET`;
}

/**
 * Resolve a `--source` to a preset: an explicit unknown source is an error;
 * an absent source is the `generic` bearer preset.
 */
export function resolveSource(explicit: string | undefined): SourcePreset {
  if (explicit === undefined) return SOURCE_PRESETS["generic"]!;
  const p = SOURCE_PRESETS[explicit];
  if (!p) {
    throw new UserFacingError(
      `unknown webhook source "${explicit}" — choose one of: ${Object.keys(SOURCE_PRESETS).join(", ")}`,
    );
  }
  return p;
}

/**
 * Build the `webhooks.<hook>` config entry. `secret` is always a `$VAR` ref;
 * `auth`/`signatureHeader` come from the source preset; `datasources` scopes the
 * triggered run's egress when supplied.
 */
export function buildWebhookEntry(opts: {
  hook: string;
  workflow: string;
  source: SourcePreset;
  datasources?: string[];
}): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    workflow: opts.workflow,
    auth: opts.source.auth,
    secret: `$${webhookSecretEnv(opts.hook)}`,
  };
  if (opts.source.signatureHeader !== undefined) entry.signatureHeader = opts.source.signatureHeader;
  if (opts.datasources && opts.datasources.length > 0) entry.datasources = opts.datasources;
  return entry;
}

/**
 * The workflow-side `on: webhook` block (top-level YAML, two-space indent). Baked
 * into a generated workflow or printed as a paste-in snippet. `source` is omitted
 * for the `generic` preset (it's a free-form sender hint with no generic value).
 */
export function webhookTriggerBlock(hook: string, source: SourcePreset): string {
  const lines = ["on:", "  webhook:", `    secret: ${hook}`];
  if (source.id !== "generic") lines.push(`    source: ${source.id}`);
  return lines.join("\n");
}

/**
 * Merge the `webhooks.<hook>` config half into work.json and report. Also soft-warns
 * (never fails) when the entry scopes datasources the merged config doesn't define
 * yet — the engine is lenient about cross-layer refs, so we nudge rather than block.
 */
export async function wireWebhookConfig(
  cwd: string,
  hook: string,
  entry: Record<string, unknown>,
  opts: { force: boolean; dryRun: boolean; color: boolean },
): Promise<void> {
  const plan = await planConfigMerge(cwd, "webhooks", hook, entry, opts.force);
  await writeConfigMerge(plan, { dryRun: opts.dryRun, color: opts.color });

  const scoped = (entry.datasources as string[] | undefined) ?? [];
  if (scoped.length > 0) {
    const merged = JSON.parse(plan.text) as { datasources?: Record<string, unknown> };
    const known = new Set(Object.keys(merged.datasources ?? {}));
    const missing = scoped.filter((d) => !known.has(d));
    for (const d of missing) {
      process.stdout.write(
        `  ${paint(opts.color, CODE.yellow, "!")} datasource "${d}" isn't defined yet — add it with ${prog()} create datasource ${d}\n`,
      );
    }
  }
}

interface WebhookOptions {
  rawHook: string;
  workflow: string | undefined;
  source: string | undefined;
  datasources: string[];
  force: boolean;
  dryRun: boolean;
}

function usage(): string {
  const p = prog();
  return (
    `Usage:\n` +
    `  ${p} create webhook <name> --workflow <existing> [--source ${Object.keys(SOURCE_PRESETS).join("|")}] [--datasources a,b] [--force] [--dry-run]\n\n` +
    `Wires the config half (webhooks.<name>) for an EXISTING workflow and prints the\n` +
    `\`on: webhook\` block to add. To scaffold a new webhook-triggered workflow in one\n` +
    `step instead, use \`${p} create workflow <name> --webhook\`.\n`
  );
}

function parseArgs(argv: string[]): WebhookOptions {
  let rawHook: string | undefined;
  let workflow: string | undefined;
  let source: string | undefined;
  let datasources: string[] = [];
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--workflow" || arg === "-w") {
      const v = argv[++i];
      if (!v) failUsage("--workflow requires a workflow name");
      workflow = v;
    } else if (arg === "--source" || arg === "-s") {
      const v = argv[++i];
      if (!v) failUsage(`--source requires a source id (${Object.keys(SOURCE_PRESETS).join(" | ")})`);
      source = v;
    } else if (arg === "--datasources") {
      const v = argv[++i];
      if (!v) failUsage("--datasources requires a comma-separated list");
      datasources = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      failUsage(`unknown flag for create webhook: ${arg}`);
    } else if (rawHook === undefined) {
      rawHook = arg;
    } else {
      failUsage(`unexpected argument: ${arg}`);
    }
  }

  if (rawHook === undefined) failUsage("create webhook requires a name, e.g. `create webhook alerts --workflow triage`");
  if (workflow === undefined) failUsage("create webhook requires --workflow <existing workflow name>");
  return { rawHook, workflow, source, datasources, force, dryRun };
}

/**
 * Retrofit: wire a webhook onto an EXISTING workflow. Merges the config half and
 * prints the `on: webhook` snippet to add — it never edits the workflow YAML
 * (greenfield `create workflow --webhook` bakes the block in for new workflows).
 */
export async function runCreateWebhook(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const opts = parseArgs(argv);
  const hook = slug(opts.rawHook);
  const workflow = slug(opts.workflow!);
  const source = resolveSource(opts.source);

  // The target workflow must exist — catch the cross-ref the engine only checks
  // at receiver runtime (where a miss is an opaque 404).
  const names = await listWorkflowNames(cwd);
  const file = names.get(workflow);
  if (!file) {
    throw new UserFacingError(
      `no workflow named "${workflow}" in this project — create it first ` +
        `(e.g. \`${prog()} create workflow ${workflow} --webhook\`), or fix --workflow`,
    );
  }

  const color = shouldColor(Boolean(process.stdout.isTTY));
  const entry = buildWebhookEntry({ hook, workflow, source, datasources: opts.datasources });
  await wireWebhookConfig(cwd, hook, entry, { force: opts.force, dryRun: opts.dryRun, color });
  if (opts.dryRun) return 0;

  // Does the workflow already opt in? If not, print the block to paste.
  let optedIn = false;
  try {
    optedIn = Boolean(parseWorkflow(await readFile(file, "utf-8")).on?.webhook);
  } catch {
    // A workflow that doesn't parse is the user's to fix; don't mask it here.
  }

  const p = prog();
  process.stdout.write(`\n${paint(color, CODE.bold, "Next steps:")}\n`);
  if (!optedIn) {
    process.stdout.write(`  add this under \`name: ${workflow}\` in the workflow file:\n\n`);
    for (const line of webhookTriggerBlock(hook, source).split("\n")) {
      process.stdout.write(`      ${line}\n`);
    }
    process.stdout.write(`\n`);
  } else {
    process.stdout.write(`  ${paint(color, CODE.green, "✓")} ${workflow} already declares \`on: webhook\`\n`);
  }
  process.stdout.write(`  ${source.note}\n`);
  process.stdout.write(`  set the secret: export ${webhookSecretEnv(hook)}=...  (kept out of work.json)\n`);
  process.stdout.write(`  point the sender at: POST /hooks/${hook}  (served by ${p} serve)\n`);
  process.stdout.write(`  smoke-test it:       POST /api/webhooks/${hook}/test\n`);
  return 0;
}
