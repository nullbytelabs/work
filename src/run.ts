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
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine, type RunHooks, type WorkflowResult } from "./runtime/index.ts";
import { parseRunsOn, type ExecutionPlan } from "./compiler/index.ts";
import { resolveImageConfig, ensureImageTag } from "./images/index.ts";
import type { TargetFactory } from "./targets/index.ts";
import { createWorkHandler, makeAgentEgressResolver } from "./agent/index.ts";
import { createActionUsesHandler, type SubUsesDispatch } from "./actions/index.ts";
import { VERSION } from "./version.ts";
import type { UsesHandler } from "./runtime/index.ts";
import { composeResolvers, makeDatasourceEgressResolver } from "./egress/index.ts";
import { RunRepository } from "./persistence/runs.ts";
import { RunEventRepository } from "./persistence/run-events.ts";
import { WebPresenter } from "./web/web-presenter.ts";
import { expandEnv, type PiWorkflowsConfig } from "./config/index.ts";
import { startTelemetry, createTelemetryHooks, combineRunHooks, type TelemetryHandle } from "./observability/index.ts";

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
  /**
   * Injected telemetry handle (tests pass an in-memory-backed one). When omitted,
   * `startRun` builds one from `config.observability` — off unless enabled, so the
   * default path is unchanged. An injected handle is NOT owned: the caller flushes,
   * inspects, and shuts it down (mirrors the `engine` ownership rule).
   */
  telemetry?: TelemetryHandle;
}

/**
 * Construct the agent-composed `AbsurdRuntime`, run the plan, and close. Returns
 * the `WorkflowResult`. `runtime.close()` always runs in `finally` — it's a no-op
 * for an injected `engine`, so this is safe for both the per-run-engine CLI path
 * and the shared-engine web path.
 */
/**
 * Resolve the per-run work root. A caller-provided `workdir` is theirs to keep; a
 * temp one we mint is keyed by runId (stable across a resume) — NOT a fresh mkdtemp
 * — because a resumed job re-stages only the checkout and fast-forwards
 * already-completed steps without re-running them, so the filesystem side-effects of
 * those steps (build/, etc.) must still be on disk. `startRun` keeps a minted dir
 * for an `interrupted` (resumable) run and removes it only on a terminal outcome.
 */
/**
 * Expand the `work.json` `secrets:` whitelist host-side into name → value, as a
 * spread-ready runtime option (`{}` when none are declared, so the option stays
 * unset and the feature is fully inert). A `$VAR` that isn't set expands to ""
 * (lenient — see the call site).
 */
function secretsOption(config?: PiWorkflowsConfig): { secrets?: Record<string, string> } {
  if (!config?.secrets) return {};
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.secrets)) secrets[name] = expandEnv(value);
  return { secrets };
}

async function prepareWorkRoot(workdir: string | undefined, runId: string): Promise<{ workRoot: string; ownsWorkRoot: boolean }> {
  if (workdir !== undefined) return { workRoot: resolve(workdir), ownsWorkRoot: false };
  const workRoot = join(tmpdir(), `work-${runId}`);
  await mkdir(workRoot, { recursive: true });
  return { workRoot, ownsWorkRoot: true };
}

export async function startRun(opts: StartRunOptions): Promise<WorkflowResult> {
  // Resolve the run id up front so the journal, the history row, the runtime, AND
  // the work dir all key on the same id (a `--resume` reuses every one of them).
  const runId = opts.runId ?? randomUUID();
  const { workRoot, ownsWorkRoot } = await prepareWorkRoot(opts.workdir, runId);

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

  // Telemetry hooks (caller's presenter + the emitter); flush is a no-op for an
  // injected handle.
  const { hooks: telemetryHooks, flush } = await composeTelemetry(opts);

  // Fire-and-forget event appends, drained before the engine closes so the final
  // `run-end` write isn't lost to `engine.close()`.
  const eventWrites: Promise<unknown>[] = [];
  const { runStore, recorder } = await setupDurableRecord(persistent, engine, runId, opts.plan, eventWrites);

  // Fan run events to the caller's presenter, the telemetry emitter, AND the durable
  // event recorder (when persistent).
  const hooks = combineRunHooks(telemetryHooks, recorder?.hooks);

  const runtime = new AbsurdRuntime({
    engine,
    usesHandlers: handlers,
    resolveJobNetwork: composeResolvers(
      makeAgentEgressResolver(opts.config),
      makeDatasourceEgressResolver(opts.config, opts.datasources ? { datasources: opts.datasources } : {}),
    ),
    // The `work.json` `secrets:` whitelist, `$ENV`-expanded host-side, for
    // `${{ secrets.* }}` passthrough into a step's guest env (path b). Resolved here
    // (the composition root) so the value never reaches the durable plan; an unset
    // `$VAR` expands to "" (lenient, like other config refs — doctor warns later).
    ...secretsOption(opts.config),
    // Resolve a job's guest image: a `work:<image>` resolves to a build-config
    // (user images override bundled) and is built on first use, returning the
    // selector to boot; stock `gondolin` resolves to undefined. Tests inject a
    // `makeTarget` double that ignores this, so they never build.
    resolveImagePath: async (runsOn) => {
      const spec = parseRunsOn(runsOn);
      if (spec.namespace !== "work" || spec.variant === undefined) return undefined;
      const configPath = resolveImageConfig(spec.variant, opts.workspaceSource);
      return ensureImageTag(spec.variant, configPath, (text) => process.stderr.write(text));
    },
    ...(opts.makeTarget ? { makeTarget: opts.makeTarget } : {}),
  });

  // An `interrupted` run is resumable, so its work dir must survive to the next
  // invocation; a terminal run's dir is ours to remove.
  let resumable = false;
  try {
    const result = await runtime.run(opts.plan, {
      workRoot,
      ...(opts.workspaceSource !== undefined ? { workspaceSource: opts.workspaceSource } : {}),
      ...(opts.workflowDir !== undefined ? { workflowDir: opts.workflowDir } : {}),
      hooks,
      runId,
    });
    resumable = result.status === "interrupted";
    if (runStore) await runStore.setStatus(runId, result.status, { finishedAt: Date.now() });
    recorder?.finish(result); // the `run-end` frame (terminal status)
    return result;
  } catch (err) {
    // The runtime normally returns interrupted/failure rather than throwing; on a real
    // throw still write a terminal record + `run-end` so history/replay never strand the
    // run as perpetually "running".
    const message = err instanceof Error ? err.message : String(err);
    if (runStore) await runStore.setStatus(runId, "failure", { finishedAt: Date.now(), error: message }).catch(() => {});
    recorder?.finish({ name: opts.plan.name, status: "failure", jobs: [] });
    throw err;
  } finally {
    await flush(); // flush spans/metrics before exit (no-op for an injected handle)
    await runtime.close(); // no-op for the injected (web) engine
    await Promise.allSettled(eventWrites); // ensure the event log (incl. run-end) landed before close
    if (ownsEngine) await engine.close();
    // Keep a resumable (interrupted) run's work dir so `resume` finds completed
    // steps' filesystem side-effects; clean up only on a terminal outcome.
    if (ownsWorkRoot && !resumable) await rm(workRoot, { recursive: true, force: true });
  }
}

/**
 * The durable record for a run we own a persistent engine for: the `work.runs` history
 * row AND the per-run event stream (`work.run_events`) — exactly what the web
 * `RunManager` writes for a web-triggered run, so a run's `.workflows/db` record is
 * identical regardless of front-end and the web detail view can replay a CLI run in
 * full. (A *web* run reaches `startRun` with an injected engine, so `persistent` is
 * false here and the server owns these writes — no double-write.) `WebPresenter` is a
 * pure hooks→frame adapter (no server deps); seq is minted synchronously so frame order
 * is stable even if the async appends settle out of order. Returns empty when not
 * persistent.
 */
async function setupDurableRecord(
  persistent: boolean,
  engine: AbsurdEngine,
  runId: string,
  plan: ExecutionPlan,
  eventWrites: Promise<unknown>[],
): Promise<{ runStore?: RunRepository; recorder?: WebPresenter }> {
  if (!persistent) return {};
  const runStore = new RunRepository(engine);
  await runStore.ensureSchema();
  // `insert` is idempotent (on conflict do nothing), so resuming re-uses the row.
  await runStore.insert({
    id: runId,
    name: plan.name,
    status: "running",
    trigger: "dispatch",
    startedAt: Date.now(),
    ...(plan.inputs ? { inputs: plan.inputs } : {}),
  });
  const eventStore = new RunEventRepository(engine);
  await eventStore.ensureSchema();
  let seq = 0;
  const recorder = new WebPresenter(runId, (frame) => {
    eventWrites.push(eventStore.append(runId, seq++, frame).catch(() => {}));
  });
  recorder.start(plan); // the `run-init` frame (the DAG)
  return { runStore, recorder };
}

/**
 * Resolve the run's telemetry: an injected handle (tests) or one built from
 * `config.observability` (off unless enabled). Returns the hooks to pass the runtime —
 * the caller's presenter fanned out with the emitter when telemetry is on — and a
 * `flush` for `finally` that shuts an OWNED handle down (so a CLI run exports before
 * exit) but no-ops for an injected handle (the caller closes it).
 */
async function composeTelemetry(opts: StartRunOptions): Promise<{ hooks?: RunHooks; flush: () => Promise<void> }> {
  // An injected handle is shared (the web/serve process started it once); we own one we
  // start ourselves (a one-shot CLI run). Either way the emitter is built FRESH here so
  // its per-run span state is isolated — critical when a shared handle drives several
  // concurrent runs. The shared tracer/meter are concurrency-safe; instruments aggregate.
  const owns = opts.telemetry === undefined;
  const telemetry = opts.telemetry ?? (await startTelemetry(opts.config?.observability, VERSION));
  if (!telemetry) return { ...(opts.hooks ? { hooks: opts.hooks } : {}), flush: () => Promise.resolve() };
  const emitter = createTelemetryHooks({ tracer: telemetry.tracer, meter: telemetry.meter });
  return {
    hooks: combineRunHooks(opts.hooks, emitter),
    flush: owns ? () => telemetry.shutdown() : () => Promise.resolve(),
  };
}
