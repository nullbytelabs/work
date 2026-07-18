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
import { expressionBodies, type ExecutionPlan } from "./compiler/index.ts";
import { resolveImageConfig, ensureImageTag } from "./images/index.ts";
import type { TargetFactory } from "./targets/index.ts";
import { createWorkHandler, makeAgentEgressResolver } from "./agent/index.ts";
import { createActionUsesHandler, type SubUsesDispatch } from "./actions/index.ts";
import { VERSION } from "./version.ts";
import type { UsesHandler } from "./runtime/index.ts";
import { RunRepository } from "./persistence/runs.ts";
import { RunEventRepository, type StoredFrame } from "./persistence/run-events.ts";
import { expandEnvStrict, type WorkConfig } from "./config/index.ts";
import { UserFacingError } from "./errors.ts";
import { startTelemetry, createTelemetryHooks, combineRunHooks, type TelemetryHandle } from "./observability/index.ts";

/**
 * Records a run's lifecycle as durable event frames — the `work.run_events`
 * stream the web UI replays. A pure hooks→frame adapter with no transport; the
 * concrete implementation (the web's frame presenter) is injected by the
 * composition root so this shared run path depends on no front-end.
 */
interface RunRecorder {
  hooks: RunHooks;
  start(plan: ExecutionPlan): void;
  finish(result: WorkflowResult): void;
}

/** Builds a {@link RunRecorder} bound to a run id + a sink for its emitted frames. */
type RunRecorderFactory = (runId: string, emit: (frame: StoredFrame) => void) => RunRecorder;

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
  config?: WorkConfig | undefined;
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
   * Builds the durable run-event recorder for a persistent run (a `dataDir` run we
   * own). The composition root injects it (the CLI passes the web's frame
   * presenter) so this shared path reaches into no front-end. Omitted → a
   * persistent run still records its history *row*, just no replayable event
   * frames; ignored for a non-persistent run.
   */
  makeRecorder?: RunRecorderFactory;
  /**
   * Injected telemetry handle (tests pass an in-memory-backed one). When omitted,
   * `startRun` builds one from `config.observability` — off unless enabled, so the
   * default path is unchanged. An injected handle is NOT owned: the caller flushes,
   * inspects, and shuts it down (mirrors the `engine` ownership rule).
   */
  telemetry?: TelemetryHandle;
}

/** Every `secrets.<name>` a plan actually references, across `run:`/`env:`/`with:`. */
function referencedSecrets(plan: ExecutionPlan): Set<string> {
  const names = new Set<string>();
  const scan = (tpl: string | undefined): void => {
    if (!tpl) return;
    for (const body of expressionBodies(tpl)) {
      const m = /^secrets\.([A-Za-z_][\w-]*)$/.exec(body) ?? /^secrets\[\s*['"]([^'"]+)['"]\s*\]$/.exec(body);
      if (m) names.add(m[1]!);
    }
  };
  for (const job of Object.values(plan.jobs)) {
    for (const step of job.steps) {
      scan(step.run);
      for (const v of Object.values(step.env)) scan(v);
      for (const v of Object.values(step.with ?? {})) if (typeof v === "string") scan(v);
    }
  }
  return names;
}

/**
 * Resolve the secrets a workflow actually references into a spread-ready runtime
 * option, **failing fast** if any can't be fulfilled — undeclared in `work.json`,
 * or declared as a `$VAR` that isn't set. Only *referenced* secrets are checked, so
 * an unrelated declared secret with an unset var never blocks a run. Returns `{}`
 * when the workflow references none (the option stays unset; the feature is inert).
 */
function secretsOption(plan: ExecutionPlan, config?: WorkConfig): { secrets?: Record<string, string> } {
  const referenced = referencedSecrets(plan);
  if (referenced.size === 0) return {};
  const declared = config?.secrets ?? {};
  const secrets: Record<string, string> = {};
  const unfulfillable: string[] = [];
  for (const name of referenced) {
    if (!(name in declared)) {
      unfulfillable.push(`  - ${name}: not declared in the secrets: block of work.json`);
      continue;
    }
    try {
      secrets[name] = expandEnvStrict(declared[name]!, `secret "${name}"`);
    } catch (err) {
      // expandEnvStrict throws a "$VAR is not set" UserFacingError — fold its
      // message into the aggregated list so every problem shows at once.
      unfulfillable.push(`  - ${name}: ${(err as Error).message.replace(/^secret "[^"]*" /, "")}`);
    }
  }
  if (unfulfillable.length > 0) {
    throw new UserFacingError(
      `this workflow references secrets that can't be fulfilled:\n${unfulfillable.join("\n")}`,
    );
  }
  return { secrets };
}

/**
 * Resolve the per-run work root. A caller-provided `workdir` is theirs to keep; a
 * temp one we mint is keyed by runId (stable across a resume) — NOT a fresh mkdtemp
 * — because a resumed job re-stages only the checkout and fast-forwards
 * already-completed steps without re-running them, so the filesystem side-effects of
 * those steps (build/, etc.) must still be on disk. `startRun` keeps a minted dir
 * for an `interrupted` (resumable) run and removes it only on a terminal outcome.
 */
async function prepareWorkRoot(workdir: string | undefined, runId: string): Promise<{ workRoot: string; ownsWorkRoot: boolean }> {
  if (workdir !== undefined) return { workRoot: resolve(workdir), ownsWorkRoot: false };
  const workRoot = join(tmpdir(), `work-${runId}`);
  await mkdir(workRoot, { recursive: true });
  return { workRoot, ownsWorkRoot: true };
}

/**
 * Construct the agent-composed `AbsurdRuntime`, run the plan, and close. Returns
 * the `WorkflowResult`. `runtime.close()` always runs in `finally` — it's a no-op
 * for an injected `engine`, so this is safe for both the per-run-engine CLI path
 * and the shared-engine web path.
 */
export async function startRun(opts: StartRunOptions): Promise<WorkflowResult> {
  // Fail fast — before any work dir or engine — if the workflow references a
  // `${{ secrets.* }}` that can't be fulfilled (undeclared, or an unset `$VAR`). A
  // clear up-front error beats a confusing empty credential surfacing mid-run.
  const secretsOpt = secretsOption(opts.plan, opts.config);

  // Resolve the run id up front so the journal, the history row, the runtime, AND
  // the work dir all key on the same id (a `--resume` reuses every one of them).
  const runId = opts.runId ?? randomUUID();
  const { workRoot, ownsWorkRoot } = await prepareWorkRoot(opts.workdir, runId);

  // Compose the `uses:` handlers into the (agent-agnostic) runtime. A composite
  // action's inner `uses:` sub-steps route through a late-bound dispatcher that
  // resolves by scheme over this same handler set — so `work/agent` and nested
  // `action/<name>` work inside a composite, and built-in `work/*` actions run via
  // the action path. Per-job egress comes from the agent resolver: allow-all
  // egress with a host-scoped model key injected host-side for any model-running
  // step — never entering the guest. An injected engine is shared (not closed per
  // run).
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
  const { runStore, recorder } = await setupDurableRecord(persistent, engine, runId, opts.plan, eventWrites, opts.makeRecorder);

  // Fan run events to the caller's presenter, the telemetry emitter, AND the durable
  // event recorder (when persistent).
  const hooks = combineRunHooks(telemetryHooks, recorder?.hooks);

  const runtime = new AbsurdRuntime({
    engine,
    usesHandlers: handlers,
    resolveJobNetwork: makeAgentEgressResolver(opts.config),
    // The `work.json` `secrets:` whitelist, `$ENV`-expanded host-side, for
    // `${{ secrets.* }}` passthrough into a step's guest env (path b). Computed
    // up-front (above) so the value never reaches the durable plan and an
    // unfulfillable secret fails the run before it starts.
    ...secretsOpt,
    // Resolve a job's guest image: a `work:<image>` resolves to a build-config
    // (user images override bundled) and is built on first use, returning the
    // selector to boot; stock `gondolin` resolves to undefined. Tests inject a
    // `makeTarget` double that ignores this, so they never build.
    resolveImagePath: async (spec) => {
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
 * false here and the server owns these writes — no double-write.) The injected
 * `makeRecorder` builds a pure hooks→frame adapter (no server deps); seq is minted
 * synchronously so frame order is stable even if the async appends settle out of
 * order. Returns empty when not persistent; records the history row but no event
 * frames when no recorder is injected.
 */
async function setupDurableRecord(
  persistent: boolean,
  engine: AbsurdEngine,
  runId: string,
  plan: ExecutionPlan,
  eventWrites: Promise<unknown>[],
  makeRecorder: RunRecorderFactory | undefined,
): Promise<{ runStore?: RunRepository; recorder?: RunRecorder }> {
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
  if (!makeRecorder) return { runStore };
  const eventStore = new RunEventRepository(engine);
  await eventStore.ensureSchema();
  let seq = 0;
  const recorder = makeRecorder(runId, (frame) => {
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
