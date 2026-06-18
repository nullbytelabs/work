/**
 * The transport-free scheduler tick. `serve` boots this on an interval; it owns no
 * HTTP, no engine, no croner internal scheduler — it computes due slots (`dueSlot`)
 * and hands each to an injected `dispatch`. Everything it touches is injected, so
 * it is unit-testable with a fake clock, store, and dispatch.
 */
import { dueSlot } from "./due.ts";

/** A workflow with one cron expression, as discovered from `on: { schedule: [...] }`. */
export interface ScheduledItem {
  workflow: string;
  cron: string;
}

export interface ScheduleClock {
  now(): number;
}

/**
 * Per-`(workflow, cron)` last-fired (a.k.a. baseline) state. An in-memory map
 * suffices for tests; in `serve` this is backed by the `work.schedules` table.
 */
export interface ScheduleStore {
  lastFired(workflow: string, cron: string): Promise<number | null>;
  record(workflow: string, cron: string, firedAt: number): Promise<void>;
}

export interface SchedulerDeps {
  /** Re-read on each tick — picks up edits to `.workflows/*.yaml` without a restart. */
  listScheduled: () => Promise<ScheduledItem[]> | ScheduledItem[];
  store: ScheduleStore;
  /** Fire a scheduled run. `runId` is the slot-derived idempotency key (exactly-once per slot). */
  dispatch: (fire: { workflow: string; cron: string; runId: string; slot: number }) => void | Promise<void>;
  clock: ScheduleClock;
  /**
   * Report a single schedule that threw while being evaluated (e.g. a malformed
   * cron — `dueSlot` builds a `Cron` that throws on a bad expression — or a
   * dispatch failure). Each schedule is isolated, so one bad entry never aborts the
   * tick; this surfaces it instead of swallowing it. Optional: omit to drop quietly.
   */
  onError?: (item: ScheduledItem, err: unknown) => void;
}

/** The slot-derived idempotency key: stable per canonical slot instant, so duplicate ticks collapse. */
export function slotRunId(workflow: string, slot: number): string {
  return `cron:${workflow}:${new Date(slot).toISOString()}`;
}

/**
 * Evaluate every scheduled workflow once and dispatch any with a slot due. A
 * never-seen schedule is seeded to "now" (so it fires from the next slot forward,
 * never retroactively); thereafter a fired slot advances `lastFired`, so the same
 * slot is not dispatched twice.
 */
export async function tick(deps: SchedulerDeps): Promise<void> {
  const now = deps.clock.now();
  for (const item of await deps.listScheduled()) {
    const { workflow, cron } = item;
    // Isolate each schedule: a malformed cron (`dueSlot` throws building the `Cron`)
    // or a throwing dispatch must not abort evaluation of the schedules after it.
    try {
      const last = await deps.store.lastFired(workflow, cron);
      const slot = dueSlot(cron, last ?? now, now);
      if (slot === null) {
        if (last === null) await deps.store.record(workflow, cron, now); // seed baseline; no retroactive fire
        continue;
      }
      await deps.dispatch({ workflow, cron, runId: slotRunId(workflow, slot), slot });
      await deps.store.record(workflow, cron, slot);
    } catch (err) {
      deps.onError?.(item, err);
    }
  }
}

/**
 * Reset every schedule's baseline to `now` without firing — drops any slots that
 * elapsed while the host was down. Missed slots are skipped, never caught up. Call
 * once on boot, before starting the ticker.
 */
export async function seedBaselines(deps: SchedulerDeps): Promise<void> {
  const now = deps.clock.now();
  for (const { workflow, cron } of await deps.listScheduled()) {
    await deps.store.record(workflow, cron, now);
  }
}
