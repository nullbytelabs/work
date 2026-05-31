# Absurd Durable Workflows (TypeScript SDK) — Research Notes

Research for designing a GitHub-Actions-style workflow engine on top of **Absurd**
as the durable-execution backbone. Almost everything below is **verified against
the official docs AND the actual SDK source** (`sdks/typescript/src/index.ts`,
`@earendil-works/absurd` on GitHub). Anything I could not confirm is flagged
`UNVERIFIED — needs confirmation`.

## Sources

- TypeScript SDK reference: https://earendil-works.github.io/absurd/sdks/typescript/
- Concepts: https://earendil-works.github.io/absurd/concepts/
- Quickstart: https://earendil-works.github.io/absurd/quickstart/
- Working with Agents: https://earendil-works.github.io/absurd/agents/
- Patterns (Cron, Pi AI Agent, Living with code changes): https://earendil-works.github.io/absurd/patterns/
- GitHub repo: https://github.com/earendil-works/absurd
- README: https://github.com/earendil-works/absurd/blob/main/README.md
- SDK source (authoritative for signatures): https://github.com/earendil-works/absurd/blob/main/sdks/typescript/src/index.ts
- Examples: https://github.com/earendil-works/absurd/tree/main/sdks/typescript/examples
- License: Apache-2.0
- Announcement post: https://lucumr.pocoo.org/2025/11/3/absurd-workflows/ (Absurd is from the author of Flask/Jinja; "Earendil Inc.")

---

## 1. What Absurd Is (and the durability model)

Absurd is a **Postgres-native durable execution / durable workflow system**. Its
entire backing store is **PostgreSQL (14+)** and *nothing else* — there is no
coordinator service, broker, or separate scheduler. Workers **pull** tasks from
Postgres as they have capacity (no push, no HTTP callbacks).

The whole runtime is a single SQL file (`sql/absurd.sql`) of tables + stored
procedures applied to your database; the SDKs are thin clients that call those
stored functions over the `pg` (node-postgres) driver.

**Vocabulary (the core model):**

| Concept | Meaning |
| --- | --- |
| **Task** | Top-level unit of work. Has a name, JSON params, runs on a queue. Can run seconds → years. |
| **Step** | A checkpoint inside a task. Named. Once it completes, its JSON return value is persisted and never recomputed. |
| **Run** | One execution attempt of a task. Attempt 1, 2, 3… Runs share the same checkpoints. |
| **Queue** | A logical namespace. Each queue gets its own Postgres tables. Used to scale/isolate workloads. |
| **Worker** | Polls a queue, claims tasks with a time-limited lease, runs the handler. |
| **Event** | A named signal (optional JSON payload) a task can await; first emit per name wins (immutable, race-free). |
| **Checkpoint** | The persisted result of a step (the durability primitive). |

**How durability works (verified):** Absurd is *checkpoint/journaling* based, not
full deterministic replay of arbitrary code. When a task runs:

- Each `ctx.step(name, fn)` looks up whether a checkpoint with that name already
  exists in Postgres. If yes, it returns the cached value **without running `fn`**.
  If no, it runs `fn`, persists the JSON result as a checkpoint, and continues.
- On a crash/restart/retry, the task handler is **re-invoked from the top**.
  Completed steps are skipped (loaded from cache); the task continues from the
  first uncompleted step. This gives "exactly-once"-ish semantics *for steps*.
- **Code OUTSIDE of steps may run multiple times** across retries. All
  side-effects must live inside steps. (This is the key gotcha.)
- Retries are at the **task** level, not the step level. A failed run is marked
  failed; a new run is scheduled with backoff; it replays checkpoints and
  resumes.
- The worker's claim (lease) is **extended every time a checkpoint is written**
  (and via `ctx.heartbeat()`). If a worker dies before the lease expires, the
  task becomes claimable by another worker — so **brief overlapping execution is
  possible**; steps should tolerate it.

Per-queue Postgres tables (table-name prefixes, verified in Concepts):
`t_` tasks, `r_` runs, `c_` checkpoints, `e_` events, `w_` wait registrations,
plus `i_` (idempotency-key map) for partitioned queues.

---

## 2. Install / Init

```bash
# 1. Apply the schema to Postgres (CLI; uvx runs it without installing)
export PGDATABASE="postgresql://user:pass@localhost:5432/mydb"
absurdctl init            # or: uvx absurdctl init -d mydb
absurdctl create-queue default

# 2. Install the SDK
npm install absurd-sdk
```

```ts
import { Absurd } from "absurd-sdk";
```

Notes (verified):
- Package name is **`absurd-sdk`**. (The README also references the GitHub path,
  but npm install is `absurd-sdk`.)
- Modern Node can run `.ts` / `.mts` directly via native type stripping — no
  build step needed for examples.
- `absurdctl` is the CLI (init schema, migrate, create/drop/list queues,
  spawn/retry tasks, emit events, dump tasks/runs). Install via `uv tool install
  absurdctl`, `uvx absurdctl`, or a standalone binary from GitHub Releases.
- For production, fold `sql/absurd.sql` (and released migrations) into your own
  migration tooling; generate upgrade SQL with `absurdctl migrate --dump-sql`.

---

## 3. Creating a Client

```ts
import { Absurd } from "absurd-sdk";
import * as pg from "pg";

// From a connection string
const app = new Absurd({ db: "postgresql://user:pass@localhost:5432/mydb", queueName: "default" });

// From an existing pool (lets you share a pool / run in a transaction)
const pool = new pg.Pool({ connectionString: "..." });
const app2 = new Absurd({ db: pool, queueName: "default" });

// Minimal: db resolves from ABSURD_DATABASE_URL -> PGDATABASE -> postgresql://localhost/absurd
//          queueName defaults to "default"
const app3 = new Absurd();
```

`AbsurdOptions` (verified from source):

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `db` | `pg.Pool \| string` | env fallbacks above | connection string or pool |
| `queueName` | `string` | `"default"` | default queue |
| `defaultMaxAttempts` | `number` | `5` | default retry limit |
| `log` | `Log` (`log/info/warn/error`) | `console` | logger |
| `hooks` | `AbsurdHooks` | — | `beforeSpawn`, `wrapTaskExecution` |

---

## 4. Defining (registering) a Task

A **task** is the closest thing Absurd has to a "workflow definition." It is a
named handler `(params, ctx) => Promise<result>`.

```ts
app.registerTask<ProvisionUserParams>(
  {
    name: "provision-user",       // required; must match when spawning
    queue: "default",             // optional; defaults to client queue
    defaultMaxAttempts: 5,        // optional
    defaultCancellation: { maxDuration: 120, maxDelay: 60 }, // optional
  },
  async (params, ctx) => {
    const user = await ctx.step("create-user-record", async () => {
      return { user_id: params.user_id, email: params.email };
    });

    const delivery = await ctx.step("send-activation-email", async () => {
      return { sent: true, to: user.email };
    });

    // Suspend durably until an external event arrives (or 1h timeout)
    const activation = await ctx.awaitEvent(`user-activated:${user.user_id}`, { timeout: 3600 });

    return { ...user, delivery, status: "active", activatedAt: activation.activated_at };
  },
);
```

Signature (verified): `registerTask<P, R>(options: TaskRegistrationOptions, handler: TaskHandler<P, R>): void`.

`TaskRegistrationOptions`: `{ name: string; queue?: string; defaultMaxAttempts?: number; defaultCancellation?: CancellationPolicy }`.

`TaskHandler<P, R> = (params: P, ctx: TaskContext) => Promise<R>`.

> There is no separate "workflow" vs "activity" type as in Temporal. The unit is
> the **task**; **steps** are the durable activities inside it. Child workflows
> are just other tasks you `spawn`.

---

## 5. Defining a Step / Activity

```ts
// Simple form — run once, cache result
const result = await ctx.step("fetch-data", async () => {
  return { ok: true, source: "demo" };   // MUST be JSON-serializable
});

// Two-phase form (begin/complete) — useful for agent/event loops with
// separate before/after hooks, or to checkpoint a value BEFORE an action.
const handle = await ctx.beginStep<{ messages: string[] }>("agent-turn");
if (handle.done) {
  // handle.state is the cached checkpoint value
  return handle.state;
}
const state = { messages: ["hello"] };
await ctx.completeStep(handle, state);
```

Signatures (verified):
- `ctx.step<T>(name: string, fn: () => Promise<T>): Promise<T>`
- `ctx.beginStep<T>(name: string): Promise<StepHandle<T>>`
- `ctx.completeStep<T>(handle: StepHandle<T>, value: T): Promise<T>`

`StepHandle<T>` is a discriminated union on `done`:
```ts
type StepHandle<T> = { readonly name: string; readonly checkpointName: string } &
  ({ done: false; state?: never } | { done: true; state: T });
```

**Automatic step numbering (verified, IMPORTANT for fan-out/matrix):** if you
call `ctx.step("x", …)` more than once with the same name, Absurd auto-suffixes
the checkpoint: `x`, `x#2`, `x#3`, … The numbering is **call-order based** within
a run (an internal per-name counter). So duplicate step names are allowed, but
the ordering must be deterministic across replays. `handle.checkpointName`
exposes the concrete key. **Implication:** for matrix/parallel steps, give each
expansion a unique, deterministic step name (e.g. include the matrix key) rather
than relying on call-order numbering.

---

## 6. Spawning & Running Tasks

```ts
const { taskID, runID, attempt, created } = await app.spawn(
  "send-email",
  { to: "user@example.com", template: "welcome" },
  {
    maxAttempts: 10,
    retryStrategy: { kind: "exponential", baseSeconds: 2, factor: 2, maxSeconds: 300 },
    headers: { traceId: "..." },
    idempotencyKey: "welcome:user-42",
    cancellation: { maxDuration: 600 },
    queue: "default",   // required if the task is NOT registered in this process
  },
);
```

Signature (verified): `spawn<P>(taskName: string, params: P, options?: SpawnOptions): Promise<SpawnResult>`.

`SpawnOptions`: `{ maxAttempts?; retryStrategy?; headers?; queue?; cancellation?; idempotencyKey? }`.

`SpawnResult`: `{ taskID: string; runID: string; attempt: number; created: boolean }`
(`created: false` means an existing task was returned via idempotency).

**Safety rule (verified):** if `taskName` is **not registered in the current
process**, `spawn()` *requires* `options.queue` (it throws otherwise) — to avoid
silently routing unknown tasks. In that case the registration-level defaults
aren't available, so retry/cancellation come from explicit spawn options or
client defaults.

### Starting a worker

```ts
const worker = await app.startWorker({
  concurrency: 4,          // parallel tasks in-process (default 1)
  claimTimeout: 120,       // lease seconds (default 120)
  batchSize: 4,            // tasks claimed per poll (default: concurrency)
  pollInterval: 0.25,      // idle poll seconds (default 0.25)
  workerId: "web-1",       // default hostname:pid
  fatalOnLeaseTimeout: true,
  onError: (err) => console.error(err),
});
await worker.close();      // graceful shutdown
```

`WorkerOptions` (verified): `{ workerId?; claimTimeout?; batchSize?; concurrency?; pollInterval?; onError?; fatalOnLeaseTimeout? }`.

### Single-batch (cron / serverless) processing

```ts
await app.workBatch("worker-1", 120 /* claimTimeout */, 10 /* batchSize */);
```

---

## 7. Inputs / Outputs / State Passing

- **Into a workflow:** the second arg to `spawn()` — any JSON-serializable
  `params`, delivered as the handler's first arg.
- **Between steps:** ordinary JS variables in the handler closure. The catch:
  only values returned *from a step* are durable. On replay, code outside steps
  re-runs, so derive everything important from step return values (which are
  cached) — exactly like the Quickstart, where `user` (a step result) is reused
  by later steps.
- **Out of a workflow:** the handler's return value becomes the task result.
  Read it with `app.fetchTaskResult(taskID)` (snapshot or `null`) or
  `app.awaitTaskResult(taskID, { timeout })` (blocks until terminal; throws
  `TimeoutError`).
- **Metadata / config:** `headers` (a `JsonObject`) ride along with the task and
  are readable as `ctx.headers` (read-only). Good for trace IDs / correlation.
  Env/secrets are *not* part of Absurd — read them from `process.env` inside
  steps as usual.

`TaskResultSnapshot` (verified):
```ts
type TaskResultState = "pending" | "running" | "sleeping" | "completed" | "failed" | "cancelled";
type TaskResultSnapshot =
  | { state: "pending" | "running" | "sleeping" }
  | { state: "completed"; result: JsonValue | null }
  | { state: "failed";    failure: JsonValue | null }
  | { state: "cancelled" };
```

---

## 8. Sequential, Parallel, Fan-out / Join, Child Workflows, Dependencies

This is the part most relevant to a GitHub-Actions engine, so it's spelled out
carefully. **Key finding: Absurd has NO built-in `parallel()` / `Promise.all`
fan-out primitive over steps, and no first-class "child workflow" join API
beyond `awaitTaskResult`.** Concurrency comes from (a) worker `concurrency`, and
(b) spawning multiple tasks. You compose the rest yourself.

### 8.1 Sequential steps (native)
Just `await` steps in order — this is the default model:
```ts
const a = await ctx.step("a", () => doA());
const b = await ctx.step("b", () => doB(a));   // depends on a
```

### 8.2 Parallel work — two real options

**Option A — in-process parallelism inside a single step (verified pattern).**
The official agent-loop example runs tool calls concurrently with
`Promise.all(...)` *inside one `ctx.step`*, then checkpoints the combined result.
This is fine when the work is short and you want a single checkpoint:
```ts
const results = await ctx.step("fan-out", async () => {
  return await Promise.all(items.map((it) => doWork(it)));
});
```
Caveat: the whole step is one checkpoint, so a crash mid-way re-runs *all* the
parallel work. No independent retry/durability per branch.

**Option B — fan-out by spawning child tasks (verified pattern; recommended for
true durable parallelism).** Spawn N child tasks, then converge. Each child is an
independently durable, retryable task:
```ts
// Parent task handler
app.registerTask({ name: "matrix-parent", queue: "default" }, async (params, ctx) => {
  // Fan out: spawn one child per matrix cell (do it inside a step so it only
  // happens once even across replays).
  const children = await ctx.step("spawn-children", async () => {
    const out = [];
    for (const cell of params.cells) {
      const { taskID } = await app.spawn(
        "matrix-child",
        { cell },
        { queue: "workers", idempotencyKey: `${ctx.taskID}:${cell.id}` },
      );
      out.push(taskID);
    }
    return out;   // checkpointed list of child task IDs
  });

  // Join / converge: await each child's terminal result.
  // NOTE: children MUST be on a DIFFERENT queue than the parent (see below).
  const results = [];
  for (const taskID of children) {
    const res = await ctx.awaitTaskResult(taskID, { queue: "workers", timeout: 600 });
    results.push(res);
  }
  return { results };
});
```

### 8.3 Join / convergence
- `ctx.awaitTaskResult(taskID, { queue, timeout?, stepName? })` — **durably**
  wait for another task's terminal result from inside a running task. The wait is
  itself checkpointed (default step name `$awaitTaskResult:<taskID>`).
  **Hard constraint (verified in source):** `options.queue` MUST be a *different*
  queue than the parent's, or it throws — waiting on the same queue can deadlock
  the worker pool (the parent occupies a worker slot while children need slots on
  the same queue). So fan-out children belong on a dedicated queue.
- Alternative join via **events**: a child does `app.emitEvent("done:<id>", …)`
  and the parent does `ctx.awaitEvent("done:<id>")`. The provisioning example
  uses exactly this (a child "activation-simulator" task emits an event the
  parent awaits). Events are immutable/first-emit-wins, so this is race-free, and
  parent+children can share a queue with this approach.

### 8.4 Child workflows / dependencies
- A "child workflow" = another registered task you `spawn`. There is no special
  child-workflow type; parent↔child linkage is whatever you build (IDs returned
  from `spawn`, awaited via `awaitTaskResult`, or events).
- "Needs" / dependencies = ordering enforced by your code: run dependency steps
  first, or await the upstream task/event before proceeding.

### 8.5 Built-in suspend primitives (verified)
- `ctx.sleepFor(stepName, seconds)` — durable sleep for a duration.
- `ctx.sleepUntil(stepName, date)` — durable sleep until an absolute time.
- `ctx.awaitEvent(eventName, { stepName?, timeout? })` — suspend until event; returns payload; throws `TimeoutError` on timeout.
- `ctx.awaitTaskResult(...)` — see 8.3.
- `ctx.heartbeat(seconds?)` — extend the lease during long steps.
- `ctx.emitEvent(name, payload?)` / `app.emitEvent(name, payload?, queue?)` — emit events (first-emit-wins).

> There is **no** `ctx.parallel([...])`, `ctx.all(...)`, `ctx.race(...)`, or
> matrix/expansion construct in the SDK. CONFIRMED 2026-05-31: cross-checked the
> full single-file SDK source (`sdks/typescript/src/index.ts`) AND the official
> [Concepts page](https://earendil-works.github.io/absurd/concepts/), which
> enumerates the complete `ctx.*` surface (`step`, `beginStep`/`completeStep`,
> `sleepFor`/`sleepUntil`, `awaitEvent`, `awaitTaskResult`, `heartbeat`,
> `emitEvent`) — none is a parallel/matrix primitive. Concurrency comes only from
> worker `concurrency` + spawning child tasks. Treat this as settled, not open.

---

## 9. Retries & Idempotency (verified)

- Retries are configured at spawn (or task registration defaults). `RetryStrategy`:
  ```ts
  { kind: "fixed" | "exponential" | "none"; baseSeconds?; factor?; maxSeconds? }
  ```
  - `fixed`: wait `baseSeconds` between retries.
  - `exponential`: wait `baseSeconds * factor^attempt`, capped at `maxSeconds`.
  - `none`: no automatic retries.
- `maxAttempts` (default 5 from client) bounds total attempts.
- On failure the whole task retries; completed steps are NOT re-run (loaded from
  checkpoints).
- **Two idempotency mechanisms:**
  1. **Spawn-time dedup** — `idempotencyKey` on `spawn()`. If a task with the
     same key already exists on the queue, the existing one is returned
     (`created: false`). Great for "enqueue this job at most once."
  2. **External idempotency inside a step** — derive a stable key from
     `ctx.taskID` (e.g. `` `${ctx.taskID}:payment` ``) and pass it to external
     APIs (Stripe etc.), since code around steps can re-run.
- **Manual retry of a failed task:**
  ```ts
  await app.retryTask(taskID, { maxAttempts: 5, spawnNewTask: false /* retry in place */ });
  ```

Example (retry on transient failure, replays checkpoints):
```ts
app.registerTask({ name: "charge", defaultMaxAttempts: 5 }, async (params, ctx) => {
  const customer = await ctx.step("load-customer", () => loadCustomer(params.id)); // cached on retry
  const charge = await ctx.step("charge-card", async () => {
    return await stripe.charges.create(
      { amount: params.amount },
      { idempotencyKey: `${ctx.taskID}:charge` },  // stable across attempts
    );
  });
  return { charge };
});

await app.spawn("charge", { id: "c1", amount: 9999 }, {
  maxAttempts: 6,
  retryStrategy: { kind: "exponential", baseSeconds: 1, factor: 2, maxSeconds: 120 },
});
```

---

## 10. Cancellation, Timeouts, Scheduling, Events/Signals (verified)

- **Cancellation:** `app.cancelTask(taskID, queueName?)`. Running tasks notice at
  the next `step()`, `heartbeat()`, or `awaitEvent()` and stop gracefully.
- **Cancellation policies** (set at spawn or task registration via
  `CancellationPolicy`):
  - `maxDuration` — cancel if alive longer than N seconds total.
  - `maxDelay` — cancel if no checkpoint written for N seconds (stuck/stalled).
- **Timeouts:** per-wait via `awaitEvent({ timeout })` / `awaitTaskResult({ timeout })`
  (throw `TimeoutError`). There is no single "task timeout" knob other than
  `maxDuration`.
- **Scheduling / sleep:** `sleepFor` / `sleepUntil` suspend and schedule a future
  run. For cron, the docs recommend spawning with a deterministic
  `idempotencyKey` derived from the time window (see the Cron Jobs pattern) plus
  `pg_cron` to trigger.
- **Events/signals:** `emitEvent` / `awaitEvent`. Immutable per name (first emit
  wins) → safe even if the emitter races the awaiter. Events are per-queue.

`CancellationPolicy`: `{ maxDuration?: number; maxDelay?: number }`.

---

## 11. Other APIs worth knowing (verified)

- **Queue management:** `createQueue(name?, opts?)`, `dropQueue(name?)`,
  `listQueues()`, `setQueuePolicy(name, opts)`, `getQueuePolicy(name)`. Queues can
  be `unpartitioned` (default) or `partitioned` (adds idempotency-key table +
  partition lifecycle for retention at scale).
- **`bindToConnection(client)`** — run Absurd ops on a specific pg connection
  (e.g. inside your own transaction): spawn a task atomically with a DB write.
- **Hooks:** `beforeSpawn(taskName, params, options) => options` (inject headers /
  trace IDs); `wrapTaskExecution(ctx, execute) => execute()` (restore context,
  e.g. AsyncLocalStorage, around the handler).
- **Error types:** `SuspendTask`, `CancelledTask`, `FailedTask` are internal
  (never surface to user code). `TimeoutError` is the only one you catch.
- **Closing:** `await app.close()` (stops worker, closes pool if owned).
- **Agent tooling:** `absurdctl install-skill` installs a bundled "absurd" skill
  for coding agents (Claude Code / pi) that steers them to inspect queue/task
  state via `absurdctl` (list-queues, list-tasks, dump-task, retry, emit-event).

### Relevant TypeScript types (verified, copy-paste ready)
```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface RetryStrategy { kind: "fixed" | "exponential" | "none"; baseSeconds?: number; factor?: number; maxSeconds?: number; }
interface CancellationPolicy { maxDuration?: number; maxDelay?: number; }
interface SpawnOptions { maxAttempts?: number; retryStrategy?: RetryStrategy; headers?: JsonObject; queue?: string; cancellation?: CancellationPolicy; idempotencyKey?: string; }
interface SpawnResult { taskID: string; runID: string; attempt: number; created: boolean; }
interface TaskRegistrationOptions { name: string; queue?: string; defaultMaxAttempts?: number; defaultCancellation?: CancellationPolicy; }
type TaskHandler<P = any, R = any> = (params: P, ctx: TaskContext) => Promise<R>;
interface WorkerOptions { workerId?: string; claimTimeout?: number; batchSize?: number; concurrency?: number; pollInterval?: number; onError?: (e: Error) => void; fatalOnLeaseTimeout?: boolean; }
type StepHandle<T = JsonValue> = { readonly name: string; readonly checkpointName: string } &
  ({ done: false; state?: never } | { done: true; state: T });
```

---

## 12. Mapping GitHub-Actions YAML → Absurd primitives

This is a concrete proposal, not something Absurd ships. Each row gives the
recommended Absurd construct.

| GHA concept | Maps to (Absurd) | Notes / rationale |
| --- | --- | --- |
| **`workflow`** (whole file) | One **root task** (`registerTask`) that orchestrates, **or** a thin orchestrator that spawns per-job tasks. | A workflow run = one `spawn(rootTask, { inputs })`. The root handler encodes the job DAG. |
| **workflow `inputs` / `env`** | `spawn()` **params** (typed JSON) + `headers` for cross-cutting metadata (run ID, trace ID). | Secrets/`env` read from `process.env` inside steps, not stored in Absurd. |
| **`job`** | A **step** in the root task **for simple/sequential jobs**, OR a **child task** (`spawn` + `awaitTaskResult`) **for jobs that must run/retry/scale independently or in parallel**. | Child-task-per-job gives independent durability + parallelism; step-per-job is lighter. See `needs`/parallel rows. |
| **`step`** (within a job) | `ctx.step("<job>/<step-id>", fn)` | Step name should be stable & unique (use job id + step id). The step `fn` is your executor (run command / script / program / agent — see §13). |
| **sequential steps** (default order) | `await` steps in order in the handler. | Native; this is Absurd's default model. |
| **`needs:` (job dependency / DAG)** | Run upstream first; for child-task jobs, `await ctx.awaitTaskResult(upstreamTaskID, { queue: "jobs" })` before spawning/continuing downstream. | Build a topological order from `needs`; await all predecessors before a job. Pass upstream outputs forward (see outputs row). |
| **parallel jobs / parallel steps** (independent `needs`) | **Fan-out by spawning child tasks** on a dedicated queue, then converge with `awaitTaskResult`/events. For short in-job parallelism, `Promise.all` inside one step. | Worker `concurrency` and multiple workers provide the actual parallelism. No built-in `parallel()` primitive — you orchestrate. |
| **`strategy.matrix`** | Programmatic **fan-out**: expand the matrix in JS, then `spawn` one child task per cell (give each a deterministic `idempotencyKey = \`${ctx.taskID}:${cellKey}\``), then `awaitTaskResult` each. | Matrix expansion is your code. The idempotency key makes re-spawns on replay safe. Use unique step/task names per cell (avoid relying on `#2` auto-numbering). |
| **`matrix` `max-parallel`** | Cap fan-out yourself (batch spawns) and/or set worker `concurrency` / a dedicated queue. | CONFIRMED — no native per-spawn-group concurrency cap (full SDK source + Concepts reviewed); enforce in orchestration code. |
| **convergence / "join" after fan-out** | Loop `await ctx.awaitTaskResult(childID, { queue, timeout })` over child IDs, OR await a `done:<id>` event per child. | The await is itself checkpointed, so the join survives crashes. |
| **`if:` / `when:` conditionals** | Plain `if` in the handler around the `ctx.step(...)` call — skip the step (don't call it) when the condition is false. | Evaluate the condition from prior step outputs (which are durable). Optionally record a `{ skipped: true }` checkpoint for observability. |
| **step `outputs` / passing data** | Step return values (cached JSON). For cross-task (job→job) outputs, the child's **task result** (`awaitTaskResult().result`) or an **emitted event payload**. | Within a task: closure variables fed from step returns. Across tasks: result snapshot or event. |
| **`continue-on-error`** | `try/catch` around the step; record outcome and proceed. Or for child-task jobs, inspect `awaitTaskResult` → `{ state: "failed" }` and decide. | Don't rethrow if you want the workflow to continue. |
| **retries** (GHA has limited native retry) | `spawn` `maxAttempts` + `retryStrategy` per job-as-task, or wrap a step's body with your own retry-in-step logic. | Task-level retries replay checkpoints. |
| **`timeout-minutes`** | `awaitEvent`/`awaitTaskResult` `timeout`, plus `cancellation.maxDuration` at spawn. | `maxDuration` is the closest to a hard job timeout. |
| **scheduled (`on: schedule` / cron)** | External `pg_cron` (or your scheduler) calls `spawn` with a deterministic `idempotencyKey` per time window. | See the Cron Jobs pattern; Absurd dedups duplicate triggers. |
| **manual cancel** | `app.cancelTask(taskID)` (root) — cascade to children in orchestration code. | Children detect cancellation at next checkpoint; cancel them explicitly too. |
| **concurrency groups** | CONFIRMED — no native "concurrency group/cancel-in-progress" (full SDK source + Concepts reviewed). Emulate with `idempotencyKey` (dedup) + cancel-previous logic in your orchestrator. | Design decision, not a verification gap. |

### Recommended architecture sketch

- **One queue per "tier"**: e.g. `orchestrator` queue for root workflow tasks and
  a separate `jobs` queue for job/matrix child tasks. This satisfies Absurd's
  rule that `awaitTaskResult` must target a *different* queue, and prevents
  fan-out deadlocks.
- **Root/orchestrator task** = compiled from the YAML: it holds the job DAG,
  resolves `needs` ordering, evaluates `if`, expands `matrix`, fans out child
  tasks, and joins their results.
- **Each job (or matrix cell) = a child task** with its own steps. A job's
  internal steps map 1:1 to GHA steps.
- **Step executor**: the body of each `ctx.step` dispatches on task kind (command
  / script / program / agent) — see §13.
- **Determinism requirement**: the orchestrator's control flow (which steps it
  calls, in what order, with what names) must be deterministic across replays,
  because code outside steps re-runs. Compute matrix expansion / DAG order inside
  a step and checkpoint it, then iterate over the cached result.

---

## 13. Mapping step "task kinds" to step bodies

A GHA step's `run`/`uses` becomes the function passed to `ctx.step`. All of these
are just normal async code *inside a step* (so they're checkpointed once and not
re-run on retry):

```ts
// linux command / shell script / run a program
await ctx.step(`${jobId}/run-build`, async () => {
  const { stdout, stderr, exitCode } = await execProgram("bash", ["-lc", step.run]);
  if (exitCode !== 0) throw new Error(`step failed: ${stderr}`); // -> task retries
  return { stdout, exitCode };
});

// agentic step (calling an agent) — see the official agent-loop example.
// `agentStep` here is the resolved agent package (system prompt + tools + model
// default), not inline `with.prompt` — see docs/agent-uses-interface.md.
await ctx.step(`${jobId}/agent`, async () => {
  const result = await runAgent({ agent: agentStep, inputs: step.with });
  return { output: result.text };   // becomes the step's memoized output
});
```

Notes:
- The agent-loop example checkpoints each agent turn via `ctx.step("agent-loop", …)`
  inside a `while` loop — durable agent loops are an explicitly supported use
  case (and there's a dedicated "Pi AI Agent" pattern page).
- Long-running commands should call `ctx.heartbeat()` periodically (or be split
  into smaller steps) so the lease doesn't expire mid-run.
- Capturing large stdout into a checkpoint is fine but it's stored as JSON in
  Postgres — for big artifacts, store externally and checkpoint a reference.

---

## 14. Open items to confirm before building

- ~~no native `max-parallel` / concurrency-group~~ — RESOLVED (confirmed absent via
  full SDK source + Concepts); must be emulated in the orchestrator. Not an open
  question, just a design constraint.
- **replay/determinism contract** — RESOLVED in principle: the
  [Concepts page](https://earendil-works.github.io/absurd/concepts/) documents it
  explicitly — "Code **outside** steps may execute multiple times across retries.
  Keep side-effects inside steps"; retries are task-level and replay completed
  checkpoints. The *contract* is settled (keep orchestration decisions inside
  checkpointed steps). What remains is purely an **engineering validation**: a
  small prototype to observe fan-out/join behavior under induced crashes — not a
  doc-verification gap.
- **`awaitTaskResult` polling overhead at high fan-out** — genuinely open
  (runtime/perf characteristic, not documented). It polls with backoff +
  heartbeats per the source; for very wide matrices an event-based join (one event
  per child) may scale better. Confirm by benchmarking.
- Verify partitioned-queue setup + `pg_cron` if you need retention at scale
  (Storage / Cleanup docs).
