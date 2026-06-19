/**
 * "Re-run failed jobs" — the GitHub-Actions tactic of retrying just the jobs that
 * failed in a prior run, reusing the ones that already passed, against the SAME
 * runId so the resume picks up where the passing jobs left off.
 *
 * The journal already makes this *almost* free: a job task is keyed by an
 * idempotency key of `${runId}:${jobId}`, so a re-driven run (same runId) reuses a
 * job task that's still present. The one thing in the way is that a job which ran
 * and *failed cleanly* (a step exited non-zero) is a `completed` task with a
 * `failure` result — a real terminal outcome that resume deliberately never
 * retries — and the whole run's orchestrator task likewise `completed` with a
 * `failure` WorkflowResult.
 *
 * So a "retry failed" is: **clear** the failed job tasks' journal (task + runs +
 * checkpoints) so a fresh spawn recomputes them from scratch, and clear the
 * orchestrator task so a re-spawn re-walks the DAG — reusing every surviving
 * (successful) job task and re-running only the cleared ones. Skipped downstream
 * jobs never spawned a task, so they're simply re-evaluated by the re-walk.
 *
 * This only ever deletes *failed* state, never a successful job's result, and is a
 * no-op (deletes nothing) when there's nothing to retry — so the caller can detect
 * "no failed jobs" without having mutated the journal.
 */
import type { AbsurdEngine } from "./engine.ts";
import { JOBS_QUEUE } from "./engine.ts";

/** The orchestrator task's queue (the default queue the persistent engine boots
 *  with — see runtime.ts `QUEUE` and engine.ts `createAbsurdEngine`). */
const ORCH_QUEUE = "default";

export interface RetryResetResult {
  /** Job ids whose journal was cleared so they re-run on the next invocation. */
  jobsReset: string[];
}

/** A job task's persisted shape, enough to tell a failure from a success. */
interface JobTaskRow {
  idempotency_key: string;
  task_id: string;
  state: string;
  status: string | null;
}

/**
 * Reset a prior run's *failed* jobs so a re-driven run (same runId) re-runs them
 * while reusing its successful jobs. Returns the cleared job ids; an empty result
 * means nothing failed (and nothing was mutated).
 */
export async function resetFailedJobs(engine: AbsurdEngine, runId: string): Promise<RetryResetResult> {
  // This run's job tasks (idempotency key `${runId}:${jobId}`) and their outcome:
  // `completed_payload->>'status'` is the JobResult status for a finished task.
  const prefix = `${runId}:`;
  const rows = await engine.query<JobTaskRow>(
    `select idempotency_key, task_id, state, completed_payload->>'status' as status
       from absurd.t_${JOBS_QUEUE}
      where idempotency_key like $1`,
    [prefix + "%"],
  );

  // A real failure: a clean non-zero exit (completed task, failure result) or a
  // task left `failed` (an interruption). Successful jobs are left untouched.
  const failed = rows.filter((r) => r.state === "failed" || (r.state === "completed" && r.status === "failure"));
  if (failed.length === 0) return { jobsReset: [] };

  for (const r of failed) await deleteTask(engine, JOBS_QUEUE, r.task_id);

  // The orchestrator (idempotency key = runId) completed with the failure
  // WorkflowResult; clear it so a re-spawn re-walks the DAG instead of replaying
  // the recorded failure.
  const orch = await engine.query<{ task_id: string }>(
    `select task_id from absurd.t_${ORCH_QUEUE} where idempotency_key = $1`,
    [runId],
  );
  for (const o of orch) await deleteTask(engine, ORCH_QUEUE, o.task_id);

  return { jobsReset: failed.map((r) => r.idempotency_key.slice(prefix.length)) };
}

/** Delete a task and its dependent run/checkpoint rows from a queue's tables. The
 *  queue name is a fixed constant (never user input), so the identifier splice is
 *  safe. */
async function deleteTask(engine: AbsurdEngine, queue: string, taskId: string): Promise<void> {
  await engine.query(`delete from absurd.c_${queue} where task_id = $1::uuid`, [taskId]);
  await engine.query(`delete from absurd.r_${queue} where task_id = $1::uuid`, [taskId]);
  await engine.query(`delete from absurd.t_${queue} where task_id = $1::uuid`, [taskId]);
}
