/**
 * `work init` — initialize a project for the `work` CLI.
 *
 * Writes a starter workflow into `.workflows/` plus a project `pi-workflows.config.json`,
 * and (with `--include-skill`) a developer Claude Code / Amp skill that teaches
 * the user's *own* coding agent to drive the CLI — unrelated to the engine's
 * in-gondolin agent steps (docs/init-doctor-scaffolding-research.md §2–§3).
 *
 * Idempotent: existing files are skipped-and-reported, never clobbered; re-running
 * is "nothing to do" and still exits 0. Composes the `create` generators + writer.
 *
 *   work init [--project | --global] [--include-skill] [--from-template hello-world|agent-action] [--force] [--dry-run]
 *
 * `--global` writes a machine-wide config (XDG: ~/.config/work/config.json) — the
 * home for providers/models, merged under every project config at run time.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseWorkflow } from "../spec/index.ts";
import { globalConfigWritePath } from "../config/index.ts";
import { failUsage, prog } from "../cli-util.ts";
import { shouldColor, CODE, paint } from "../tui/palette.ts";
import { slug } from "../scaffold/slug.ts";
import { assertValidWorkflow } from "../scaffold/index.ts";
import { planWrites, executeWrites } from "../scaffold/write.ts";
import {
  CONFIG_FILENAME,
  TEMPLATES,
  type TemplateName,
  isTemplateName,
  scaffoldFiles,
  starterConfigFile,
  skillFiles,
  workflowPath,
} from "../scaffold/templates.ts";

interface InitOptions {
  global: boolean;
  template: TemplateName;
  includeSkill: boolean;
  force: boolean;
  dryRun: boolean;
}

function parseInitArgs(argv: string[]): InitOptions {
  let global = false;
  let template: TemplateName = "hello-world";
  let includeSkill = false;
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project") {
      // The default mode — accept it explicitly.
    } else if (arg === "--global") {
      global = true;
    } else if (arg === "--include-skill") {
      includeSkill = true;
    } else if (arg === "--from-template" || arg === "-t") {
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
        `Usage:\n  ${prog()} init [--project | --global] [--include-skill] [--from-template ${TEMPLATES.join("|")}] [--force] [--dry-run]\n`,
      );
      process.exit(0);
    } else {
      failUsage(`unknown flag for init: ${arg}`);
    }
  }
  return { global, template, includeSkill, force, dryRun };
}

/** Assemble the file set a project init writes. */
function initFiles(opts: InitOptions): Map<string, string> {
  const name = slug(opts.template); // "hello-world" or "agent-action"
  const files = scaffoldFiles({ name, template: opts.template });
  // Always include the project config (agent-action already emits one; this is a
  // no-op overwrite of the identical generator output for that template).
  if (!files.has(CONFIG_FILENAME)) {
    const cfg = starterConfigFile();
    files.set(cfg.path, cfg.contents);
  }
  if (opts.includeSkill) {
    for (const [path, contents] of skillFiles()) files.set(path, contents);
  }
  return files;
}

/** `init --global`: write the machine-wide starter config (XDG), idempotently. */
async function runInitGlobal(opts: InitOptions, color: boolean): Promise<number> {
  const path = globalConfigWritePath();
  const { contents } = starterConfigFile();
  const exists = existsSync(path);

  if (opts.dryRun) {
    const tag = exists ? paint(color, CODE.yellow, "skip exists (config preserved)") : paint(color, CODE.green, "create");
    process.stdout.write(`${paint(color, CODE.bold, "dry run")} — would write (nothing changed):\n  ${tag}  ${path}\n`);
    return 0;
  }
  if (exists) {
    process.stdout.write(`  ${paint(color, CODE.yellow, "⊘")} ${path}  ${paint(color, CODE.dim, "exists (config preserved)")}\n`);
    process.stdout.write(`\n${paint(color, CODE.dim, "global config already exists — nothing to do")}\n`);
    return 0;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  process.stdout.write(`  ${paint(color, CODE.green, "✓")} created ${path}\n`);
  process.stdout.write(`\n${paint(color, CODE.bold, "Next steps:")}\n`);
  process.stdout.write(`  add a key: set $FIREWORKS_API_KEY — the global config holds your providers/models\n`);
  process.stdout.write(`  per project: ${prog()} init   (a project config overrides the global one)\n`);
  return 0;
}

/** Run the init command. Resolves with the process exit code. */
export async function runInit(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const opts = parseInitArgs(argv);
  const color = shouldColor(Boolean(process.stdout.isTTY));
  if (opts.global) return runInitGlobal(opts, color);

  const name = slug(opts.template);
  const files = initFiles(opts);

  // Guardrail: the generated workflow must compile before we touch disk.
  assertValidWorkflow(name, files.get(workflowPath(name))!);
  // Cheap sanity that the YAML at least parses (compile already covers this).
  parseWorkflow(files.get(workflowPath(name))!);

  const actions = planWrites(files, cwd, opts.force);
  await executeWrites(files, actions, { dryRun: opts.dryRun, color });
  if (opts.dryRun) return 0;

  const wrote = actions.some((a) => a.action !== "skip");
  const p = prog();
  if (!wrote) {
    process.stdout.write(`\n${paint(color, CODE.dim, "already initialized — nothing to do")}\n`);
    return 0;
  }

  process.stdout.write(`\n${paint(color, CODE.bold, "Next steps:")}\n`);
  process.stdout.write(`  run it:   ${p} run ${name}\n`);
  process.stdout.write(`  inspect:  ${p} graph ${name}\n`);
  process.stdout.write(`  add a key: set $FIREWORKS_API_KEY and edit ${CONFIG_FILENAME}\n`);
  if (opts.includeSkill) {
    process.stdout.write(`  your coding agent can now drive \`work\` (see .claude/skills/work-workflows/)\n`);
  }
  return 0;
}
