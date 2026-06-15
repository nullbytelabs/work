/**
 * Durable per-`(workflow, cron)` scheduler baseline (`work.schedules`). Mirrors
 * `RunRepository`: the same `work` schema, an idempotent `ensureSchema`, and the
 * bigint-epoch-ms convention (PG returns bigint as a string → `Number(...)`). Its
 * `lastFired`/`record` shape is exactly the scheduler's `ScheduleStore`, so `serve`
 * hands it straight to the tick loop.
 */
import type { AbsurdEngine } from "../runtime/index.ts";

export class ScheduleRepository {
  private readonly engine: AbsurdEngine;

  constructor(engine: AbsurdEngine) {
    this.engine = engine;
  }

  async ensureSchema(): Promise<void> {
    await this.engine.query("create schema if not exists work");
    await this.engine.query(
      `create table if not exists work.schedules (
         workflow      text not null,
         cron          text not null,
         last_fired_at bigint not null,
         primary key (workflow, cron)
       )`,
    );
  }

  /** The recorded baseline / last-fired instant for a schedule (epoch ms), or null if unseen. */
  async lastFired(workflow: string, cron: string): Promise<number | null> {
    const rows = await this.engine.query<{ last_fired_at: string | number }>(
      `select last_fired_at from work.schedules where workflow = $1 and cron = $2`,
      [workflow, cron],
    );
    return rows[0] ? Number(rows[0].last_fired_at) : null;
  }

  /** Upsert a schedule's baseline / last-fired instant (epoch ms). */
  async record(workflow: string, cron: string, firedAt: number): Promise<void> {
    await this.engine.query(
      `insert into work.schedules (workflow, cron, last_fired_at)
       values ($1, $2, $3)
       on conflict (workflow, cron) do update set last_fired_at = $3`,
      [workflow, cron, firedAt],
    );
  }
}
