---
name: absurd
description: Absurd durable-workflow concepts and TypeScript SDK (absurd-sdk) usage — tasks, steps/checkpoints, queues, workers, events, retries, idempotency, and how this repo wires Absurd over PGLite. Use when writing or debugging durable tasks, the orchestrator/runtime, or anything touching absurd-sdk.
---

# Absurd & the TypeScript SDK

Absurd is a **Postgres-native durable workflow system**: durable-execution
complexity lives in the database (stored procedures + one `absurd.sql` schema),
keeping the SDK thin. No broker, no coordinator service — just Postgres and a
pull-based worker loop.

**Always use the TypeScript SDK (`absurd-sdk`).** Do not reach for the
`absurdctl` CLI — everything (queues, spawning, retries, events, cancellation)
is done programmatically here.

Docs: https://earendil-works.github.io/absurd/ (concepts at `/concepts/`,
TS SDK at `/sdks/typescript/`). This repo pins `absurd-sdk@0.4.0` with the
matching schema vendored at `src/runtime/absurd/schema.sql`.

## Mental model

- **Task** — top-level unit of work: a name, JSON params, a queue. Spawned, not
  called.
- **Run / attempt** — one execution of a task. Attempt 1 first; a failure
  schedules a new run with backoff. All runs of a task **share checkpoints**.
- **Step (checkpoint)** — a named subdivision inside a handler. A successful
  step's return value is persisted; on retry it is **never re-executed** — the
  cached value is returned. This is the durability primitive.
- **Queue** — a logical namespace (its own `t_`/`r_`/`c_`/`e_`/`w_` table set).
- **Worker** — polls a queue, claims tasks with a time-limited **lease**.
  Writing a checkpoint (or `ctx.heartbeat()`) extends the lease; an expired
  lease lets another worker reclaim the task.
- **Event** — a named signal a task can durably await. **First emit wins**;
  later emits of the same name are ignored (race-free by construction).

### The cardinal rules

1. **Side effects go inside steps.** Code *outside* `ctx.step()` may run many
   times across retries; code inside a completed step runs exactly once.
2. **Step return values must be JSON-serializable** (they're stored in
   Postgres).
3. **Retries are task-level, not step-level.** A failed run restarts the
   handler from the top; completed steps fast-forward from cache.
4. **Awaiting another task from inside a task requires the child to be on a
   different queue**, or the await can deadlock the worker pool (parent holds
   the only slot while waiting for a child that needs a slot on the same
   queue). This is why this repo runs two queues (see below).
5. **Idempotency keys dedupe at spawn**: same key → the existing task is
   returned (`created: false`), no second task.

## SDK usage (verified against absurd-sdk 0.4.0)

### Setup

```ts
import { Absurd } from "absurd-sdk";

const app = new Absurd({ db: pool, queueName: "default" });
// db: a pg.Pool, a connection string, or omitted (env defaults).
// Other options: defaultMaxAttempts (5), log, hooks.
await app.createQueue("default");   // idempotency: throws if it exists — catch and ignore
```

### Register + spawn

```ts
app.registerTask({ name: "send-email" }, async (params, ctx) => {
  const rendered = await ctx.step("render", async () => renderTemplate(params));
  await ctx.step("send", async () => sendMail(params.to, rendered));
  return { ok: true };                       // the task's result (JSON)
});

const { taskID, created } = await app.spawn("send-email",
  { to: "user@example.com" },
  {
    idempotencyKey: "welcome:user-42",       // dedupe
    maxAttempts: 10,
    retryStrategy: { kind: "exponential", baseSeconds: 2, factor: 2, maxSeconds: 300 },
    queue: "emails",                         // required if the task isn't registered locally
    headers: { traceId },                    // JSON metadata → ctx.headers
  });
```

### TaskContext (inside a handler)

| API | Purpose |
|---|---|
| `ctx.step(name, fn)` | The checkpoint primitive. Cached-on-success. |
| `ctx.beginStep(name)` / `ctx.completeStep(handle, value)` | Split-form step for agent-style loops; `handle.done` means a cached value exists (`handle.state`). |
| `ctx.sleepFor(stepName, seconds)` / `ctx.sleepUntil(stepName, date)` | Durable suspension (survives restarts). |
| `ctx.awaitEvent(name, { stepName?, timeout? })` | Suspend until an event; throws `TimeoutError` on timeout. |
| `ctx.emitEvent(name, payload?)` | Emit on the current queue (first emit wins). |
| `ctx.awaitTaskResult(taskID, { queue, timeout?, stepName? })` | Durably await another task — **child must be on a different queue**. |
| `ctx.heartbeat(seconds?)` | Extend the lease during a long non-checkpointing stretch. |
| `ctx.taskID`, `ctx.headers` | Identity + spawn-time metadata. |

### Results, retries, cancellation

```ts
const snap  = await app.fetchTaskResult(taskID);              // snapshot | null
const final = await app.awaitTaskResult(taskID, { timeout: 30 }); // terminal state or TimeoutError

await app.retryTask(taskID, { spawnNewTask: false });  // re-drive in place, reusing checkpoints
await app.cancelTask(taskID);  // detected at the next step()/heartbeat()/awaitEvent()
```

Cancellation policies (`registerTask` or `spawn`): `maxDuration` (total
lifetime) and `maxDelay` (seconds since last checkpoint).

Retry semantics worth knowing: a task that **threw** retries per its strategy;
`retryTask` is for re-driving a task that exhausted attempts (this repo uses it
to resume interrupted jobs). A clean failure your domain considers terminal
should be a *returned* value, not a throw, if you don't want retries.

### Workers

```ts
const worker = await app.startWorker({
  concurrency: 4,        // parallel tasks (default 1)
  claimTimeout: 120,     // lease seconds
  pollInterval: 0.25,
});
// ... later
await worker.close();    // graceful; app.close() also stops it + owned pool
```

`app.workBatch()` exists for one-shot/cron processing; long-lived `startWorker`
is the norm here. `app.bindToConnection(client)` scopes operations to an
existing connection (e.g. spawn inside a transaction).

Hooks (`new Absurd({ hooks })`): `beforeSpawn` (mutate options/headers — trace
propagation) and `wrapTaskExecution` (wrap handler execution in context).

## How this repo uses Absurd

Read these before changing runtime behavior:

- `src/runtime/absurd/engine.ts` — boots **PGLite** (WASM Postgres, in-process)
  with the Absurd schema, exposed over a local socket so `absurd-sdk` (a
  node-postgres client) can connect. **PGLite is single-connection: `pool.max: 1`
  is mandatory**, and only unpartitioned queues work (no `pg_cron`). Details:
  `docs/pglite-wasm-postgres-database.md`.
- **Two queues, one pool**: the orchestrator task runs on `"default"` (`app`),
  per-job tasks on `"jobs"` (`jobsApp`, `JOBS_QUEUE`) — the cross-queue split
  that makes the orchestrator's await of its jobs deadlock-free
  (`docs/durable-orchestrator.md`).
- `src/runtime/absurd/runtime.ts` — each workflow **job** is a task
  (idempotency key `${runId}:${jobId}`), each step a `ctx.step` checkpoint;
  the whole DAG walk is itself a durable orchestrator task (idempotency key
  `runId`), which is what makes `work resume <id>` work end-to-end.
- Concept mapping (GitHub-Actions vocabulary → Absurd primitives):
  `docs/absurd-durable-workflows.md`.
