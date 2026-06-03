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
 *     workflow file needs `--force` to overwrite, and `pi-workflows.config.json`
 *     is never overwritten (it may hold real creds).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseWorkflow, WorkflowParseError } from "../spec/index.ts";
import { compile, WorkflowCompileError } from "../compiler/index.ts";
import { listWorkflowNames } from "../project.ts";
import { UserFacingError } from "../errors.ts";
import { failUsage, prog } from "../cli-util.ts";
import { CODE, paint, shouldColor } from "../tui/palette.ts";
import { slug } from "./slug.ts";
import {
  CONFIG_FILENAME,
  TEMPLATES,
  type TemplateName,
  isTemplateName,
  scaffoldFiles,
  workflowPath,
} from "./templates.ts";

interface CreateOptions {
  rawName: string;
  template: TemplateName;
  force: boolean;
  dryRun: boolean;
}

function parseCreateArgs(argv: string[]): CreateOptions {
  let rawName: string | undefined;
  let template: TemplateName = "hello-world";
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--template" || arg === "-t") {
      const v = argv[++i];
      if (!v) failUsage(`${arg} requires a template name (${TEMPLATES.join(" | ")})`);
      if (!isTemplateName(v)) failUsage(`unknown template "${v}" — choose one of: ${TEMPLATES.join(", ")}`);
      template = v;
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        `Usage:\n  ${prog()} create <name> [--template ${TEMPLATES.join("|")}] [--force] [--dry-run]\n`,
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      failUsage(`unknown flag for create: ${arg}`);
    } else if (rawName === undefined) {
      rawName = arg;
    } else {
      failUsage(`unexpected argument: ${arg}`);
    }
  }

  if (rawName === undefined) failUsage("create requires a name, e.g. `create deploy`");
  return { rawName, template, force, dryRun };
}

/** Validate generated workflow YAML through the real pipeline before writing. */
function assertValidWorkflow(name: string, yamlText: string): void {
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

interface FileAction {
  rel: string;
  abs: string;
  action: "create" | "overwrite" | "skip";
  reason?: string;
}

/** Decide what happens to each file (no FS writes) — the skip/force/clobber policy. */
function planWrites(files: Map<string, string>, cwd: string, force: boolean): FileAction[] {
  const actions: FileAction[] = [];
  for (const rel of files.keys()) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) {
      actions.push({ rel, abs, action: "create" });
    } else if (rel === CONFIG_FILENAME) {
      // Never overwrite config — it may hold real credentials.
      actions.push({ rel, abs, action: "skip", reason: "exists (config preserved)" });
    } else if (force) {
      actions.push({ rel, abs, action: "overwrite" });
    } else {
      actions.push({ rel, abs, action: "skip", reason: "exists (use --force to overwrite)" });
    }
  }
  return actions;
}

/** Run the create command. Resolves with the process exit code. */
export async function runCreate(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const opts = parseCreateArgs(argv);
  const name = slug(opts.rawName);

  const files = scaffoldFiles({ name, template: opts.template });
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

  const actions = planWrites(files, cwd, opts.force);
  const color = shouldColor(Boolean(process.stdout.isTTY));

  if (opts.dryRun) {
    process.stdout.write(`${paint(color, CODE.bold, `dry run`)} — would write (nothing changed):\n`);
    for (const a of actions) {
      const tag = a.action === "skip" ? paint(color, CODE.yellow, `skip ${a.reason}`) : paint(color, CODE.green, a.action);
      process.stdout.write(`  ${tag}  ${a.rel}\n`);
    }
    return 0;
  }

  for (const a of actions) {
    if (a.action === "skip") continue;
    await mkdir(dirname(a.abs), { recursive: true });
    await writeFile(a.abs, files.get(a.rel)!);
  }

  // Report + next steps.
  for (const a of actions) {
    if (a.action === "skip") {
      process.stdout.write(`  ${paint(color, CODE.yellow, "⊘")} ${a.rel}  ${paint(color, CODE.dim, a.reason ?? "skipped")}\n`);
    } else {
      const verb = a.action === "overwrite" ? "overwrote" : "created";
      process.stdout.write(`  ${paint(color, CODE.green, "✓")} ${verb} ${a.rel}\n`);
    }
  }

  const p = prog();
  process.stdout.write(`\n${paint(color, CODE.bold, "Next steps:")}\n`);
  process.stdout.write(`  run it:   ${p} run ${name}\n`);
  process.stdout.write(`  inspect:  ${p} graph ${name}\n`);
  if (opts.template === "agent-action") {
    process.stdout.write(`  add a key: set $FIREWORKS_API_KEY and edit ${CONFIG_FILENAME}\n`);
  }
  return 0;
}
