/**
 * work CLI. Two ways to launch a workflow:
 *
 *   work <workflow.yaml>            # ad-hoc: run a file wherever it is
 *   work [--workspace <dir>] run <name>
 *                                   # by name: the `.workflows/*.yaml`
 *                                   #   whose `name:` is <name>
 *
 * Pipeline: resolve -> read -> parseWorkflow -> compile -> AbsurdRuntime.run.
 * Streams step output live and exits non-zero if any job fails.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseWorkflow, WorkflowParseError } from "./spec/index.ts";
import { compile, WorkflowCompileError, type ExecutionPlan } from "./compiler/index.ts";
import { resolveConfigLayers, loadMergedConfig, PROJECT_CONFIG_FILENAME, type PiWorkflowsConfig } from "./config/index.ts";
import { createAbsurdEngine } from "./runtime/index.ts";
import { RunRepository, type RunRow, type RunStatus } from "./persistence/runs.ts";
import { resolveWorkflowLayout, findWorkflowByName, resolveWorkflowRef, WORKFLOWS_DIR, type WorkflowLayout } from "./project.ts";
import { startRun } from "./run.ts";
import { startWebServer } from "./web/index.ts";
import { selectPresenter, detectCI } from "./tui/index.ts";
import { emitGraph, isGraphFormat, GRAPH_FORMATS, type GraphFormat } from "./graph/index.ts";
import { runDoctor } from "./doctor/index.ts";
import { runCreate } from "./scaffold/index.ts";
import { runInit } from "./init/index.ts";
import { UserFacingError } from "./errors.ts";

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
  /** Skip the global config layer for a hermetic run. */
  noGlobal?: boolean;
  /**
   * Datasource keys this run's jobs may reach (`--datasources a,b`) — the CLI
   * counterpart of a webhook's `datasources` scope. Deny-by-default when omitted.
   */
  datasources?: string[];
  /** `graph` subcommand: emit the DAG instead of running. */
  graph?: boolean;
  /** Graph output format (defaults to mermaid). */
  format?: GraphFormat;
  /** `graph --steps`: expand each job to its ordered steps. */
  steps?: boolean;
  /** `--web`: boot the local web UI instead of running a single workflow. */
  web?: boolean;
  /** `--port <n>`: the web UI port (defaults to 4280). */
  port?: number;
  /** `--resume <id>`: continue a prior run's persisted journal instead of starting fresh. */
  resume?: string;
  /** `runs`: list the workspace's run history instead of running a workflow. */
  runs?: boolean;
  /** `runs --status <s>`: filter the history by status. */
  runStatus?: string;
  /** `resume <id>` / `rerun <id>`: recover a prior run by id (workflow + inputs from history). */
  recover?: { id: string; mode: "resume" | "rerun" };
}

/** Mutable accumulator filled by the flag handlers, resolved into CliArgs after. */
interface FlagState {
  positionals: string[];
  workspace?: string;
  workdir?: string;
  quiet: boolean;
  inputs: Record<string, unknown>;
  config?: string;
  noGlobal: boolean;
  datasources?: string[];
  format?: GraphFormat;
  steps: boolean;
  web: boolean;
  port?: number;
  resume?: string;
  status?: string;
}

/** A flag handler: consumes from `argv` starting at `i` and returns the new index. */
type FlagHandler = (argv: string[], i: number, s: FlagState) => number;

const FLAG_HANDLERS: Record<string, FlagHandler> = {
  "--workspace": (argv, i, s) => {
    s.workspace = argv[++i];
    if (!s.workspace) fail("--workspace requires a directory path");
    return i;
  },
  "--web": (_argv, i, s) => {
    s.web = true;
    return i;
  },
  "--port": (argv, i, s) => {
    const raw = argv[++i];
    if (!raw) fail("--port requires a number");
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) fail("--port must be an integer between 1 and 65535");
    s.port = n;
    return i;
  },
  "--format": (argv, i, s) => {
    const fmt = argv[++i];
    if (!fmt) fail("--format requires a value");
    if (!isGraphFormat(fmt)) fail(`--format must be one of: ${GRAPH_FORMATS.join(", ")}`);
    s.format = fmt;
    return i;
  },
  "--steps": (_argv, i, s) => {
    s.steps = true;
    return i;
  },
  "--workdir": (argv, i, s) => {
    s.workdir = argv[++i];
    if (!s.workdir) fail("--workdir requires a directory path");
    return i;
  },
  "--resume": (argv, i, s) => {
    s.resume = argv[++i];
    if (!s.resume) fail("--resume requires a run id");
    return i;
  },
  "--status": (argv, i, s) => {
    s.status = argv[++i];
    if (!s.status) fail("--status requires a value (e.g. interrupted, failure)");
    return i;
  },
  "--config": (argv, i, s) => {
    s.config = argv[++i];
    if (!s.config) fail("--config requires a path");
    return i;
  },
  "--inputs": (argv, i, s) => parseInputsFlag(argv, i, s),
  "--datasources": (argv, i, s) => {
    const raw = argv[++i];
    if (!raw) fail("--datasources requires a comma-separated list of datasource names");
    s.datasources = raw.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
    if (s.datasources.length === 0) fail("--datasources requires at least one datasource name");
    return i;
  },
  "--quiet": (_argv, i, s) => {
    s.quiet = true;
    return i;
  },
  "--no-global": (_argv, i, s) => {
    s.noGlobal = true;
    return i;
  },
};

/** `--inputs '<json>'` — parse and validate the JSON-object payload. */
function parseInputsFlag(argv: string[], i: number, s: FlagState): number {
  const json = argv[++i];
  if (!json) fail("--inputs requires a JSON object string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail("--inputs must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("--inputs must be a JSON object, e.g. '{\"name\":\"ada\"}'");
  }
  s.inputs = parsed as Record<string, unknown>;
  return i;
}

/** Tokenize argv into a FlagState (flags + positionals); `-h`/`--help` exits. */
function parseFlags(argv: string[]): FlagState {
  const s: FlagState = { positionals: [], quiet: false, inputs: {}, noGlobal: false, steps: false, web: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const handler = FLAG_HANDLERS[arg];
    if (handler) {
      i = handler(argv, i, s);
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown flag: ${arg}`);
    } else {
      s.positionals.push(arg);
    }
  }
  return s;
}

/** The flags shared by every command form. */
function buildCommon(s: FlagState) {
  return { workdir: s.workdir, quiet: s.quiet, inputs: s.inputs, noGlobal: s.noGlobal, ...(s.workspace ? { workspace: s.workspace } : {}), ...(s.config ? { config: s.config } : {}), ...(s.datasources ? { datasources: s.datasources } : {}) };
}
type CommonArgs = ReturnType<typeof buildCommon>;

function parseArgs(argv: string[]): CliArgs {
  const s = parseFlags(argv);
  const common = buildCommon(s);
  if (s.positionals[0] === "runs") return resolveRuns(s, common);
  if (s.status) fail("--status only applies to `runs`");
  if (s.positionals[0] === "resume") return resolveRecover(s, common, "resume");
  if (s.positionals[0] === "rerun") return resolveRecover(s, common, "rerun");
  if (s.web) return resolveWeb(s, common);
  if (s.port !== undefined) fail("--port only applies to `--web`");
  if (s.positionals[0] === "graph") return resolveGraph(s, common);
  if (s.positionals[0] === "run") return resolveRun(s, common);
  return resolveFile(s, common);
}

// `resume <id>` / `rerun <id>` — recover a prior run by id (its workflow + inputs
// come from history). `resume` continues the same run (reuses finished jobs);
// `rerun` starts fresh with the same inputs. Both resolve to the normal run path.
function resolveRecover(s: FlagState, common: CommonArgs, mode: "resume" | "rerun"): CliArgs {
  const id = s.positionals[1];
  if (!id) fail(`${mode} requires a run id, e.g. \`${mode} <id>\` (see \`work runs\`)`);
  if (s.positionals.length > 2) fail(`unexpected argument: ${s.positionals[2]}`);
  if (s.resume) fail(`--resume can't be combined with the \`${mode}\` verb`);
  if (s.format || s.steps) fail("--format / --steps only apply to `graph`");
  return { recover: { id, mode }, ...common };
}

// `runs [--status <s>]` — list the workspace's run history (newest-first), no
// workflow target. Reads the shared `.workflows/db` store both the CLI and the web
// write, so it lists runs from either.
function resolveRuns(s: FlagState, common: CommonArgs): CliArgs {
  if (s.positionals.length > 1) fail(`runs takes no positional arguments (got ${s.positionals[1]})`);
  if (s.format || s.steps) fail("--format / --steps only apply to `graph`");
  if (s.resume) fail("--resume applies to a workflow run, not `runs`");
  return { runs: true, ...(s.status ? { runStatus: s.status } : {}), ...common };
}

// `--web` — boot the local web UI over the workspace's `.workflows/` (it
// enumerates *all* pipelines, so it takes no workflow name/file). Allowed with
// `--workspace` and `--port`; rejects the run/graph-only flags.
function resolveWeb(s: FlagState, common: CommonArgs): CliArgs {
  if (s.positionals.length > 0) fail(`--web takes no positional arguments (got ${s.positionals[0]})`);
  if (s.format) fail("--format only applies to `graph`");
  if (s.steps) fail("--steps only applies to `graph`");
  if (s.resume) fail("--resume only applies to `run <name>` / a workflow file");
  return { web: true, ...(s.port !== undefined ? { port: s.port } : {}), ...common };
}

// `graph <file|name>` — emit the DAG instead of running. By-name when
// `--workspace` is given (like `run`), else treat the target as a file path.
function resolveGraph(s: FlagState, common: CommonArgs): CliArgs {
  const target = s.positionals[1];
  if (!target) fail("graph requires a workflow file or name, e.g. `work graph ci.yaml`");
  if (s.positionals.length > 2) fail(`unexpected argument: ${s.positionals[2]}`);
  if (s.resume) fail("--resume only applies to `run`, not `graph`");
  const fmt = s.format ?? "mermaid";
  return s.workspace
    ? { graph: true, format: fmt, steps: s.steps, name: target, ...common }
    : { graph: true, format: fmt, steps: s.steps, file: target, ...common };
}

// `run <name>` — by-name workflow.
function resolveRun(s: FlagState, common: CommonArgs): CliArgs {
  const name = s.positionals[1];
  if (!name) fail("run requires a workflow name, e.g. `work run ci`");
  if (s.positionals.length > 2) fail(`unexpected argument: ${s.positionals[2]}`);
  return { name, ...common, ...(s.resume ? { resume: s.resume } : {}) };
}

// A bare `<workflow.yaml>` path (ad-hoc), the default when no subcommand matched.
function resolveFile(s: FlagState, common: CommonArgs): CliArgs {
  if (s.workspace) fail("--workspace only applies to `run <name>` / `graph <name>`; pass a file path directly instead");
  if (s.format) fail("--format only applies to `graph`");
  if (s.steps) fail("--steps only applies to `graph`");
  if (s.positionals.length === 0) {
    printUsage();
    process.exit(2);
  }
  if (s.positionals.length > 1) fail(`unexpected argument: ${s.positionals[1]}`);
  return { file: s.positionals[0]!, ...common, ...(s.resume ? { resume: s.resume } : {}) };
}

function printUsage(): void {
  // The bin shim sets PI_WF_PROG to however the command was invoked (`work`,
  // `workflow`); fall back to the dev launcher's name.
  const prog = process.env["PI_WF_PROG"] ?? "work";
  process.stderr.write(
    "Usage:\n" +
      `  ${prog} <workflow.yaml> [--inputs '<json>'] [--config <file>] [--datasources <a,b>] [--workdir <dir>] [--resume <id>] [--quiet]\n` +
      `  ${prog} [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--datasources <a,b>] [--workdir <dir>] [--resume <id>] [--quiet]\n` +
      `  ${prog} graph <workflow.yaml> [--format mermaid|dot|json|ascii] [--steps]\n` +
      `  ${prog} [--workspace <dir>] graph <name> [--format mermaid|dot|json|ascii] [--steps]\n` +
      `  ${prog} [--workspace <dir>] resume <id>   # continue an interrupted run (reuse finished jobs)\n` +
      `  ${prog} [--workspace <dir>] rerun <id>    # re-run a past run fresh, same inputs\n` +
      `  ${prog} [--workspace <dir>] runs [--status queued|running|success|failure|interrupted]\n` +
      `  ${prog} [--workspace <dir>] --web [--port <n>]\n` +
      `  ${prog} init [--global] [--include-skill] [--from-template hello-world|agent-action] [--force] [--dry-run]\n` +
      `  ${prog} create <name> [--template hello-world|agent-action] [--force] [--dry-run]\n` +
      `  ${prog} doctor [--json]\n`,
  );
}

function fail(msg: string): never {
  process.stderr.write(`work: ${msg}\n`);
  process.exit(2);
}

/**
 * Boot the local web UI over the workspace's `.workflows/` and keep the process
 * alive on the listening server (Ctrl-C closes it + the owned engine).
 */
async function runWebServer(args: CliArgs): Promise<void> {
  const workspace = args.workspace ?? process.cwd();
  // Load config so agent steps AND the webhook receiver (`webhooks:` /
  // `datasources:`) work. With no explicit `--config`, prefer the *workspace's*
  // project config (the UI/webhooks are scoped to that workspace, which may
  // differ from cwd), falling back to the cwd default otherwise.
  const wsConfig = join(workspace, PROJECT_CONFIG_FILENAME);
  const cfgPath = args.config ?? (existsSync(wsConfig) ? wsConfig : undefined);
  const layers = resolveConfigLayers(cfgPath, { noGlobal: args.noGlobal });
  const config: PiWorkflowsConfig | undefined = await loadMergedConfig(layers);
  // Persist run history under the project so it survives restarts (the server is
  // the sole owner of this dataDir — PGLite is single-process). Gitignore it.
  const dataDir = join(workspace, ".workflows", "db");
  const server = await startWebServer({
    workspace,
    config,
    dataDir,
    ...(args.port !== undefined ? { port: args.port } : {}),
  });
  process.stdout.write(`work web UI: ${server.url}\n`);
  process.stdout.write(`  workspace: ${workspace}\n`);
  process.stdout.write(`  history:   ${dataDir}\n`);
  process.stdout.write(`  auth token: ${server.token}\n`);
  process.stdout.write("Press Ctrl-C to stop.\n");
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const RUN_STATUSES: RunStatus[] = ["queued", "running", "success", "failure", "interrupted"];

/** A short, human relative time ("2m ago") for the run list. */
function relTime(epochMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Print the run history as an aligned table, newest-first, with a resume hint. */
function printRuns(rows: RunRow[], filter: string | undefined): void {
  if (rows.length === 0) {
    process.stdout.write(filter ? `no ${filter} runs\n` : "no runs yet\n");
    return;
  }
  const idW = 8;
  const nameW = Math.max("WORKFLOW".length, ...rows.map((r) => r.name.length));
  const statusW = Math.max("STATUS".length, ...rows.map((r) => r.status.length));
  process.stdout.write(`${"ID".padEnd(idW)}  ${"WORKFLOW".padEnd(nameW)}  ${"STATUS".padEnd(statusW)}  WHEN\n`);
  for (const r of rows) {
    process.stdout.write(`${r.id.slice(0, idW).padEnd(idW)}  ${r.name.padEnd(nameW)}  ${r.status.padEnd(statusW)}  ${relTime(r.startedAt)}\n`);
  }
  // Resumable runs (didn't finish) are the actionable ones — show how to continue.
  const resumable = rows.filter((r) => r.status === "interrupted" || r.status === "running" || r.status === "queued");
  if (resumable.length > 0) {
    const prog = process.env["PI_WF_PROG"] ?? "work";
    const ex = resumable[0]!;
    process.stdout.write(`\n${resumable.length} unfinished — resume one with: ${prog} run ${ex.name} --resume ${ex.id}\n`);
  }
}

/** `runs` — open the shared `.workflows/db` store and print the run history. */
async function listRuns(args: CliArgs): Promise<void> {
  const workspace = args.workspace ?? process.cwd();
  const dataDir = join(workspace, WORKFLOWS_DIR, "db");
  if (!existsSync(dataDir)) {
    process.stdout.write("no runs yet\n");
    process.exit(0);
  }
  if (args.runStatus && !(RUN_STATUSES as string[]).includes(args.runStatus)) {
    fail(`--status must be one of: ${RUN_STATUSES.join(", ")}`);
  }
  const engine = await createAbsurdEngine({ dataDir });
  try {
    const repo = new RunRepository(engine);
    await repo.ensureSchema();
    const rows = await repo.list();
    printRuns(args.runStatus ? rows.filter((r) => r.status === args.runStatus) : rows, args.runStatus);
  } finally {
    await engine.close();
  }
  process.exit(0);
}

/** Look up a past run's workflow + inputs from the shared store (for resume/rerun). */
async function lookupRun(workspace: string, id: string): Promise<{ name: string; inputs?: Record<string, unknown> } | undefined> {
  const dataDir = join(workspace, WORKFLOWS_DIR, "db");
  if (!existsSync(dataDir)) return undefined;
  const engine = await createAbsurdEngine({ dataDir });
  try {
    const repo = new RunRepository(engine);
    await repo.ensureSchema();
    const row = await repo.get(id);
    return row ? { name: row.name, ...(row.inputs ? { inputs: row.inputs } : {}) } : undefined;
  } finally {
    await engine.close();
  }
}

/** For `resume`/`rerun`: resolve the run id to its workflow + inputs and fold them
 *  into `args` so the normal run path takes over (resume reuses the id). */
async function applyRecover(args: CliArgs): Promise<void> {
  if (!args.recover) return;
  const stored = await lookupRun(args.workspace ?? process.cwd(), args.recover.id);
  if (!stored) {
    const prog = process.env["PI_WF_PROG"] ?? "work";
    fail(`no run "${args.recover.id}" found in history (see \`${prog} runs\`)`);
  }
  args.name = stored.name;
  if (Object.keys(args.inputs).length === 0 && stored.inputs) args.inputs = stored.inputs;
  if (args.recover.mode === "resume") args.resume = args.recover.id;
}

async function main(): Promise<void> {
  // Dispatch first, then per-command parse. `doctor` has a disjoint flag set
  // (`--json`) from run/graph, so it owns its own parsing; everything else flows
  // through the unchanged `parseArgs` (run / graph / bare-file path).
  const argv = process.argv.slice(2);
  if (argv[0] === "doctor") {
    process.exit(await runDoctor(argv.slice(1)));
  }
  if (argv[0] === "create") {
    process.exit(await runCreate(argv.slice(1)));
  }
  if (argv[0] === "init") {
    process.exit(await runInit(argv.slice(1)));
  }

  const args = parseArgs(argv);

  // `runs` — list the workspace's run history and exit (no workflow target).
  if (args.runs) {
    await listRuns(args);
    return;
  }

  // `--web` — boot the local web UI and keep the process alive (it does NOT
  // resolve a single workflow; the UI enumerates every pipeline in the
  // workspace). Branches before the single-workflow resolve below.
  if (args.web) {
    await runWebServer(args);
    return; // keep the event loop alive on the listening server
  }

  // `resume <id>` / `rerun <id>` — fill the workflow + inputs from history, then
  // fall through to the normal run path. `resume` reuses the run id (continues the
  // run); `rerun` leaves it unset (a fresh run with the same inputs).
  await applyRecover(args);

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
    plan = compile(spec, {
      inputs: args.inputs,
      // Reusable-workflow resolution: `uses: workflow/<name>` / `./x.yaml` refs
      // resolve relative to the caller's workflow dir; the resolver owns all I/O.
      resolveWorkflow: resolveWorkflowRef,
      _fromDir: layout.workflowDir,
      _chain: [layout.file],
      _depth: 0,
    });
  } catch (err) {
    if (err instanceof WorkflowParseError || err instanceof WorkflowCompileError) {
      fail(err.message);
    }
    throw err;
  }

  // Surface non-fatal authoring warnings (e.g. deprecated/implicit runs-on) on
  // stderr; the run still proceeds.
  for (const w of plan.warnings ?? []) process.stderr.write(`work: warning: ${w}\n`);

  // `graph` is inspection-only: emit the compiled DAG and exit before any
  // runtime/config/work-dir setup.
  if (args.graph) {
    process.stdout.write(emitGraph(plan, args.format ?? "mermaid", { steps: args.steps ?? false }));
    process.exit(0);
  }

  // Load config, set up the presenter, persist a resumable journal, dispatch,
  // and exit — all in the shared helper (keeps `main` to resolution + branching).
  await dispatchRun(args, layout, plan);
}

/**
 * Run a resolved workflow to completion and exit the process. Loads provider
 * config, picks a presenter, and dispatches through the shared `startRun`.
 *
 * A `.workflows/` project persists to the same store the web UI uses
 * (`.workflows/db`): the run is durable (resumable via `--resume <id>`) and listed
 * in history alongside web-triggered runs. A bare ad-hoc file (not in a
 * `.workflows/` dir) runs ephemerally — no store, so no resume. Exits 0 on
 * success, 1 on failure (printing how to resume for a persisted run).
 */
async function dispatchRun(args: CliArgs, layout: WorkflowLayout, plan: ExecutionPlan): Promise<never> {
  // Load provider/model config (for agent steps), merging global + project
  // layers (global is the creds home; the project layer overrides). Absent
  // config is fine until an agent step actually needs a model.
  const layers = resolveConfigLayers(args.config, { noGlobal: args.noGlobal });
  const config: PiWorkflowsConfig | undefined = await loadMergedConfig(layers);

  // Resolve the store + run id up front (before any presenter output) so a bad
  // `--resume` fails cleanly. Resume recompiles the *same* workflow file, so its
  // plan — and thus each job's `${runId}:${jobId}` key — must be unchanged; editing
  // the workflow between a run and its resume is unsupported.
  const persistent = basename(layout.workflowDir) === WORKFLOWS_DIR;
  const dataDir = persistent ? join(layout.workflowDir, "db") : undefined;
  const runId = args.resume ?? randomUUID();
  if (args.resume) {
    if (!persistent) fail("--resume needs a .workflows/ project (an ad-hoc file run isn't persisted)");
    if (!existsSync(dataDir!)) fail(`no runs to resume (no store at ${dataDir})`);
  }

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
  if (!args.quiet && persistent) process.stderr.write(`work: run ${runId}\n`);

  // The actual dispatch (config + work-root + agent-composed runtime + persistent
  // store + run + close) lives in `startRun`, shared with the web UI so both call
  // one path — and, with a dataDir, record into the same history.
  const result = await startRun({
    plan,
    workspaceSource: layout.workspaceSource,
    workflowDir: layout.workflowDir,
    ...(presenter.hooks ? { hooks: presenter.hooks } : {}),
    config,
    runId,
    ...(args.datasources ? { datasources: args.datasources } : {}),
    ...(dataDir ? { dataDir } : {}),
    ...(args.workdir ? { workdir: args.workdir } : {}),
  });

  presenter.finish(result);
  if (result.status === "success") process.exit(0);
  // An `interrupted` run didn't finish (the platform was torn out) — point at
  // `--resume`. A genuine `failure` ran to a verdict; the presenter already showed
  // it, and re-running is the user's call (a `retry` verb is coming).
  if (persistent && result.status === "interrupted") {
    const prog = process.env["PI_WF_PROG"] ?? "work";
    const how = args.name !== undefined ? `run ${args.name}` : args.file!;
    process.stderr.write(`work: run ${runId} was interrupted — resume with: ${prog} ${how} --resume ${runId}\n`);
  }
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof UserFacingError) {
    process.stderr.write(`work: ${err.message}\n`);
  } else {
    process.stderr.write(`work: unexpected error: ${(err as Error).stack ?? err}\n`);
  }
  process.exit(1);
});
