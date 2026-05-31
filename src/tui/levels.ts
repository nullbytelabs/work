/**
 * Topological levels over the `needs` DAG — the structure the layered TUI draws.
 *
 * A job's level is its dependency depth: 0 for a root (no `needs`), else one more
 * than the deepest dependency. Jobs that share a level are the independent,
 * concurrently-ready siblings; the level itself is the indentation/lane the
 * renderer uses to show "what's downstream of what" without drawing edges.
 *
 * Pure over the compiled plan — `jobOrder` is already a valid topological order,
 * so a single left-to-right fold resolves every dependency before the job that
 * needs it.
 */
import type { ExecutionPlan } from "../compiler/index.ts";

export interface Levels {
  /** jobId -> dependency depth (0 = root). */
  level: Map<string, number>;
  /** byLevel[n] = jobIds at depth n, in `jobOrder` order. */
  byLevel: string[][];
}

export function levelize(plan: ExecutionPlan): Levels {
  const level = new Map<string, number>();

  for (const id of plan.jobOrder) {
    const job = plan.jobs[id];
    if (!job) continue;
    let lvl = 0;
    for (const dep of job.needs) {
      const dl = level.get(dep);
      if (dl !== undefined) lvl = Math.max(lvl, dl + 1);
    }
    level.set(id, lvl);
  }

  const byLevel: string[][] = [];
  for (const id of plan.jobOrder) {
    const lvl = level.get(id) ?? 0;
    (byLevel[lvl] ??= []).push(id);
  }
  // Fill any holes (shouldn't occur, but keep the array dense for callers).
  for (let i = 0; i < byLevel.length; i++) byLevel[i] ??= [];

  return { level, byLevel };
}
