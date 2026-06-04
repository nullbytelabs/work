/**
 * Durable per-run event/log stream (web-ui-research.md §8, Phase 2). The
 * `RunRepository` (runs.ts) persists run *metadata* so the history list survives
 * a restart — but a restarted server still can't *replay* a finished run's live
 * SSE log, because those frames lived only in the in-memory ring buffer. This
 * adds a first-class `work.run_events` table that mirrors that ring durably: one
 * row per emitted frame, keyed by `(run_id, seq)`, so a fresh server can stream a
 * past run's `run-init` + step-output + `run-end` frames back in order.
 *
 * Same shape as `RunRepository`: it rides the engine's generic `query` seam (its
 * own table, not Absurd's), is created idempotently on every boot, and declares
 * fields then assigns in the constructor body (no parameter-properties — Node's
 * type-stripping runs under `erasableSyntaxOnly`). Frame `data` is stored as
 * `jsonb`; pg returns it parsed (or as text on some paths), so reads normalize.
 */
import type { AbsurdEngine } from "../runtime/index.ts";

/** One persisted frame: an SSE `event:` name + its JSON `data` payload. */
export interface StoredFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Raw row as the PG wire returns it (jsonb → parsed object, or text on some paths). */
interface RawEventRow {
  event: string;
  data: unknown;
}

export class RunEventRepository {
  private readonly engine: AbsurdEngine;

  constructor(engine: AbsurdEngine) {
    this.engine = engine;
  }

  /** Create the schema + table if absent (idempotent — safe on every boot). */
  async ensureSchema(): Promise<void> {
    // `create schema if not exists` is harmless if runs.ts already made it.
    await this.engine.query("create schema if not exists work");
    await this.engine.query(
      `create table if not exists work.run_events (
         run_id text not null,
         seq    int  not null,
         event  text not null,
         data   jsonb not null,
         primary key (run_id, seq)
       )`,
    );
  }

  /**
   * Append one frame at the caller-assigned `seq`. The seq is minted
   * synchronously by the broadcaster so order is fixed even if these inserts
   * settle out of order; `on conflict do nothing` keeps a re-append idempotent.
   */
  async append(runId: string, seq: number, frame: StoredFrame): Promise<void> {
    await this.engine.query(
      `insert into work.run_events (run_id, seq, event, data)
       values ($1, $2, $3, $4)
       on conflict (run_id, seq) do nothing`,
      [runId, seq, frame.event, JSON.stringify(frame.data)],
    );
  }

  /** Every persisted frame for a run, in emit (`seq`) order — the replay stream. */
  async list(runId: string): Promise<StoredFrame[]> {
    const rows = await this.engine.query<RawEventRow>(
      `select event, data from work.run_events where run_id = $1 order by seq asc`,
      [runId],
    );
    return rows.map((r) => ({
      event: r.event,
      data:
        typeof r.data === "string"
          ? (JSON.parse(r.data) as Record<string, unknown>)
          : (r.data as Record<string, unknown>),
    }));
  }

  /**
   * Whether any frames exist for this run — used to tell a real past run (replay
   * its log) apart from an unknown id (404).
   */
  async has(runId: string): Promise<boolean> {
    const rows = await this.engine.query<{ one: number }>(
      `select 1 as one from work.run_events where run_id = $1 limit 1`,
      [runId],
    );
    return rows.length > 0;
  }
}
