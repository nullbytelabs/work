# PGMQ (Postgres Message Queue) — Reference & work Context

> **⚠️ OUT OF SCOPE — not used by work.** PGMQ's one unique value here was
> coordinating a **fleet of separate runner machines** (work-stealing dispatch for
> `runs-on`). The engine targets a **single host**, so that need doesn't exist, and
> everything else PGMQ was considered for is covered by Absurd natively (events for
> signals/cancellation, task results, retries/failed-task state, durable sleeps for
> scheduling). This doc is **retained for reference only**, in case a multi-machine
> topology is ever wanted. Parallelism on one host comes from Absurd worker
> `concurrency` + fan-out child tasks — not a message bus.

> Two halves: **Part A** is a verified general reference on PGMQ setup/usage. **Part B** is how PGMQ *would* fit alongside Absurd in a multi-machine deployment. Items that couldn't be confirmed from docs/source are flagged **UNVERIFIED — needs confirmation**.

---

# Part A — PGMQ general reference

## 1. What PGMQ is

PGMQ is a lightweight message queue **implemented entirely inside PostgreSQL** — "Like AWS SQS and RSMQ but on Postgres." It is just a set of SQL objects (tables, types, functions) in a `pgmq` schema; there is **no background worker and no external dependencies** (except `pg_partman`, and only for partitioned queues). It provides SQS/RSMQ-like semantics: visibility timeouts, message archiving, batch operations, long-polling, and (newer) FIFO message groups and topic routing.

- **Source / maintainer:** Created by **Tembo** (`tembo-io`); now lives at **github.com/pgmq/pgmq**. Tembo and Supabase are the primary backers/users.
- **License:** PostgreSQL License — SPDX `PostgreSQL`, © 2023 Tembo. CONFIRMED 2026-05-31 against the repo [LICENSE](https://github.com/pgmq/pgmq/blob/main/LICENSE).
- **Current version:** Docker images published as `ghcr.io/pgmq/pg18-pgmq:v1.10.0` (**v1.10.x** current as of this research, 2026). A `v2.0` is referenced as future — several functions are marked deprecated "will be removed in PGMQ v2.0".
- **Supported Postgres:** **14–18** (prose authoritative; a badge also shows 13–18).

## 2. Key semantics

- **Visibility timeout (`vt`):** On read, a message becomes invisible to other consumers for `vt` seconds. If not deleted/archived within `vt`, it becomes visible again and can be re-delivered. Set `vt` > expected processing time.
- **Delivery — at-least-once.** The docs market "exactly once delivery **within a visibility timeout**", which is precise but easy to misread. In practice it is **at-least-once**: within one `vt` window only one consumer gets a message (via `FOR UPDATE SKIP LOCKED`), but exceeding `vt` or crashing before delete causes redelivery. No global exactly-once — **design idempotent consumers**. `pop()` is **at-most-once** (read+delete in one shot; a crash after pop loses the message).
- **`read_ct`:** Each `read()` increments it. High `read_ct` = a message that keeps failing — use it for poison-pill detection / dead-lettering.
- **Concurrency:** `read()` uses `FOR UPDATE SKIP LOCKED`, so many workers read the same queue concurrently with no double-delivery within `vt` and minimal contention.
- **Ordering:** Plain queues are roughly FIFO by `msg_id` but **not guaranteed** under concurrent consumers / redelivery. For strict ordering use **FIFO message groups** (`x-pgmq-group` header + `read_grouped*` functions).
- Messages persist until explicitly `delete()`d or `archive()`d.

## 3. Storage model (verified DDL)

Each queue is its own table.

**Meta table** (one row per queue):
```sql
CREATE TABLE pgmq.meta (
    queue_name     VARCHAR UNIQUE NOT NULL,
    is_partitioned BOOLEAN NOT NULL,
    is_unlogged    BOOLEAN NOT NULL,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
```

**Queue table `pgmq.q_<name>`:**
```sql
CREATE TABLE pgmq.q_<name> (
    msg_id       BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    read_ct      INT DEFAULT 0 NOT NULL,
    enqueued_at  TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    last_read_at TIMESTAMP WITH TIME ZONE,
    vt           TIMESTAMP WITH TIME ZONE NOT NULL,
    message      JSONB,
    headers      JSONB
);
CREATE INDEX q_<name>_vt_idx ON pgmq.q_<name> (vt ASC);
```
(`create_unlogged` is identical but `CREATE UNLOGGED TABLE`.)

**Archive table `pgmq.a_<name>`:** same columns plus `archived_at TIMESTAMPTZ`, indexed on `(archived_at)`.

**`pgmq.message_record`** (row shape from read/pop/set_vt): `msg_id bigint, read_ct int, enqueued_at timestamptz, last_read_at timestamptz, vt timestamptz, message jsonb, headers jsonb`.

**`pgmq.metrics_result`:** `queue_name, queue_length bigint, newest_msg_age_sec int, oldest_msg_age_sec int, total_messages bigint, scrape_time timestamptz, queue_visible_length bigint`.

## 4. Installation

**Docker (pre-installed, fastest):**
```bash
docker run -d --name pgmq-postgres -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 ghcr.io/pgmq/pg18-pgmq:v1.10.0
psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE EXTENSION pgmq;"
```

**As an extension** (needs filesystem access): PGXN (`pgxn install pgmq`) or from source (`make && make install`), then `CREATE EXTENSION pgmq;`. Verify `\dx pgmq`; upgrade `ALTER EXTENSION pgmq UPDATE;`.

**SQL-only** (no superuser/filesystem — works on most managed Postgres):
```bash
git clone https://github.com/pgmq/pgmq.git && cd pgmq
psql -f pgmq-extension/sql/pgmq.sql <CONNSTRING>
```
Plain SQL-only is **unversioned** (no upgrade path); a versioned SQL-only install is offered via the Rust client/CLI.

**Managed / no-superuser:** SQL-only is "compatible with most managed services"; extension install is "limited" on managed clouds. *(UNVERIFIED which providers ship it one-click besides Supabase.)*

**Supabase ships it.** Supabase Queues is built on `pgmq` (Dashboard → Integrations → Queues; Postgres 15.6.1.143+). Can expose a `pgmq_public` PostgREST schema; with the Data API on, enable RLS on all `pgmq.q_*` tables.

**Tembo Cloud:** ships `pgmq` in its stacks. *(UNVERIFIED current product status.)*

## 5. Core SQL API — verified signatures

All in schema `pgmq`.

**Send**
```sql
pgmq.send(queue_name text, msg jsonb)                                  RETURNS SETOF bigint
pgmq.send(queue_name text, msg jsonb, headers jsonb)
pgmq.send(queue_name text, msg jsonb, delay integer)        -- delay seconds
pgmq.send(queue_name text, msg jsonb, delay timestamptz)    -- visible at timestamp
pgmq.send(queue_name text, msg jsonb, headers jsonb, delay integer)
pgmq.send_batch(queue_name text, msgs jsonb[] [, headers jsonb[]] [, delay integer|timestamptz])
                                                                       RETURNS SETOF bigint
```

**Read**
```sql
pgmq.read(queue_name text, vt integer, qty integer, conditional jsonb DEFAULT '{}')
    RETURNS SETOF pgmq.message_record
pgmq.read_with_poll(queue_name text, vt integer, qty integer,
    max_poll_seconds integer DEFAULT 5, poll_interval_ms integer DEFAULT 100,
    conditional jsonb DEFAULT '{}')                  -- long-poll
    RETURNS SETOF pgmq.message_record
pgmq.pop(queue_name text, qty integer DEFAULT 1)     -- read AND delete (at-most-once)
    RETURNS SETOF pgmq.message_record
```
(FIFO variants: `read_grouped`, `read_grouped_with_poll`, `read_grouped_rr`, `read_grouped_rr_with_poll`.)

**Delete / Archive / Purge**
```sql
pgmq.delete(queue_name text, msg_id bigint)        RETURNS boolean
pgmq.delete(queue_name text, msg_ids bigint[])     RETURNS SETOF bigint
pgmq.archive(queue_name text, msg_id bigint)       RETURNS boolean   -- moves row to a_<name>
pgmq.archive(queue_name text, msg_ids bigint[])    RETURNS SETOF bigint
pgmq.purge_queue(queue_name text)                  RETURNS bigint
```

**Visibility timeout**
```sql
pgmq.set_vt(queue_name text, msg_id bigint,  vt integer|timestamptz)  RETURNS SETOF pgmq.message_record
pgmq.set_vt(queue_name text, msg_ids bigint[], vt integer|timestamptz)
```

**Queue management**
```sql
pgmq.create(queue_name text)                    -- name max 47 chars
pgmq.create_non_partitioned(queue_name text)    -- explicit alias of create()
pgmq.create_unlogged(queue_name text)
pgmq.create_partitioned(queue_name text,
    partition_interval text DEFAULT '10000',
    retention_interval text DEFAULT '100000')   -- requires pg_partman
pgmq.drop_queue(queue_name text)                RETURNS boolean
```

**Utilities**
```sql
pgmq.list_queues()              RETURNS SETOF pgmq.queue_record
pgmq.metrics(queue_name text)   RETURNS pgmq.metrics_result
pgmq.metrics_all()              RETURNS SETOF pgmq.metrics_result
pgmq.enable_notify_insert(queue_name text, throttle_interval_ms integer DEFAULT 250)
pgmq.create_fifo_index(queue_name text)
```
(`drop_queue(name, partitioned bool)` and `detach_archive` are deprecated → removed in v2.0.)

## 6. Partitioned vs unlogged vs plain

- **Partitioned** (`create_partitioned`): for retention + high throughput. **Requires `pg_partman`**, which manages partition lifecycle. `partition_interval` is numeric (partition by `msg_id`, e.g. `'10000'`) or a duration (partition by `enqueued_at`, e.g. `'1 day'`); `retention_interval` (same format) drops old partitions automatically. Retention does **not** resurrect `delete()`d or `archive()`d messages — it only prunes still-queued partitions. Needs `pg_partman_bgw` in `shared_preload_libraries`. Dropping a partition is far cheaper than bulk `DELETE`. *(UNVERIFIED minimum pg_partman version.)*
- **Unlogged** (`create_unlogged`): UNLOGGED table — writes skip WAL (higher throughput) but **data lost on crash/unclean shutdown**, not replicated. For ephemeral/best-effort work where loss is acceptable.
- **Plain** (`create`): logged, durable, single table — the default.

## 7. Client libraries

- **Official:** Rust (`pgmq-rs`, + CLI + versioned SQL installer) and **Python** (`github.com/pgmq/pgmq-py`, psycopg3). *(Legacy PyPI name `tembo-pgmq-python` predates the rename — verify current distribution name.)*
- **No official TypeScript/Node client.** Use community libs (`pgmq-js`, `prisma-pgmq`, `deno-pgmq`, …) or — simplest and most future-proof — call the SQL functions directly via `pg` / `postgres.js`.

## 8. Node / TypeScript usage (raw SQL via `pg`)

```ts
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const QUEUE = "my_queue";
const VT_SECONDS = 30;   // > expected processing time
const BATCH = 5;

async function setup() {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgmq;");
  await pool.query("SELECT pgmq.create($1);", [QUEUE]);
}

async function send(payload: unknown, delaySeconds = 0): Promise<bigint> {
  const { rows } = await pool.query<{ send: string }>(
    "SELECT pgmq.send($1, $2::jsonb, $3) AS send;",
    [QUEUE, JSON.stringify(payload), delaySeconds]
  );
  return BigInt(rows[0].send);
}

interface MessageRecord {
  msg_id: string;          // bigint -> string in node-pg
  read_ct: number;
  enqueued_at: string;
  last_read_at: string | null;
  vt: string;
  message: unknown;        // jsonb auto-parsed
  headers: unknown | null;
}

async function consumeOnce() {
  const { rows } = await pool.query<MessageRecord>(
    "SELECT * FROM pgmq.read($1, $2, $3);", [QUEUE, VT_SECONDS, BATCH]
  );
  for (const msg of rows) {
    try {
      // ...work with msg.message...
      // extend the lease if work runs long:
      //   await pool.query("SELECT pgmq.set_vt($1,$2,$3);", [QUEUE, msg.msg_id, 60]);
      await pool.query("SELECT pgmq.delete($1, $2);", [QUEUE, msg.msg_id]);   // success
      // or: pgmq.archive(...) to keep for audit/replay
    } catch (err) {
      if (msg.read_ct >= 5) {   // poison pill -> dead-letter
        await pool.query("SELECT pgmq.send($1, $2::jsonb);", [`${QUEUE}_dlq`, JSON.stringify(msg.message)]);
        await pool.query("SELECT pgmq.archive($1, $2);", [QUEUE, msg.msg_id]);
      }
      // else: do nothing -> message reappears after VT_SECONDS for retry
    }
  }
  return rows.length;
}

// Long-poll: block up to 10s, poll every 250ms (avoids busy-looping)
async function consumeLongPoll() {
  const { rows } = await pool.query<MessageRecord>(
    "SELECT * FROM pgmq.read_with_poll($1,$2,$3,$4,$5);",
    [QUEUE, VT_SECONDS, BATCH, 10, 250]
  );
  return rows;
}
```

`pg` returns `bigint` (`msg_id`) as **strings** and parses `jsonb` to JS values. Prefer `read_with_poll` over busy-looping. Rely on `vt` for redelivery on failure; batch `send`/`read`/`delete` to cut round-trips.

## 9. Performance & ops

- **Concurrency:** `FOR UPDATE SKIP LOCKED` → safe parallel workers, no double-delivery within `vt`.
- **Vacuum/bloat:** queues are high-churn (insert + update `vt`/`read_ct` + delete). Tune autovacuum aggressively on hot `pgmq.q_*` tables — the main operational concern at scale.
- **Retention:** prefer partitioned queues at high volume (drop partitions vs mass `DELETE`). `archive()` keeps rows in `a_<name>` **forever** unless you partition the archive or run your own cleanup.
- **Notify vs poll:** for sporadic traffic, `enable_notify_insert` + `LISTEN "pgmq.q_<name>.INSERT"` lets consumers idle instead of poll (throttled, default 250ms).
- **Batch everything.**

---

# Part B — PGMQ in the work / Absurd context

## The boundary: no overlap, clean complement

Absurd and PGMQ both live in Postgres, but they answer **different questions** and should not be substituted for one another:

| | **Absurd** | **PGMQ** |
|---|---|---|
| Answers | *"What is the durable state of this workflow run, and which steps are already done?"* | *"Which worker should pick up this unit of work next?"* |
| Owns | execution state machine, step memoization, crash-recovery, replay | message transport: enqueue → visibility-timeout lease → ack/delete |
| Unit | a **task** with memoized **steps** (`ctx.step`) | a **message** (jsonb) with `vt` / `read_ct` |
| Guarantee | durable, resumable execution | at-least-once delivery |
| Anti-pattern | using it as a generic message bus | storing long-lived execution state in it |

The rule of thumb: **Absurd remembers; PGMQ delivers.** Absurd is the source of truth for *what has happened*; PGMQ is the transport for *what should happen next*. Keep execution state in Absurd's journal and keep only transient dispatch/coordination messages in PGMQ. Don't reconstruct workflow state by replaying a PGMQ queue, and don't use an Absurd step as a fan-out mailbox.

> Note on Absurd's own queues: Absurd is pull-based and has its own task-queue concept (recall the engine's **one-queue-per-tier** layout — an orchestrator queue + a jobs queue — driven by the rule that `awaitTaskResult` deadlocks if child and parent share a queue). PGMQ does **not** replace those internal task queues. PGMQ sits at the **edges** of the Absurd graph — ingress, runner dispatch, signals, results, dead-letters — where you want SQS-style decoupling that Absurd deliberately doesn't provide.

## Where PGMQ earns its place in this engine

### 1. Trigger / ingress queue (workflow run requests)
External producers (webhooks, CLI, cron, upstream workflows) `pgmq.send()` a **run request** onto a `wf_triggers` queue. A small dispatcher long-polls it (`read_with_poll`) and, for each message, spawns the top-level Absurd orchestrator task, then `delete()`s on successful spawn (or relies on `vt` redelivery if the spawn fails). This decouples *accepting* a workflow request (cheap, always-available, burst-absorbing) from *running* it (heavy, stateful). `read_ct`-based dead-lettering protects against a malformed trigger wedging the dispatcher.

```
producer ──send──▶ pgmq: wf_triggers ──read_with_poll──▶ dispatcher ──spawn──▶ Absurd orchestrator task
```

### 2. Runner-pool dispatch for `runs-on` (the strongest fit)
This is where PGMQ complements the `runs-on` / `ExecutionTarget` design. When a job needs to run on a pool of Gondolin-VM runners (rather than in-process), the orchestrator step `pgmq.send()`s a **job-execution message** onto a queue *per runner class* — e.g. `runner_gondolin`, `runner_local`. A fleet of runner processes long-poll their queue, lease a message via `vt`, spin up the VM, run the step's task, write the result back (see §4), then `delete()`.

Why PGMQ and not Absurd here: PGMQ's `FOR UPDATE SKIP LOCKED` + visibility timeout gives **free, contention-light work-stealing across an arbitrary number of runner machines**, plus automatic redelivery if a runner dies mid-job (the VM's lease expires, the message reappears, another runner retries). That is exactly SQS-style competing-consumers dispatch — something Absurd's deterministic task model isn't trying to be. Set `vt` to slightly more than the job's max runtime, and have long-running jobs call `set_vt()` to extend the lease (a heartbeat). `runs-on` maps directly to **which PGMQ queue** the job message lands on.

```
Absurd job step ──send──▶ pgmq: runner_gondolin ──┬─▶ runner A (VM) ─┐
                                                   ├─▶ runner B (VM) ─┼─▶ result back to Absurd
                                                   └─▶ runner C (VM) ─┘
```

### 3. Fan-out / matrix work distribution
Recall Absurd has **no native parallel/matrix primitive** — fan-out is "spawn N child tasks." For coarse-grained fan-out, spawning Absurd children is right (each leg needs its own durable state). But for **fine-grained, homogeneous, stateless** fan-out (e.g. "lint these 5,000 files"), spawning 5,000 durable tasks is heavy. PGMQ is the better tool: `send_batch()` the work items onto a queue, let the runner pool drain it with competing consumers, and have a single Absurd step await a completion count. Use Absurd children when each leg has meaningful independent state; use a PGMQ queue when the legs are interchangeable units of throughput.

### 4. Result / output bus and signals
- **Results:** runners `pgmq.send()` step outputs onto a `wf_results` queue keyed by `{runId, jobId, stepId}`; the awaiting orchestrator drains it to satisfy convergence/`needs`. (Alternatively write results straight to Absurd state — choose based on whether the producer is in-process or a remote runner.)
- **Signals / external events:** a `wf_signals` queue delivers human-approval clicks, webhook callbacks, or cancellation requests into a waiting workflow — the PGMQ analogue of "wait for an external event."
- **Dead-letter:** poison steps (high `read_ct`) get archived + forwarded to `<queue>_dlq` for inspection, rather than silently retrying forever.

### 5. Agentic-step considerations
When a step punts to a Pi agent on a remote runner, the same dispatch pattern applies — the agent invocation is just the job's task. Because Pi has **no mid-LLM-turn suspend/resume**, an agentic job is an atomic unit from the queue's perspective: lease it with a generous `vt` (agent runs can be long — heartbeat with `set_vt()`), and on runner death the whole agent run is retried from the start. Keep the agent's durable transcript in Pi's session tree / Absurd state, **not** in PGMQ; PGMQ only carries the "go run this agent job" message and the "here's the result" message.

## Queue topology for the engine (suggested)

| Queue | Type | Purpose | Consumer |
|---|---|---|---|
| `wf_triggers` | plain | inbound run requests | dispatcher → spawns Absurd orchestrator |
| `runner_gondolin` | plain | job-exec messages for secure VM runners | Gondolin runner pool |
| `runner_local` | plain (or unlogged) | job-exec messages for local runners | local runner pool |
| `wf_fanout` | partitioned | high-volume homogeneous work items | runner pool (competing consumers) |
| `wf_results` | plain | step outputs from remote runners | orchestrator (convergence/`needs`) |
| `wf_signals` | plain | approvals / webhooks / cancellation | waiting workflow steps |
| `*_dlq` | plain | dead-lettered poison messages | ops / inspection |

Notes: `vt` per queue ≈ that work class's max runtime + margin; runners heartbeat with `set_vt()`. Use **unlogged** only where message loss on crash is acceptable (e.g. local-dev runner queue). Use **partitioned** for the high-volume fan-out queue so retention is handled by dropping partitions. Everything is **idempotent** because delivery is at-least-once — key job-exec messages by `{runId, jobId, stepId}` and let Absurd's step memoization absorb duplicate executions (a redelivered job whose step already completed returns the cached result instead of re-running).

## Integration gotchas

- **Idempotency is mandatory.** At-least-once + `vt` redelivery means every consumer must tolerate dupes. The clean design is: PGMQ delivers "run step X" possibly twice; Absurd's `ctx.step` memoization makes the second delivery a no-op that returns the cached result. This is *why* the two compose so well — PGMQ's weakest guarantee (at-least-once) is exactly covered by Absurd's strongest one (durable memoization).
- **Don't double-store state.** A job message in PGMQ should carry *references* (`runId`/`jobId`/`stepId`/input pointers), not the authoritative execution state. The state lives in Absurd.
- **Lease vs runtime.** Set `vt` carefully and heartbeat long jobs with `set_vt()`; otherwise a slow job gets redelivered and runs twice concurrently (still safe if idempotent, but wasteful — especially for paid agent calls).
- **One Postgres, two concerns.** Both can share the same database/instance, which keeps ops simple and lets a dispatcher transaction (read trigger + spawn task) be atomic if desired. Watch autovacuum on the hot `pgmq.q_*` tables alongside Absurd's own journal tables.
- **Connection pooling:** long-polling consumers hold a connection for `max_poll_seconds`; size the pool for (runner count × queues polled) so polling doesn't starve the orchestrator/dispatcher.

---

## Sources
- PGMQ docs home: https://pgmq.github.io/pgmq/latest/
- SQL Functions API: https://pgmq.github.io/pgmq/latest/api/sql/functions/
- SQL Types API: https://pgmq.github.io/pgmq/latest/api/sql/types/
- Partitioned Queues: https://pgmq.github.io/pgmq/latest/partitioned-queues/
- INSTALLATION.md: https://github.com/pgmq/pgmq/blob/main/INSTALLATION.md
- SQL source (DDL/indexes verified): https://github.com/pgmq/pgmq/blob/main/pgmq-extension/sql/pgmq.sql
- Repo: https://github.com/pgmq/pgmq
- Supabase Queues / pgmq: https://supabase.com/docs/guides/queues/pgmq
- Engine context: see [`absurd-durable-workflows.md`](absurd-durable-workflows.md), [`gondolin-secure-execution.md`](gondolin-secure-execution.md), [`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md), and [`../README.md`](../README.md)

**UNVERIFIED items (remaining, all low-value / external-status):** current Tembo Cloud product status; minimum `pg_partman` version; full list of managed providers offering `pgmq` one-click; current PyPI name for the official Python client. *(LICENSE SPDX resolved: `PostgreSQL`, © 2023 Tembo.)* These are third-party operational details, not blockers for the engine design.
