/**
 * `work create <name>` — scaffold a workflow (and, for the agent template, its
 * agent package + a starter config) into the project's `.workflows/`.
 *
 * Safety contract (docs/init-doctor-scaffolding-research.md §3):
 *   - Generated YAML is run back through the real `parseWorkflow`/`compile`
 *     before anything is written — a template that drifts from the spec refuses
 *     to emit rather than writing a broken file.
 *   - Two independent collision guards: the workflow *filename* and the
 *     declared `name:` (a duplicate name makes `run <name>` ambiguous).
 *   - Never clobber by default: existing files are skipped-and-reported; the
 *     workflow file needs `--force` to overwrite, and `work.json`
 *     is never overwritten (it may hold real creds).
 */
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseWorkflow, WorkflowParseError } from "../spec/index.ts";
import { compile, WorkflowCompileError } from "../compiler/index.ts";
import { listWorkflowNames } from "../project.ts";
import { UserFacingError } from "../errors.ts";
import { failUsage, prog } from "../cli-util.ts";
import { CODE, paint, shouldColor } from "../tui/palette.ts";
import { slug } from "./slug.ts";
import { planWrites, executeWrites } from "./write.ts";
import { runCreateDatasource } from "./datasource.ts";
import { runCreateImage } from "./image.ts";
import {
  runCreateWebhook,
  resolveSource,
  buildWebhookEntry,
  webhookTriggerBlock,
  wireWebhookConfig,
  webhookSecretEnv,
  SOURCE_PRESETS,
} from "./webhook.ts";
import {
  CONFIG_FILENAME,
  TEMPLATES,
  type TemplateName,
  isTemplateName,
  scaffoldFiles,
  workflowPath,
  injectAfterName,
} from "./templates.ts";

interface CreateOptions {
  rawName: string;
  template: TemplateName;
  /** Opt the generated workflow into webhook triggering (also implied by --source/--datasources). */
  webhook: boolean;
  source: string | undefined;
  datasources: string[];
  force: boolean;
  dryRun: boolean;
}

function parseCreateArgs(argv: string[]): CreateOptions {
  let rawName: string | undefined;
  let template: TemplateName = "hello-world";
  let webhook = false;
  let source: string | undefined;
  let datasources: string[] = [];
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--template" || arg === "-t") {
      const v = argv[++i];
      if (!v) failUsage(`${arg} requires a template name (${TEMPLATES.join(" | ")})`);
      if (!isTemplateName(v)) failUsage(`unknown template "${v}" — choose one of: ${TEMPLATES.join(", ")}`);
      template = v;
    } else if (arg === "--webhook") {
      webhook = true;
    } else if (arg === "--source" || arg === "-s") {
      const v = argv[++i];
      if (!v) failUsage(`--source requires a source id (${Object.keys(SOURCE_PRESETS).join(" | ")})`);
      source = v;
      webhook = true; // naming a source opts the workflow into webhook triggering
    } else if (arg === "--datasources") {
      const v = argv[++i];
      if (!v) failUsage("--datasources requires a comma-separated list");
      datasources = v.split(",").map((s) => s.trim()).filter(Boolean);
      webhook = true; // scoping datasources only makes sense for a webhook trigger
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      const p = prog();
      process.stdout.write(
        `Usage:\n` +
          `  ${p} create workflow <name> [--template ${TEMPLATES.join("|")}] ` +
          `[--webhook [--source ${Object.keys(SOURCE_PRESETS).join("|")}]] [--datasources a,b] [--force] [--dry-run]\n`,
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      failUsage(`unknown flag for create workflow: ${arg}`);
    } else if (rawName === undefined) {
      rawName = arg;
    } else {
      failUsage(`unexpected argument: ${arg}`);
    }
  }

  if (rawName === undefined) failUsage("create workflow requires a name, e.g. `create workflow deploy`");
  return { rawName, template, webhook, source, datasources, force, dryRun };
}

/** Validate generated workflow YAML through the real pipeline before writing. */
export function assertValidWorkflow(name: string, yamlText: string): void {
  try {
    const plan = compile(parseWorkflow(yamlText));
    // A clean scaffold sets runs-on explicitly, so there should be no warnings;
    // surface any as a loud internal signal rather than silently shipping them.
    for (const w of plan.warnings ?? []) {
      process.stderr.write(`${prog()}: warning: generated ${name}: ${w}\n`);
    }
  } catch (err) {
    if (err instanceof WorkflowParseError || err instanceof WorkflowCompileError) {
      // Not the user's fault — the embedded template drifted from the spec.
      throw new Error(`internal: generated workflow for "${name}" failed validation: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Every `create` is `create <noun> <name>` — `workflow`, `datasource`, `image`,
 * `webhook`. The grammar is uniform (no magical bare form), which also removes the
 * old noun/name ambiguity: a workflow can again be named `image` or `datasource`.
 */
const NOUN_HANDLERS: Record<string, (argv: string[], cwd: string) => Promise<number>> = {
  workflow: runCreateWorkflow,
  datasource: runCreateDatasource,
  image: runCreateImage,
  webhook: runCreateWebhook,
};

function familyUsage(): string {
  const p = prog();
  return (
    `Usage: ${p} create <resource> <name> [options]\n\n` +
    `Resources:\n` +
    `  ${p} create workflow <name> [--template ${TEMPLATES.join("|")}] [--webhook [--source <id>]] [--datasources a,b]\n` +
    `  ${p} create datasource <name> [--preset <id>] [--url <baseUrl>]\n` +
    `  ${p} create image <name>\n` +
    `  ${p} create webhook <name> --workflow <existing> [--source <id>] [--datasources a,b]\n\n` +
    `Common flags: --force, --dry-run.\n`
  );
}

/** Dispatch `create <noun> <name>` to a resource generator. */
export async function runCreate(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const noun = argv[0];
  if (noun === undefined || noun === "-h" || noun === "--help") {
    process.stdout.write(familyUsage());
    return 0;
  }
  const handler = NOUN_HANDLERS[noun];
  if (handler) return handler(argv.slice(1), cwd);
  if (noun.startsWith("-")) {
    failUsage(`create needs a resource first (one of: ${Object.keys(NOUN_HANDLERS).join(", ")})`);
  }
  throw new UserFacingError(
    `unknown resource "${noun}" — expected one of: ${Object.keys(NOUN_HANDLERS).join(", ")} ` +
      `(did you mean \`${prog()} create workflow ${noun}\`?)`,
  );
}

/** Scaffold a workflow — `create workflow <name>`. */
async function runCreateWorkflow(argv: string[], cwd: string): Promise<number> {
  const opts = parseCreateArgs(argv);
  const name = slug(opts.rawName);
  // Resolve the source preset early (it throws on an unknown id) so a bad
  // `--source` fails before anything is generated or written.
  const source = opts.webhook ? resolveSource(opts.source) : undefined;

  const files = scaffoldFiles({ name, template: opts.template });
  if (source) {
    // Greenfield: bake `on: webhook` into our own freshly-rendered workflow —
    // no parsing/mutation of user YAML, and the result is validated below.
    const wf = workflowPath(name);
    files.set(wf, injectAfterName(files.get(wf)!, webhookTriggerBlock(name, source)));
  }
  assertValidWorkflow(name, files.get(workflowPath(name))!);

  // Collision guard 1: declared name uniqueness (a dup makes `run <name>` ambiguous).
  const existingNames = await listWorkflowNames(cwd);
  const clashFile = existingNames.get(name);
  const targetAbs = join(cwd, workflowPath(name));
  if (clashFile && resolve(clashFile) !== targetAbs) {
    throw new UserFacingError(
      `a workflow named "${name}" already exists in ${relative(cwd, clashFile) || clashFile} — choose another name`,
    );
  }

  // Collision guard 2: the workflow filename. Refuse rather than clobber real work.
  if (existsSync(targetAbs) && !opts.force) {
    throw new UserFacingError(
      `${workflowPath(name)} already exists — choose another name or pass --force to overwrite`,
    );
  }

  const color = shouldColor(Boolean(process.stdout.isTTY));
  const actions = planWrites(files, cwd, opts.force);
  await executeWrites(files, actions, { dryRun: opts.dryRun, color });

  // Greenfield webhook: wire the matching config half (webhooks.<name>) AFTER the
  // template files land, so the merge reads any work.json the template just wrote.
  if (source) {
    const entry = buildWebhookEntry({ hook: name, workflow: name, source, datasources: opts.datasources });
    await wireWebhookConfig(cwd, name, entry, { force: opts.force, dryRun: opts.dryRun, color });
  }

  if (opts.dryRun) return 0;

  const p = prog();
  process.stdout.write(`\n${paint(color, CODE.bold, "Next steps:")}\n`);
  process.stdout.write(`  run it:   ${p} run ${name}\n`);
  process.stdout.write(`  inspect:  ${p} graph ${name}\n`);
  if (opts.template === "agent-action") {
    process.stdout.write(`  add a key: set $FIREWORKS_API_KEY and edit ${CONFIG_FILENAME}\n`);
  }
  if (source) {
    process.stdout.write(
      `  webhook:  export ${webhookSecretEnv(name)} and POST to /hooks/${name} (served by ${p} --web)\n`,
    );
  }
  return 0;
}
