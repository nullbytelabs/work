/**
 * `RunManager` — the long-lived registry the one-shot CLI doesn't need. The CLI
 * runs one workflow and exits; a server hosts many runs over time, each with its
 * own set of live SSE subscribers and a backlog for browsers that connect
 * mid-run. This holds all of that in memory (Phase 0 — session-scoped history,
 * nothing durable; see docs/web-ui-research.md §8).
 *
 * Per dispatch it: mints a run id, registers a `RunRecord`, and starts the run
 * **in the background (not awaited)** so `POST /api/runs` can return `202` while
 * the workflow runs. A `WebPresenter` translates the run's hooks into SSE frames
 * that flow through `broadcast` to every subscriber (and into a bounded ring so
 * late subscribers can replay the history before tailing live).
 */
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ExecutionPlan } from "../compiler/index.ts";
import { resetFailedJobs } from "../runtime/index.ts";
import type { AbsurdEngine } from "../runtime/index.ts";
import type { TargetFactory } from "../targets/index.ts";
import type { PiWorkflowsConfig } from "../config/index.ts";
import { startRun } from "../run.ts";
import type { TelemetryHandle } from "../observability/index.ts";
import type { RunRepository } from "../persistence/runs.ts";
import type { RunEventRepository } from "../persistence/run-events.ts";
import { WebPresenter, type Frame } from "./web-presenter.ts";

/**
 * A run's lifecycle state. "queued" while waiting for a concurrency slot,
 * "running" once started, then a terminal "success"/"failure".
 */
// `interrupted` = the run didn't finish (orchestrator torn out mid-flight) — resumable.
export type RunStatus = "queued" | "running" | "success" | "failure" | "interrupted";

/** How a run was started: the UI's "Run workflow" button, an authenticated webhook POST, or a cron schedule. */
export type RunTrigger = "dispatch" | "webhook" | "schedule";

export interface RunRecord {
  id: string;
  name: string;
  status: RunStatus;
  startedAt: number;
  /** What started this run — `dispatch` (UI button) or `webhook` (remote POST). */
  trigger: RunTrigger;
  /** Open SSE responses tailing this run. */
  subscribers: Set<ServerResponse>;
  /** Bounded backlog of emitted frames for late subscribers (oldest dropped). */
  ring: Frame[];
  /**
   * Monotonic counter for the next durable-event seq. Minted synchronously in
   * `broadcast` so persisted frames keep a stable order even if the async
   * `eventStore.append` inserts settle out of order. Only used when `eventStore`
   * is present; otherwise it just idles.
   */
  nextSeq: number;
}

/** The workflow's checkout layout, forwarded into `startRun`. */
interface DispatchLayout {
  workspaceSource?: string;
  workflowDir?: string;
}

export interface DispatchOptions {
  name: string;
  layout: DispatchLayout;
  plan: ExecutionPlan;
  /** Caller-supplied run id (tests pin it); minted when omitted. */
  runId?: string;
  /** What started this run (default "dispatch"). */
  trigger?: RunTrigger;
}

export interface RunManagerOptions {
  /** The shared engine every run executes on (booted once by the server). */
  engine: AbsurdEngine;
  /** Provider/model config for agent steps. */
  config?: PiWorkflowsConfig | undefined;
  /** Override the runs-on → target factory (tests inject a host double). */
  makeTarget?: TargetFactory;
  /**
   * Max runs executing at once (default 4). Each run may itself spin several job
   * VMs, so this bounds the host's gondolin load under a burst of triggers.
   */
  maxConcurrentRuns?: number;
  /** Max runs allowed to wait for a slot before new triggers are shed (default 100). */
  maxQueuedRuns?: number;
  /**
   * Durable run-history store. When provided, runs are recorded at dispatch and
   * updated on finish, and `list()` reads from it (so history survives restart).
   * Omit for the in-memory, session-scoped history (the default / injected-engine
   * tests).
   */
  runStore?: RunRepository;
  /**
   * Durable per-run event/log store. When provided, every broadcast frame is
   * also persisted (fire-and-forget, ordered by a synchronous seq), so a fresh
   * server can replay a finished run's full SSE log via `replayHistorical`. Omit
   * for the in-memory, session-scoped behavior (the injected-engine path).
   */
  eventStore?: RunEventRepository;
  /**
   * Shared telemetry handle (started once by the server). Injected into every run so
   * the OTel SDK is registered ONCE for the process — not re-started per run. Omit when
   * telemetry is disabled.
   */
  telemetry?: TelemetryHandle;
}

/** The outcome of a dispatch: accepted (running or queued) or shed at capacity. */
export type DispatchResult = { accepted: true; record: RunRecord } | { accepted: false; reason: "full" };

/** Cap the per-run backlog so a chatty run can't grow memory without bound. */
const RING_CAP = 2000;
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const DEFAULT_MAX_QUEUED_RUNS = 100;

export class RunManager {
  private readonly engine: AbsurdEngine;
  private readonly config: PiWorkflowsConfig | undefined;
  private readonly makeTarget: TargetFactory | undefined;
  private readonly runStore: RunRepository | undefined;
  private readonly eventStore: RunEventRepository | undefined;
  private readonly telemetry: TelemetryHandle | undefined;
  private readonly runs = new Map<string, RunRecord>();
  /** Insertion order, so `list()` can return newest-first cheaply. */
  private readonly order: string[] = [];
  private readonly maxConcurrentRuns: number;
  private readonly maxQueuedRuns: number;
  /** Runs currently executing (each holds one concurrency slot). */
  private active = 0;
  /** FIFO of queued launch thunks, run as slots free up. */
  private readonly queue: Array<() => void> = [];
  /**
   * The settle-promise of every in-flight `launch()` (the full
   * `.then().catch().finally()` chain). `whenIdle()` awaits these so a caller can
   * drain background runs before tearing the engine down — each run's worker is
   * closed inside `startRun` *before* its chain settles, so once these resolve no
   * worker is left polling a pool that's about to end. Without this drain, closing
   * the engine mid-run orphans a worker that spins forever on `claimTasks`
   * ("Cannot use a pool after calling end on the pool") and hangs the process.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(opts: RunManagerOptions) {
    this.engine = opts.engine;
    this.config = opts.config;
    this.makeTarget = opts.makeTarget;
    this.runStore = opts.runStore;
    this.eventStore = opts.eventStore;
    this.telemetry = opts.telemetry;
    this.maxConcurrentRuns = Math.max(1, opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS);
    this.maxQueuedRuns = Math.max(0, opts.maxQueuedRuns ?? DEFAULT_MAX_QUEUED_RUNS);
  }

  /**
   * Register a run and either start it now or queue it for a free slot. Returns
   * `{ accepted, record }` immediately so the HTTP layer can hand back `202` with
   * the run id; the SSE stream carries the live progress. When every slot is busy
   * AND the queue is full, the run is shed (`{ accepted: false }`) so the caller
   * returns `429` instead of spawning unbounded gondolin VMs under a trigger storm.
   */
  dispatch(opts: DispatchOptions): DispatchResult {
    const id = opts.runId ?? randomUUID();

    const atCapacity = this.active >= this.maxConcurrentRuns;
    if (atCapacity && this.queue.length >= this.maxQueuedRuns) {
      return { accepted: false, reason: "full" };
    }

    const record: RunRecord = {
      id,
      name: opts.name,
      status: atCapacity ? "queued" : "running",
      startedAt: Date.now(),
      trigger: opts.trigger ?? "dispatch",
      subscribers: new Set(),
      ring: [],
      nextSeq: 0,
    };
    this.runs.set(id, record);
    this.order.push(id);

    // Seed the DAG immediately — even while queued — so an SSE subscriber sees the
    // graph; job events flow once the run actually starts.
    const presenter = new WebPresenter(id, (frame) => this.broadcast(id, frame));
    presenter.start(opts.plan);

    // Record the run durably (best-effort). The terminal status update awaits this
    // insert so it can't race ahead of the row's creation.
    const inserted = this.runStore
      ? this.runStore
          .insert({ id, name: opts.name, status: record.status, trigger: record.trigger, startedAt: record.startedAt, inputs: opts.plan.inputs, event: opts.plan.event })
          .catch(() => {})
      : Promise.resolve();

    const launch = () => this.launch(record, opts, presenter, inserted);
    if (atCapacity) {
      this.queue.push(launch);
    } else {
      this.active++;
      launch();
    }

    return { accepted: true, record };
  }

  /** Actually run a dispatched workflow in the background; release its slot on settle. */
  private launch(record: RunRecord, opts: DispatchOptions, presenter: WebPresenter, inserted: Promise<void>): void {
    record.status = "running";
    const chain = startRun({
      plan: opts.plan,
      ...(opts.layout.workspaceSource !== undefined ? { workspaceSource: opts.layout.workspaceSource } : {}),
      ...(opts.layout.workflowDir !== undefined ? { workflowDir: opts.layout.workflowDir } : {}),
      runId: record.id,
      config: this.config,
      engine: this.engine,
      ...(this.makeTarget ? { makeTarget: this.makeTarget } : {}),
      ...(this.telemetry ? { telemetry: this.telemetry } : {}),
      hooks: presenter.hooks,
    })
      .then(async (result) => {
        record.status = result.status;
        // Persist the terminal status BEFORE emitting run-end, so a client that
        // re-queries history right after seeing run-end observes the final state.
        await this.persistTerminal(record.id, result.status, inserted);
        presenter.finish(result);
      })
      .catch(async (err) => {
        record.status = "failure";
        const message = err instanceof Error ? err.message : String(err);
        await this.persistTerminal(record.id, "failure", inserted, message);
        // The presenter's `finish` never ran, so emit a terminal frame ourselves
        // (with the error text on stderr-style output) so the browser unblocks.
        this.broadcast(record.id, { event: "run-end", data: { runId: record.id, ts: Date.now(), status: "failure", error: message } });
      })
      .finally(() => {
        this.active--;
        this.drain();
      });
    this.inFlight.add(chain);
    void chain.finally(() => this.inFlight.delete(chain));
  }

  /**
   * Resolve once no run is executing or queued. Drains in waves: queued runs
   * launch as active ones settle (via `drain()` in each run's `finally`), so we
   * re-check after each batch until both the in-flight set and the queue are
   * empty. Teardown (`server.close()`, tests) awaits this before closing the
   * engine so no worker is orphaned against an ended pool.
   */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0 || this.queue.length > 0) {
      if (this.inFlight.size === 0) this.drain(); // flush queue if nothing is settling to trigger it
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Best-effort durable write of a run's terminal status (after its insert landed). */
  private async persistTerminal(id: string, status: RunStatus, inserted: Promise<void>, error?: string): Promise<void> {
    if (!this.runStore) return;
    try {
      await inserted;
      await this.runStore.setStatus(id, status, { finishedAt: Date.now(), ...(error !== undefined ? { error } : {}) });
    } catch {
      /* history is best-effort; never let it fail a run */
    }
  }

  /** Fill every free slot from the FIFO queue. */
  private drain(): void {
    while (this.active < this.maxConcurrentRuns && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active++;
      next();
    }
  }

  /**
   * Append a frame to the run's ring (dropping the oldest past the cap) and write
   * it as SSE `event:`/`data:` lines to every live subscriber.
   */
  broadcast(runId: string, frame: Frame): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.ring.push(frame);
    if (record.ring.length > RING_CAP) record.ring.shift();
    const wire = frameToSse(frame);
    for (const res of record.subscribers) res.write(wire);

    // Persist durably (best-effort) so a restarted server can replay this run's
    // full log. Mint the seq synchronously here — that fixes the frame's order
    // even if the async insert below settles out of order under concurrency. A
    // persistence error must never break the live broadcast above, so swallow it.
    if (this.eventStore) {
      const seq = record.nextSeq++;
      this.eventStore.append(runId, seq, frame).catch(() => {});
    }
  }

  /**
   * Attach an SSE response to a run: replay the backlog first (so a late
   * subscriber sees the run-init DAG + history), then tail live. Removes itself
   * when the response closes.
   */
  subscribe(runId: string, res: ServerResponse): void {
    const record = this.runs.get(runId);
    if (!record) return;
    for (const frame of record.ring) res.write(frameToSse(frame));
    record.subscribers.add(res);
    res.on("close", () => record.subscribers.delete(res));
  }

  /**
   * Replay a *past* run's persisted log to an SSE response: write the
   * `text/event-stream` headers, then every stored frame in `seq` order (the
   * same `event:`/`data:` serialization as live `broadcast`), then end the
   * stream. Returns `true` when it replayed a real run, `false` (writing
   * nothing) when the id is unknown to the event store — so the caller can still
   * send a clean JSON 404 on its untouched response. Used for runs no longer
   * live in memory (e.g. after a server restart).
   *
   * It owns the headers (rather than the caller) precisely so that the `false`
   * case leaves the response pristine for a JSON 404.
   */
  async replayHistorical(runId: string, res: ServerResponse): Promise<boolean> {
    if (!this.eventStore) return false;
    if (!(await this.eventStore.has(runId))) return false;
    const frames = await this.eventStore.list(runId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    for (const frame of frames) res.write(frameToSse(frame));
    res.end();
    return true;
  }

  /**
   * Last-resort replay for a run with NO persisted event frames — a run recorded before
   * event-stream persistence existed (`work.run_events` empty for it). Surface its stored
   * terminal status from `work.runs` as a minimal `run-init` + `run-end`, so the detail
   * view shows the real outcome instead of hanging on "Running". No step detail — those
   * frames are genuinely gone — but the run is no longer a perpetual spinner. Returns
   * `false` (untouched response) when there's no store or no row, so the caller can 404.
   */
  async replayStoredStatus(runId: string, res: ServerResponse): Promise<boolean> {
    if (!this.runStore) return false;
    const row = await this.runStore.get(runId);
    if (!row) return false;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    const send = (event: string, data: Record<string, unknown>) => res.write(frameToSse({ event, data: { runId, ts: Date.now(), ...data } }));
    send("run-init", { name: row.name, jobOrder: [], jobs: {}, status: row.status });
    send("run-end", { status: row.status, ...(row.error !== undefined ? { error: row.error } : {}) });
    res.end();
    return true;
  }

  /**
   * The stored metadata needed to *re-run* a past run (its workflow name + the
   * inputs it was dispatched with). Delegates to the durable run store; returns
   * undefined when there's no store (in-memory/injected-engine path) or no row.
   */
  async getStored(runId: string): Promise<{ name: string; inputs?: Record<string, unknown>; event?: Record<string, unknown> } | undefined> {
    if (!this.runStore) return undefined;
    const row = await this.runStore.get(runId);
    if (!row) return undefined;
    return {
      name: row.name,
      ...(row.inputs !== undefined ? { inputs: row.inputs } : {}),
      ...(row.event !== undefined ? { event: row.event } : {}),
    };
  }

  /**
   * Prepare a "re-run failed jobs" retry of a past `failure` run: clear its failed
   * jobs (and the run's orchestrator) from the durable journal so a re-dispatch
   * under the SAME run id reuses the jobs that passed and re-runs only the failed
   * ones (the GitHub-Actions tactic; mirrors the CLI's `work retry`). Also clears
   * the prior attempt's recorded log + flips the run row back to `running` so the
   * retry records its own. Returns the cleared job ids; an empty list means there
   * was nothing to retry (the caller answers 409 and dispatches nothing).
   *
   * The caller then `dispatch`es with `runId` set to the same id, so the durable
   * journal resumes — reusing the surviving (successful) job tasks.
   */
  async prepareRetry(runId: string): Promise<{ jobsReset: string[] }> {
    const { jobsReset } = await resetFailedJobs(this.engine, runId);
    if (jobsReset.length === 0) return { jobsReset };
    if (this.eventStore) await this.eventStore.clear(runId);
    if (this.runStore) await this.runStore.setStatus(runId, "running");
    return { jobsReset };
  }

  /**
   * Runs newest-first (the history list). Reads from the durable store when one is
   * configured (so it survives restart and includes runs from earlier sessions),
   * else falls back to the in-memory, session-scoped registry.
   */
  async list(): Promise<{ id: string; name: string; status: RunStatus; startedAt: number; trigger: RunTrigger }[]> {
    if (this.runStore) {
      return (await this.runStore.list()).map((r) => ({ id: r.id, name: r.name, status: r.status, startedAt: r.startedAt, trigger: r.trigger }));
    }
    const out: { id: string; name: string; status: RunStatus; startedAt: number; trigger: RunTrigger }[] = [];
    for (let i = this.order.length - 1; i >= 0; i--) {
      const r = this.runs.get(this.order[i]!);
      if (r) out.push({ id: r.id, name: r.name, status: r.status, startedAt: r.startedAt, trigger: r.trigger });
    }
    return out;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }
}

/** Serialize a frame to the SSE wire format (one `event:` + one JSON `data:` line). */
function frameToSse(frame: Frame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
