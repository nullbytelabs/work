# Durable orchestrator (the DAG walk as a task)

## The gap this closes

Each **job** is already a durable Absurd task and each step a `ctx.step`
checkpoint, so jobs resume. But the **cross-job orchestration** — which jobs to
spawn, in what order, threading `needs` outputs — lived in plain JS inside
`AbsurdRuntime.run`. Resume worked only because that JS walk is deterministic and
the per-job `spawn` is idempotent, so re-invoking `run()` (CLI `--resume`, web boot
reconcile) reconstructs the same orchestration. That's an *external* re-driver, not
durability: nothing in the journal says "this run is mid-flight at job X".

This makes the orchestration itself a durable task, so a crashed run **self-resumes
when any worker runs** — no external re-driver needed.

## Design — a two-queue saga

The whole workflow becomes one durable **orchestrator task** (keyed by `runId`).
It runs the *same* parallel DAG walk we have today, but as a task:

```
run(plan, ctx):
  spawn orchestrator task (idempotencyKey = runId) on the ORCHESTRATOR queue
  start a worker on each queue
  await the orchestrator task's terminal result   ← the WorkflowResult

orchestrator task handler (closure over plan + deps):
  walk the needs DAG exactly as schedule() does today —
    for each job, once its deps' results are known, spawn the JOB task
    (idempotencyKey = `${runId}:${jobId}`) on the JOBS queue and await it
  thread needs.<job>.outputs.* between jobs
  return the assembled WorkflowResult
```

### Why two queues

`ctx.awaitTaskResult` refuses to wait on a task in its **own** queue (it would
deadlock: the orchestrator holds a worker slot while waiting on a job that needs a
slot). The same hazard applies to our own raw-poll await. So the orchestrator runs
on one queue and **job tasks on a separate `jobs` queue**, each with its own worker
pool, so an orchestrator awaiting jobs can never starve them of slots.

Two Absurd clients share the one PGLite pool (`claimTasks` polls the client's own
queue, so a second queue needs a second client). One worker per client.

### Why raw polling, not `ctx.awaitTaskResult`

`ctx.awaitTaskResult` wraps each await in a `ctx.step`. Doing the parallel walk
that way means **concurrent `ctx.step` calls** in one task (one per in-flight job),
which race on the checkpoint counter/cache. Instead the orchestrator awaits jobs by
**raw `fetchTaskResult` polling** (no checkpoint) with a periodic `ctx.heartbeat()`
to keep its own lease alive while it waits. This preserves today's **fine-grained
parallelism** (a job starts the instant its own deps finish — no wave barrier) with
no checkpoint race. The durable state lives in the job tasks; the orchestrator
re-derives its progress by re-walking + re-polling on a re-claim, which is cheap and
idempotent.

### Resume semantics (unchanged, now recursive)

- A finished job's task result is reused (idempotent spawn → completed).
- An **interrupted** job (target torn out → failed task) is re-driven via
  `retryTask`, exactly as today — the logic just moves into the orchestrator.
- An interrupted run's **orchestrator** task likewise fails; re-spawning it (same
  `runId`) — or simply a worker re-claiming it — re-walks, reuses done jobs, and
  re-drives the interrupted one. So both `--resume`/reconcile (explicit re-spawn)
  and Absurd's automatic lease-expiry re-claim drive a run to completion.

## What changes

- **`engine.ts`** — create a second queue + a second `Absurd` client bound to it
  (`jobsApp`), sharing the pool. Expose both.
- **`runtime/absurd/runtime.ts`** — register the orchestrator task (orchestrator
  queue) + the job task (jobs queue); `run()` spawns the orchestrator, starts both
  workers, awaits the orchestrator result. The current `schedule()` walk + retry
  logic moves into the orchestrator handler, awaiting jobs by raw polling +
  heartbeat.
- Job task handler (`runJobInTask`) is **unchanged**.

## Invariants the tests pin

- Existing resume tests (`durable-resume`, `run-resume`, web reconcile) stay green —
  resume semantics are preserved.
- **New:** an abandoned run (orchestrator spawned, process "died") completes when a
  fresh worker runs on the same journal, *without* re-invoking the JS walk — proving
  the orchestration is itself durable.

## Not in scope (follow-ups)

- Snappy hard-kill resume: a job/orchestrator task left *leased* by a dead worker is
  only re-claimable after the claim timeout expires; resetting stale leases on boot
  would make resume immediate instead of waiting it out.
- A server Postgres provider (vs. single-process PGLite) for true multi-process.
