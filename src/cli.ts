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
import { createAgentUsesHandler, makeAgentEgressResolver } from "./agent/index.ts";
import { resolveWorkflowLayout, findWorkflowByName, type WorkflowLayout } from "./project.ts";
import { selectPresenter, detectCI } from "./tui/index.ts";
import { emitGraph, isGraphFormat, GRAPH_FORMATS, type GraphFormat } from "./graph/index.ts";
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
  /** `graph` subcommand: emit the DAG instead of running. */
  graph?: boolean;
  /** Graph output format (defaults to mermaid). */
  format?: GraphFormat;
  /** `graph --steps`: expand each job to its ordered steps. */
  steps?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  let workspace: string | undefined;
  let workdir: string | undefined;
  let quiet = false;
  let inputs: Record<string, unknown> = {};
  let config: string | undefined;
  let format: GraphFormat | undefined;
  let steps = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--workspace") {
      workspace = argv[++i];
      if (!workspace) fail("--workspace requires a directory path");
    } else if (arg === "--format") {
      const fmt = argv[++i];
      if (!fmt) fail("--format requires a value");
      if (!isGraphFormat(fmt)) fail(`--format must be one of: ${GRAPH_FORMATS.join(", ")}`);
      format = fmt;
    } else if (arg === "--steps") {
      steps = true;
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

  // `graph <file|name>` — emit the DAG instead of running. By-name when
  // `--workspace` is given (like `run`), else treat the target as a file path.
  if (positionals[0] === "graph") {
    const target = positionals[1];
    if (!target) fail("graph requires a workflow file or name, e.g. `pi-workflows graph ci.yaml`");
    if (positionals.length > 2) fail(`unexpected argument: ${positionals[2]}`);
    const fmt = format ?? "mermaid";
    return workspace
      ? { graph: true, format: fmt, steps, name: target, ...common }
      : { graph: true, format: fmt, steps, file: target, ...common };
  }

  // `run <name>` (by-name) vs. a bare `<workflow.yaml>` path (ad-hoc).
  if (positionals[0] === "run") {
    const name = positionals[1];
    if (!name) fail("run requires a workflow name, e.g. `pi-workflows run ci`");
    if (positionals.length > 2) fail(`unexpected argument: ${positionals[2]}`);
    return { name, ...common };
  }
  if (workspace) fail("--workspace only applies to `run <name>` / `graph <name>`; pass a file path directly instead");
  if (format) fail("--format only applies to `graph`");
  if (steps) fail("--steps only applies to `graph`");
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
      "  pi-workflows [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--workdir <dir>] [--quiet]\n" +
      "  pi-workflows graph <workflow.yaml> [--format mermaid|dot|json|ascii] [--steps]\n" +
      "  pi-workflows [--workspace <dir>] graph <name> [--format mermaid|dot|json|ascii] [--steps]\n",
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

  // Surface non-fatal authoring warnings (e.g. deprecated/implicit runs-on) on
  // stderr; the run still proceeds.
  for (const w of plan.warnings ?? []) process.stderr.write(`pi-workflows: warning: ${w}\n`);

  // `graph` is inspection-only: emit the compiled DAG and exit before any
  // runtime/config/work-dir setup.
  if (args.graph) {
    process.stdout.write(emitGraph(plan, args.format ?? "mermaid", { steps: args.steps ?? false }));
    process.exit(0);
  }

  // Load provider/model config (for agent steps). Absent config is fine until an
  // agent step actually needs a model.
  let config: PiWorkflowsConfig | undefined;
  const configPath = resolveConfigPath(args.config);
  if (configPath) config = await loadConfig(configPath);

  const workRoot = args.workdir
    ? resolve(args.workdir)
    : await mkdtemp(join(tmpdir(), "pi-workflows-"));

  // Pick how to present the run: quiet (silent), a live DAG-aware board on an
  // interactive TTY, or the buffered per-job-block output everywhere else (CI,
  // pipes). The presenter is a pure consumer of the runtime's hooks.
  const out = process.stdout;
  const presenter = selectPresenter({
    out,
    quiet: args.quiet,
    isTTY: Boolean(out.isTTY),
    isCI: detectCI(),
  });
  presenter.start(plan);

  // Compose the agent uses-handler into the (agent-agnostic) runtime. For
  // sandboxed jobs, `resolveJobNetwork` allowlists the model host and injects the
  // API key so an in-guest agent can reach the model without the key entering the
  // guest.
  const runtime = new AbsurdRuntime({
    usesHandlers: [createAgentUsesHandler({ config })],
    resolveJobNetwork: makeAgentEgressResolver(config),
  });
  let result;
  try {
    result = await runtime.run(plan, {
      workRoot,
      workspaceSource: layout.workspaceSource,
      workflowDir: layout.workflowDir,
      hooks: presenter.hooks,
    });
  } finally {
    await runtime.close();
  }

  presenter.finish(result);
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
