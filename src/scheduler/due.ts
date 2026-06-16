/**
 * Pure cron timing math, built only on croner's `nextRun(ref)` (which is strict,
 * reference-relative, and reliable — unlike `previousRun`, which reflects only a
 * running job's own state). Cron expressions are evaluated in **UTC** for
 * GitHub-Actions parity, independent of the host timezone.
 */
import { Cron } from "croner";

/**
 * Bound the forward walk when a long gap has elapsed (e.g. the host was down for a
 * week with an every-minute cron). Skip-by-default means we only ever fire the
 * *latest* due slot, so a cap just means convergence takes a few extra ticks on a
 * pathological gap — never a backfill flood. Missed slots are skipped, never caught up.
 */
const MAX_COALESCE = 1000;

/**
 * The latest cron slot in the half-open window `(since, now]`, as epoch ms, or
 * `null` if none has elapsed. **Skip-by-default**: when several slots elapsed
 * during a gap, only the most recent is returned (older misses are skipped, not
 * backfilled). The returned instant is the canonical scheduled time, so a stable
 * `cron:<wf>:<slot>` idempotency key collapses repeated ticks of the same slot.
 */
export function dueSlot(cron: string, since: number, now: number): number | null {
  const c = new Cron(cron, { timezone: "UTC" });
  const first = c.nextRun(new Date(since)); // strictly after `since`
  if (first === null || first.getTime() > now) return null;
  let slot = first;
  for (let i = 0; i < MAX_COALESCE; i++) {
    const next = c.nextRun(slot);
    if (next === null || next.getTime() > now) break;
    slot = next;
  }
  return slot.getTime();
}

/** The next scheduled instant strictly after `after` (epoch ms), or `null`. UTC. */
export function nextFire(cron: string, after: number): number | null {
  const n = new Cron(cron, { timezone: "UTC" }).nextRun(new Date(after));
  return n === null ? null : n.getTime();
}
