/**
 * pi-workflows CLI (Phase 1).
 *
 *   pi-workflows <workflow.yaml> [--workdir <dir>] [--quiet]
 *
 * Pipeline: read file -> parseWorkflow -> compile -> AbsurdRuntime.run.
 * Streams step output live and exits non-zero if any job fails.
 */
import { readFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseWorkflow, WorkflowParseError } from "./spec/index.ts";
import { compile, WorkflowCompileError } from "./compiler/index.ts";
import { AbsurdRuntime } from "./runtime/index.ts";
import { loadConfig, type PiWorkflowsConfig } from "./config/index.ts";
import { UserFacingError } from "./errors.ts";

const DEFAULT_CONFIG_PATH = "pi-workflows.config.json";

interface CliArgs {
  file: string;
  workdir?: string;
  quiet: boolean;
  inputs: Record<string, unknown>;
  config?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let file: string | undefined;
  let workdir: string | undefined;
  let quiet = false;
  let inputs: Record<string, unknown> = {};
  let config: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--workdir") {
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
    } else if (!file) {
      file = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }

  if (!file) {
    printUsage();
    process.exit(2);
  }
  return { file, workdir, quiet, inputs, ...(config ? { config } : {}) };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: pi-workflows <workflow.yaml> [--inputs '<json>'] [--config <file>] [--workdir <dir>] [--quiet]\n",
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

  let yamlText: string;
  try {
    yamlText = await readFile(resolve(args.file), "utf-8");
  } catch {
    fail(`cannot read workflow file: ${args.file}`);
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

  // The workflow's own directory is staged into each job's workspace, so
  // committed companion files (scripts, fixtures) sit next to the workflow.
  const workspaceSource = dirname(resolve(args.file));

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

  const runtime = new AbsurdRuntime(config ? { config } : {});
  let result;
  try {
    result = await runtime.run(plan, {
      workRoot,
      workspaceSource,
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
