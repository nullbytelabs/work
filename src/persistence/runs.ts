/**
 * Durable run history (`web-ui-research.md` §8, option B). The Absurd schema
 * already persists per-job/-step execution state, but there is no *run-level*
 * record — a "run" is only implicit in task names. This adds a first-class,
 * queryable `work.runs` table the engine owns, so the web UI's history list
 * survives a server restart instead of living only in memory.
 *
 * It is engine-*adjacent*: it uses the engine's generic `query` seam (its own
 * table, not Absurd's) and writes a tiny row at run start + finish. Timestamps are
 * stored as `bigint` epoch-ms to sidestep timestamptz parsing differences — pg
 * returns bigint as a string, so reads go through `Number(...)`.
 *
 * Phase 1 scope: run *metadata* (status/time/trigger/inputs). Per-step log
 * persistence (so a finished run's logs re-render after restart) is Phase 2 — a
 * restarted server lists past runs but can't replay their live SSE log.
 */
import type { AbsurdEngine } from "../runtime/index.ts";

// `interrupted` = the run didn't finish (its orchestrator was torn out mid-flight);
// resumable, distinct from `failure` (a job ran and exited non-zero).
export type RunStatus = "queued" | "running" | "success" | "failure" | "interrupted";
export type RunTrigger = "dispatch" | "webhook";

export interface RunRow {
  id: string;
  name: string;
  status: RunStatus;
  trigger: RunTrigger;
  /** epoch ms */
  startedAt: number;
  /** epoch ms; absent while still running/queued */
  finishedAt?: number;
  inputs?: Record<string, unknown>;
  error?: string;
}

/** The raw row shape as the PG wire returns it (bigint → string, jsonb → parsed/text). */
interface RawRow {
  run_id: string;
  workflow: string;
  status: string;
  trigger: string;
  started_at: string | number;
  finished_at: string | number | null;
  inputs: unknown;
  error: string | null;
}

export class RunRepository {
  private readonly engine: AbsurdEngine;

  constructor(engine: AbsurdEngine) {
    this.engine = engine;
  }

  /** Create the schema + table if absent (idempotent — safe on every boot). */
  async ensureSchema(): Promise<void> {
    await this.engine.query("create schema if not exists work");
    await this.engine.query(
      `create table if not exists work.runs (
         run_id      text primary key,
         workflow    text not null,
         status      text not null,
         trigger     text not null,
         started_at  bigint not null,
         finished_at bigint,
         inputs      jsonb,
         error       text
       )`,
    );
  }

  /** Record a newly dispatched run. `on conflict do nothing` makes retries safe. */
  async insert(row: {
    id: string;
    name: string;
    status: RunStatus;
    trigger: RunTrigger;
    startedAt: number;
    inputs?: Record<string, unknown> | undefined;
  }): Promise<void> {
    await this.engine.query(
      `insert into work.runs (run_id, workflow, status, trigger, started_at, inputs)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (run_id) do nothing`,
      [row.id, row.name, row.status, row.trigger, row.startedAt, row.inputs ? JSON.stringify(row.inputs) : null],
    );
  }

  /** Update a run's status (and, for a terminal status, its finish time/error). */
  async setStatus(id: string, status: RunStatus, opts?: { finishedAt?: number; error?: string }): Promise<void> {
    await this.engine.query(
      `update work.runs
         set status = $2,
             finished_at = coalesce($3, finished_at),
             error = coalesce($4, error)
       where run_id = $1`,
      [id, status, opts?.finishedAt ?? null, opts?.error ?? null],
    );
  }

  /** Runs newest-first (the history list). */
  async list(limit = 200): Promise<RunRow[]> {
    const rows = await this.engine.query<RawRow>(
      `select run_id, workflow, status, trigger, started_at, finished_at, inputs, error
         from work.runs order by started_at desc limit $1`,
      [limit],
    );
    return rows.map(toRunRow);
  }

  async get(id: string): Promise<RunRow | undefined> {
    const rows = await this.engine.query<RawRow>(
      `select run_id, workflow, status, trigger, started_at, finished_at, inputs, error
         from work.runs where run_id = $1`,
      [id],
    );
    return rows[0] ? toRunRow(rows[0]) : undefined;
  }
}

function toRunRow(r: RawRow): RunRow {
  const row: RunRow = {
    id: r.run_id,
    name: r.workflow,
    status: r.status as RunStatus,
    trigger: r.trigger as RunTrigger,
    startedAt: Number(r.started_at),
  };
  if (r.finished_at !== null && r.finished_at !== undefined) row.finishedAt = Number(r.finished_at);
  if (r.error !== null && r.error !== undefined) row.error = r.error;
  if (r.inputs !== null && r.inputs !== undefined) {
    row.inputs = typeof r.inputs === "string" ? (JSON.parse(r.inputs) as Record<string, unknown>) : (r.inputs as Record<string, unknown>);
  }
  return row;
}
