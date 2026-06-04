/**
 * Durable webhook delivery audit log (the Webhooks UI's "Recent deliveries"
 * panel). The webhook receiver (`POST /hooks/:name`) already authenticates and
 * dispatches, but it kept no *record* of who tried what — so an operator can't
 * see a botched secret, a tampered signature, or a load-shed delivery after the
 * fact. This adds a first-class `work.webhook_deliveries` table the engine owns:
 * one row per delivery attempt at every fail-closed/accepted exit, **never** the
 * payload or secret — only the outcome, status, and source.
 *
 * Same shape as `RunRepository`/`RunEventRepository`: it rides the engine's
 * generic `query` seam (its own table, not Absurd's), is created idempotently on
 * every boot, and stores timestamps as `bigint` epoch-ms to sidestep timestamptz
 * parsing differences — pg returns bigint as a string, so reads go through
 * `Number(...)`. No constructor parameter-properties (Node's type-stripping runs
 * under `erasableSyntaxOnly`): the field is declared then assigned in the body.
 */
import type { AbsurdEngine } from "../runtime/index.ts";

/** A delivery's outcome — mirrors `handleHook`'s exits plus the UI "test" action. */
export type DeliveryResult =
  | "accepted"
  | "duplicate"
  | "unauthorized"
  | "forbidden"
  | "disabled"
  | "not_opted_in"
  | "too_large"
  | "bad_request"
  | "at_capacity"
  | "test";

/** One audited delivery as exposed to the UI (newest-first). Never the payload/secret. */
export interface DeliveryRow {
  /** epoch ms */
  ts: number;
  result: string;
  httpStatus: number;
  /** The run this delivery started, when any (accepted/duplicate/test); else null. */
  runId: string | null;
  /** The delivering peer's address, best-effort (`req.socket.remoteAddress`). */
  sourceIp: string | null;
}

/** Raw row as the PG wire returns it (bigint → string). */
interface RawDeliveryRow {
  result: string;
  http_status: number;
  run_id: string | null;
  source_ip: string | null;
  ts: string | number;
}

export class DeliveryRepository {
  private readonly engine: AbsurdEngine;

  constructor(engine: AbsurdEngine) {
    this.engine = engine;
  }

  /** Create the schema + table if absent (idempotent — safe on every boot). */
  async ensureSchema(): Promise<void> {
    // `create schema if not exists` is harmless if runs.ts already made it.
    await this.engine.query("create schema if not exists work");
    await this.engine.query(
      `create table if not exists work.webhook_deliveries (
         id          bigserial primary key,
         hook        text not null,
         workflow    text,
         result      text not null,
         http_status int  not null,
         run_id      text,
         source_ip   text,
         ts          bigint not null
       )`,
    );
  }

  /** Append one audited delivery. */
  async append(d: {
    hook: string;
    workflow?: string | undefined;
    result: DeliveryResult;
    httpStatus: number;
    runId?: string | undefined;
    sourceIp?: string | undefined;
    ts: number;
  }): Promise<void> {
    await this.engine.query(
      `insert into work.webhook_deliveries (hook, workflow, result, http_status, run_id, source_ip, ts)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [d.hook, d.workflow ?? null, d.result, d.httpStatus, d.runId ?? null, d.sourceIp ?? null, d.ts],
    );
  }

  /** Deliveries for a hook, newest-first (by insert order), capped. */
  async listForHook(hook: string, limit = 50): Promise<DeliveryRow[]> {
    const rows = await this.engine.query<RawDeliveryRow>(
      `select result, http_status, run_id, source_ip, ts
         from work.webhook_deliveries
        where hook = $1
        order by id desc
        limit $2`,
      [hook, limit],
    );
    return rows.map((r) => ({
      ts: Number(r.ts),
      result: r.result,
      httpStatus: r.http_status,
      runId: r.run_id,
      sourceIp: r.source_ip,
    }));
  }
}
