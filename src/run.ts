/**
 * The shared dispatch sequence — the one place that turns a compiled plan into a
 * finished `WorkflowResult`. Both the CLI (`work run …`) and the web UI's
 * `RunManager` call this, so they share *exactly* one run path: same config load,
 * same work-root allocation, same `AbsurdRuntime` construction (agent uses-handler
 * + per-job egress), same close semantics.
 *
 * It deliberately does NOT own presentation. The caller hands `hooks` (the CLI's
 * presenter hooks, or the web presenter's SSE sink) and starts/finishes around
 * the call. Keeping presentation out means the web layer reuses this untouched.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine, type RunHooks, type WorkflowResult } from "./runtime/index.ts";
import type { ExecutionPlan } from "./compiler/index.ts";
import type { TargetFactory } from "./targets/index.ts";
import { createWorkHandler, makeAgentEgressResolver } from "./agent/index.ts";
import { createActionUsesHandler, type SubUsesDispatch } from "./actions/index.ts";
import type { UsesHandler } from "./runtime/index.ts";
import { composeResolvers, makeDatasourceEgressResolver } from "./egress/index.ts";
import { RunRepository } from "./persistence/runs.ts";
import type { PiWorkflowsConfig } from "./config/index.ts";

export interface StartRunOptions {
  /** The compiled plan to run. */
  plan: ExecutionPlan;
  /**
   * Directory staged into every job's working directory (the checkout). Together
   * with `workflowDir` this is the workflow's `WorkflowLayout` spread in.
   */
  workspaceSource?: string;
  /** Directory holding the workflow definition + local assets (agent packages). */
  workflowDir?: string;
  /** Run hooks (presenter / SSE sink). */
  hooks?: RunHooks;
  /** Caller-supplied stable run id (web mints it up front); defaults to a UUID. */
  runId?: string;
  /** Provider/model config for agent steps. */
  config?: PiWorkflowsConfig | undefined;
  /**
   * Datasource keys this run's jobs may reach (e.g. a webhook's `datasources`
   * scope). Composed with the agent egress resolver and forwarded to the runtime,
   * so a plain `run:` step in this run can reach an allowlisted datasource host
   * with a header-injected token. Deny-by-default — omit and no datasource egress
   * is granted.
   */
  datasources?: string[];
  /** Base working directory; a fresh temp dir is allocated when omitted. */
  workdir?: string;
  /**
   * Persistent store location (a PGLite `dataDir`) — the same `.workflows/db` the
   * web UI uses. When set and no `engine` is injected, `startRun` owns an engine
   * rooted here, so the run is durable: its Absurd journal persists (a later
   * `startRun` with the same `runId` *resumes* — finished jobs are reused, an
   * interrupted job is re-driven) AND the run is recorded in the shared `work.runs`
   * history (so a `work run` shows up in the web UI alongside web-triggered runs).
   * Omit for an ephemeral in-memory run (no resume, no history). Ignored when
   * `engine` is injected — that engine owns its storage and its own history
   * recording (the web's RunManager). PGLite is single-process, so a `dataDir`
   * must not be open in two engines at once.
   */
  dataDir?: string;
  /**
   * A shared `AbsurdEngine` to run on. When provided the runtime does NOT own it
   * (the `ownsEngine` flag is false), so `runtime.close()` is a no-op for it and
   * the engine outlives the run — the web server boots one engine for all runs.
   */
  engine?: AbsurdEngine;
  /** Override the runs-on → ExecutionTarget factory (tests inject a host double). */
  makeTarget?: TargetFactory;
}

/**
 * Construct the agent-composed `AbsurdRuntime`, run the plan, and close. Returns
 * the `WorkflowResult`. `runtime.close()` always runs in `finally` — it's a no-op
 * for an injected `engine`, so this is safe for both the per-run-engine CLI path
 * and the shared-engine web path.
 */
export async function startRun(opts: StartRunOptions): Promise<WorkflowResult> {
  // A caller-provided `workdir` is theirs to keep; a temp one we mint is ours to
  // remove in `finally` (otherwise every run — especially on the long-lived web
  // server — leaks a `pi-workflows-*` dir full of job workspaces under tmp).
  const ownsWorkRoot = opts.workdir === undefined;
  const workRoot = opts.workdir
    ? resolve(opts.workdir)
    : await mkdtemp(join(tmpdir(), "pi-workflows-"));

  // Compose the `uses:` handlers into the (agent-agnostic) runtime. A composite
  // action's inner `uses:` sub-steps route through a late-bound dispatcher that
  // resolves by scheme over this same handler set — so `work/agent` and nested
  // `action/<name>` work inside a composite, and built-in `work/*` actions run via
  // the action path. Per-job egress is the union of the agent/action resolver
  // (allow-all for jobs with a uses-step + a host-scoped model key) and the
  // datasource resolver (a scoped datasource host + injected token for a `run:`
  // step). Secrets are injected host-side only — never entering the guest. An
  // injected engine is shared (not closed per run).
  const handlers: UsesHandler[] = [];
  const dispatch: SubUsesDispatch = (subCtx) => {
    const scheme = subCtx.uses.split("/", 1)[0]!;
    const h = handlers.find((x) => x.scheme === scheme);
    if (!h) {
      subCtx.emit({ stream: "stderr", text: `no handler for uses: "${subCtx.uses}"` });
      return Promise.resolve({ status: "failure", stderr: `no handler for uses: "${subCtx.uses}"` });
    }
    return h.run(subCtx);
  };
  handlers.push(
    createWorkHandler({ config: opts.config, dispatch }),
    createActionUsesHandler({ dispatch }),
  );

  // Own the engine unless one is injected. When we own it AND a `dataDir` is given,
  // it persists there (the shared `.workflows/db`) so the run is durable + recorded
  // in history; otherwise it's ephemeral in-memory. An injected engine (the web)
  // brings its own storage and history recording, so we touch neither here.
  const ownsEngine = opts.engine === undefined;
  const persistent = ownsEngine && opts.dataDir !== undefined;
  if (persistent) await mkdir(opts.dataDir!, { recursive: true });
  const engine = opts.engine ?? (await createAbsurdEngine(opts.dataDir ? { dataDir: opts.dataDir } : {}));

  // Resolve the run id up front so the journal, the history row, and the runtime
  // all key on the same id (and a `--resume` reuses it).
  const runId = opts.runId ?? randomUUID();

  // Record the run in the shared history (`work.runs`) when we own a persistent
  // engine — the same table the web UI lists, so a CLI run is a first-class run.
  // `insert` is idempotent (on conflict do nothing), so resuming re-uses the row.
  let runStore: RunRepository | undefined;
  if (persistent) {
    runStore = new RunRepository(engine);
    await runStore.ensureSchema();
    await runStore.insert({
      id: runId,
      name: opts.plan.name,
      status: "running",
      trigger: "dispatch",
      startedAt: Date.now(),
      ...(opts.plan.inputs ? { inputs: opts.plan.inputs } : {}),
    });
  }

  const runtime = new AbsurdRuntime({
    engine,
    usesHandlers: handlers,
    resolveJobNetwork: composeResolvers(
      makeAgentEgressResolver(opts.config),
      makeDatasourceEgressResolver(opts.config, opts.datasources ? { datasources: opts.datasources } : {}),
    ),
    ...(opts.makeTarget ? { makeTarget: opts.makeTarget } : {}),
  });

  try {
    const result = await runtime.run(opts.plan, {
      workRoot,
      ...(opts.workspaceSource !== undefined ? { workspaceSource: opts.workspaceSource } : {}),
      ...(opts.workflowDir !== undefined ? { workflowDir: opts.workflowDir } : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      runId,
    });
    if (runStore) await runStore.setStatus(runId, result.status, { finishedAt: Date.now() });
    return result;
  } finally {
    await runtime.close(); // no-op for the injected (web) engine
    if (ownsEngine) await engine.close();
    if (ownsWorkRoot) await rm(workRoot, { recursive: true, force: true });
  }
}
