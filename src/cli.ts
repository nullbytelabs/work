/**
 * pi-workflows CLI (Phase 1). Two ways to launch a workflow:
 *
 *   pi-workflows <workflow.yaml>            # ad-hoc: run a file wherever it is
 *   pi-workflows [--workspace <dir>] run <name>
 *                                           # by name: the `.workflows/*.yaml`
 *                                           #   whose `name:` is <name>
 *
 * Pipeline: resolve -> read -> parseWorkflow -> compile -> AbsurdRuntime.run.
 * Streams step output live and exits non-zero if any job fails.
 */
import { readFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWorkflow, WorkflowParseError } from "./spec/index.ts";
import { compile, WorkflowCompileError } from "./compiler/index.ts";
import { AbsurdRuntime } from "./runtime/index.ts";
import { loadConfig, type PiWorkflowsConfig } from "./config/index.ts";
import { createAgentUsesHandler } from "./agent/index.ts";
import { resolveWorkflowLayout, findWorkflowByName, type WorkflowLayout } from "./project.ts";
import { UserFacingError } from "./errors.ts";

const DEFAULT_CONFIG_PATH = "pi-workflows.config.json";

interface CliArgs {
  /** Ad-hoc: a path to a workflow file. */
  file?: string;
  /** By-name: the workflow's declared `name:` (via the `run <name>` subcommand). */
  name?: string;
  /** Project root to resolve a named workflow against (defaults to cwd). */
  workspace?: string;
  workdir?: string;
  quiet: boolean;
  inputs: Record<string, unknown>;
  config?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  let workspace: string | undefined;
  let workdir: string | undefined;
  let quiet = false;
  let inputs: Record<string, unknown> = {};
  let config: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--workspace") {
      workspace = argv[++i];
      if (!workspace) fail("--workspace requires a directory path");
    } else if (arg === "--workdir") {
      workdir = argv[++i];
      if (!workdir) fail("--workdir requires a directory path");
    } else if (arg === "--config") {
      config = argv[++i];
      if (!config) fail("--config requires a path");
    } else if (arg === "--inputs") {
      const json = argv[++i];
      if (!json) fail("--inputs requires a JSON object string");
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        fail("--inputs must be valid JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        fail("--inputs must be a JSON object, e.g. '{\"name\":\"josh\"}'");
      }
      inputs = parsed as Record<string, unknown>;
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  const common = { workdir, quiet, inputs, ...(workspace ? { workspace } : {}), ...(config ? { config } : {}) };

  // `run <name>` (by-name) vs. a bare `<workflow.yaml>` path (ad-hoc).
  if (positionals[0] === "run") {
    const name = positionals[1];
    if (!name) fail("run requires a workflow name, e.g. `pi-workflows run ci`");
    if (positionals.length > 2) fail(`unexpected argument: ${positionals[2]}`);
    return { name, ...common };
  }
  if (workspace) fail("--workspace only applies to `run <name>`; pass a file path directly instead");
  if (positionals.length === 0) {
    printUsage();
    process.exit(2);
  }
  if (positionals.length > 1) fail(`unexpected argument: ${positionals[1]}`);
  return { file: positionals[0]!, ...common };
}

function printUsage(): void {
  process.stderr.write(
    "Usage:\n" +
      "  pi-workflows <workflow.yaml> [--inputs '<json>'] [--config <file>] [--workdir <dir>] [--quiet]\n" +
      "  pi-workflows [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--workdir <dir>] [--quiet]\n",
  );
}

/** Resolve which config file to load: --config, then $PI_WORKFLOWS_CONFIG, then the default if it exists. */
function resolveConfigPath(cliPath?: string): string | undefined {
  if (cliPath) return resolve(cliPath);
  const env = process.env["PI_WORKFLOWS_CONFIG"];
  if (env) return resolve(env);
  const def = resolve(DEFAULT_CONFIG_PATH);
  return existsSync(def) ? def : undefined;
}

function fail(msg: string): never {
  process.stderr.write(`pi-workflows: ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve where the workflow lives and what its checkout is. By name:
  // `<workspace>/.workflows/*.yaml` whose `name:` matches (workspace defaults to
  // cwd). Ad-hoc: the given path — and if it sits in a `.workflows/` folder the
  // checkout is the project root (parent); otherwise its own folder.
  let layout: WorkflowLayout;
  if (args.name !== undefined) {
    layout = await findWorkflowByName(args.workspace ?? process.cwd(), args.name);
  } else {
    layout = resolveWorkflowLayout(args.file!);
  }

  let yamlText: string;
  try {
    yamlText = await readFile(layout.file, "utf-8");
  } catch {
    fail(`cannot read workflow file: ${layout.file}`);
  }

  let plan;
  try {
    const spec = parseWorkflow(yamlText);
    plan = compile(spec, { inputs: args.inputs });
  } catch (err) {
    if (err instanceof WorkflowParseError || err instanceof WorkflowCompileError) {
      fail(err.message);
    }
    throw err;
  }

  // Load provider/model config (for agent steps). Absent config is fine until an
  // agent step actually needs a model.
  let config: PiWorkflowsConfig | undefined;
  const configPath = resolveConfigPath(args.config);
  if (configPath) config = await loadConfig(configPath);

  const workRoot = args.workdir
    ? resolve(args.workdir)
    : await mkdtemp(join(tmpdir(), "pi-workflows-"));

  const out = process.stdout;
  if (!args.quiet) out.write(`workflow: ${plan.name}\n`);

  // Jobs run in parallel, so buffer each job's lines and flush the whole block
  // atomically on completion — keeps per-job output contiguous instead of
  // interleaved. Blocks print in job-completion order.
  const buffers = new Map<string, string[]>();
  const lines = (jobId: string) => {
    let b = buffers.get(jobId);
    if (!b) {
      b = [`[job: ${jobId}]`];
      buffers.set(jobId, b);
    }
    return b;
  };

  // Compose the agent uses-handler into the (agent-agnostic) runtime.
  const runtime = new AbsurdRuntime({ usesHandlers: [createAgentUsesHandler({ config })] });
  let result;
  try {
    result = await runtime.run(plan, {
      workRoot,
      workspaceSource: layout.workspaceSource,
      workflowDir: layout.workflowDir,
      hooks: args.quiet
        ? undefined
        : {
            onJobStart: (jobId) => void lines(jobId),
            onStepStart: (jobId, stepName) => lines(jobId).push(`  > ${stepName}`),
            onOutput: (jobId, _stepName, chunk) => {
              const prefix = chunk.stream === "stderr" ? "    ! " : "    ";
              for (const line of chunk.text.replace(/\n$/, "").split("\n")) {
                lines(jobId).push(`${prefix}${line}`);
              }
            },
            onStepEnd: (jobId, step) => {
              const mark = step.status === "success" ? "ok" : step.status;
              lines(jobId).push(`    (${mark}, exit ${step.exitCode})`);
            },
            onJobEnd: (jobId) => {
              const b = buffers.get(jobId);
              if (b) {
                out.write(`\n${b.join("\n")}\n`);
                buffers.delete(jobId);
              }
            },
          },
    });
  } finally {
    await runtime.close();
  }

  if (!args.quiet) out.write(`\nresult: ${result.status}\n`);
  process.exit(result.status === "success" ? 0 : 1);
}

main().catch((err) => {
  if (err instanceof UserFacingError) {
    process.stderr.write(`pi-workflows: ${err.message}\n`);
  } else {
    process.stderr.write(`pi-workflows: unexpected error: ${(err as Error).stack ?? err}\n`);
  }
  process.exit(1);
});
