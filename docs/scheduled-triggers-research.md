# `on: schedule` — Cron-Scheduled Workflow Runs: Research + Design

> Research note for a time-based trigger: a workflow declares one or more **cron
> expressions**, and the engine fires a run when each is due — i.e.
> "`workflow_dispatch` on a clock" — mirroring GitHub Actions'
> `on: { schedule: [{ cron: '...' }] }` so the syntax is familiar.
>
> **Builds on** [`webhook-triggers-research.md`](webhook-triggers-research.md)
> and [`web-ui-research.md`](web-ui-research.md): the scheduler is an *extension
> of the same long-lived `--web` server* (RunManager, the `parse→compile→Runtime.run`
> dispatch path, the `.workflows/db` PGLite history), not a new stack. It also
> builds on [`absurd-durable-workflows.md`](absurd-durable-workflows.md) §10,
> [`durable-orchestrator.md`](durable-orchestrator.md), and Absurd's official
> [cron pattern](https://earendil-works.github.io/absurd/patterns/cron/) — which
> states plainly that **Absurd ships no built-in scheduler**, so the recurring
> driver is application-side (its `pg_cron` → `absurd.spawn_task` alternative
> needs an extension PGLite can't load — see §4a).
>
> Written pre-implementation (2026-06-15). **Pass 1** consolidated four parallel
> investigations (trigger/spec surface, Absurd timing primitives, web-server
> lifecycle/persistence, cron syntax + library prior-art). **Pass 2 (§§7-10)**
> added the *hosting* question — how to run the scheduler without diverging the
> web/CLI/daemon cores — from another fan-out: the shared-core extraction seam,
> the PGLite single-process constraint, a prior-art survey of how comparable
> schedulers run (cron, anacron, systemd timers, dagu, n8n, GitHub Actions
> runner, Airflow, Windmill, Temporal, pm2), and a catch-up/overlap policy.
>
> Tags used throughout: **VALIDATED** (grounded in our code, file:line) /
> **VERIFIED** (cited external standard/vendor doc) / **PROPOSED** (a design
> choice) / **NEEDS-BUILDING** (net-new engine work).
>
> **Status: research only — nothing built yet.** This note maps the seams and
> recommends a design; no spec, scheduler, or dependency has landed.

---

## 1. The ask, and the shape we'll mirror

Let a workflow declare a recurring schedule in cron syntax and have `work` fire
a run when it's due — with no host-execution mode, every fire is a normal
gondolin run, identical to a manual or webhook-triggered one.

**Mirror GitHub Actions exactly for familiarity** (VERIFIED):

```yaml
on:
  schedule:
    - cron: '30 5 * * 1-5'   # POSIX 5-field, quoted; a list — multiple allowed
    - cron: '0 0 * * *'
```

GHA's dialect and its quirks, which we should consciously match or deviate from:

- **Standard POSIX 5-field cron** — `minute hour day-of-month month day-of-week`.
  Ranges minute 0-59, hour 0-23, dom 1-31, month 1-12 (or `JAN-DEC`), dow 0-6
  (Sunday = 0, or `SUN-SAT`). Operators `* , - /`. **No** `@daily`/`@hourly`
  macros, **no** seconds field.
- **Always UTC.** GHA has no timezone option at all.
- **Minimum interval ~5 min**, **no guaranteed timing** (cron is the *queue*
  time; runs can lag under load), and scheduled workflows are auto-disabled after
  ~60 days of repo inactivity.

Sources: [cronbuilder.dev](https://cronbuilder.dev/blog/github-actions-cron-schedule.html),
[cronsignal.io](https://cronsignal.io/syntax/github-actions),
[Earthly](https://earthly.dev/blog/cronjobs-for-github-actions/),
[OneUptime](https://oneuptime.com/blog/post/2025-12-20-scheduled-workflows-cron-github-actions/view).

**Where we can do better than GHA (PROPOSED):** `work` runs locally with no
shared-fleet load or inactivity constraints, so (a) sub-5-minute intervals are
fine (POSIX granularity is 1 minute regardless), and (b) we can optionally
support a per-entry `tz:` (IANA timezone) — defaulting to UTC to match GHA, and
documenting the divergence.

---

## 2. The key asymmetry: `schedule` is proactive, `webhook` is reactive

This is the load-bearing distinction that shapes the whole design.

`webhook` is **reactive**: an inbound `POST /hooks/:name` drives it, so
"registration" is just a config lookup at request time, and the spec's
`on.webhook` is a non-load-bearing opt-in flag the receiver checks
(`src/web/server.ts:618`). VALIDATED.

`schedule` is **proactive**: nothing arrives from outside; the engine must
*itself* know what time it is and fire on its own. That demands two things we
don't have today:

1. A **persistent recurring driver** (a clock/ticker) — there is no timer,
   interval, or daemon loop anywhere in the run path. The only `setInterval` in
   the web server is the 15s SSE heartbeat (`src/web/server.ts:415`). VALIDATED.
2. **Durable schedule state** so a fire that comes due while the process is down
   is handled deliberately (skip vs. catch-up), not silently lost.

Unlike webhook, `schedule` is therefore **load-bearing in the spec** — the
trigger declaration *is* the schedule; there's no external sender. NEEDS-BUILDING.

---

## 3. Spec surface — the additive hook points

The `on:` block is already typed and deliberately extensible, so adding
`schedule` is purely additive. VALIDATED.

- `OnSpec` (`src/spec/types.ts:183-186`) currently has only `webhook?` and
  `workflow_call?`. Add `schedule?: ScheduleTrigger[]`, where
  `ScheduleTrigger = { cron: string; tz?: string }` (PROPOSED — array + object
  to mirror GHA's list form and leave room for `tz`).
- `parseOn` (`src/spec/parse.ts:219-239`) dispatches mapping keys to per-trigger
  validators. Add `if (raw.schedule !== undefined) on.schedule = parseSchedule(...)`.
  **Watch the string shorthand:** the bare-string branch throws
  `unknown trigger "..."` on anything but `webhook`/`workflow_call`
  (`parse.ts:226`) — so `on: schedule` (bare) currently *rejects*, while
  `on: { schedule: [...] }` (mapping) currently passes through and is silently
  dropped. Both paths need updating; the mapping form is the real target.
- `parseSchedule` should **validate each cron expression at parse time** (construct
  it via the chosen library and catch), so a typo fails fast in `parse`/`graph`,
  not at 5am. NEEDS-BUILDING.
- Re-export new types via `src/spec/index.ts`.

Note on the `on` doc comment (`types.ts:192`): update it — unlike `webhook`,
`schedule` *is* consumed by execution machinery.

---

## 4. Absurd has no built-in scheduler — the pattern is app-side `spawn` + idempotency keys

Absurd's own [cron pattern doc](https://earendil-works.github.io/absurd/patterns/cron/)
is explicit: *"Absurd does not include a built-in scheduler, but scheduling is
straightforward."* It documents **two** supported patterns — and that is the
whole menu. (Verified against that doc and `absurd-sdk@0.4.0` `dist/`.)

1. **Application-side scheduler + idempotency keys.** A small process evaluates
   cron expressions and calls `app.spawn(taskName, payload, { idempotencyKey })`,
   the key derived from `taskName | expr | UTC-minute-slot`:

   ```ts
   function dedupKey(taskName, expr, nextAt) {
     const slot = nextAt.toISOString().slice(0, 16);   // minute precision, UTC
     return `cron:${sha256(`${taskName}|${expr}|${slot}`).slice(0, 24)}`;
   }
   await app.spawn(taskName, { scheduledFor }, { idempotencyKey: dedupKey(...) });
   ```

   The slot-keyed idempotency is the load-bearing trick: per the doc, *"duplicate
   scheduler runs (deploy overlap, crash restart, multiple replicas) collapse into
   a single Absurd task."* So the driver can be a naive ticker and still fire each
   slot exactly once. This is the basis of §5.

2. **DB-side `pg_cron` → `absurd.spawn_task`** — see §4a; unavailable to us.

`SpawnOptions` (`index.d.ts:22-29`) carries only `maxAttempts`, `retryStrategy`,
`headers`, `queue`, `cancellation`, `idempotencyKey` — there is **no**
`runAt`/`scheduleAt` and no recurring-task API. The recurring *driver* is yours
to run; Absurd's contribution is the idempotent `spawn`. (Absurd does expose a
durable `ctx.sleepUntil` wait primitive, `index.d.ts:247`, but it is **not** part
of the cron pattern and plays no role in scheduling — so it is out of scope here.)
VALIDATED / VERIFIED.

### 4a. The `pg_cron` option is real — but PGLite can't load it

*(Corrected from pass 1, which dismissed `pg_cron` too quickly.)* Absurd's second
documented pattern schedules `absurd.spawn_task` directly from `pg_cron`:

```sql
select cron.schedule('absurd-send-report-every-5m', '*/5 * * * *', $$
  select absurd.spawn_task('default', 'send-report',
    jsonb_build_object('scheduled_for', now()));
$$);
```

`absurd.spawn_task` is a **first-class public SQL function** — it's in our
vendored schema at `schema.sql:682`, and the header comment (`:19`) notes *"Task
execution flows through `spawn_task`"* (the SDK's own `spawn()` bottoms out here).
So the pass-1 claim that a SQL-side spawn means "bypassing the SDK into private
tables" was **wrong**: this is a supported entry point built for exactly this.

**Why it's still out for `work` (primary sources, not just our schema guards):**
`pg_cron` cannot run on PGLite, for three independent reasons —

1. **It needs a background worker loaded via `shared_preload_libraries`, and
   PGLite has neither.** pg_cron's README: `shared_preload_libraries = 'pg_cron'`
   is *"required to load pg_cron background worker on start-up"*, and it "creates
   a background worker" ([citusdata/pg_cron](https://github.com/citusdata/pg_cron)).
   PGLite runs Postgres in **single-user mode** because Emscripten/WASM *"cannot
   fork new processes"*, an architecture that *"eliminates the need for background
   workers or the postmaster process"*
   ([Electric — PGlite v0.4](https://electric.ax/blog/2026/03/25/announcing-pglite-v04)).
2. **`shared_preload_libraries` is ignored in single-user mode** regardless — a
   PostgreSQL property, not a PGLite quirk
   ([pgsql-hackers](https://www.postgresql.org/message-id/4C69D57A.80101%40ak.jp.nec.com)) —
   so pg_cron's one supported load path is a no-op in the mode PGLite uses.
3. **PGLite only loads extensions statically compiled to WASM**, and pg_cron is
   **not** in its catalog (pgvector, pg_uuidv7, PostGIS, AGE, … — no pg_cron); you
   cannot `CREATE EXTENSION` an arbitrary native `.so`
   ([PGlite extensions](https://pglite.dev/extensions/)).

Our vendored schema already encodes this defensively: every `pg_cron` call is
guarded by `if to_regclass('cron.job') is not null` (e.g. `:359, 2613, 2911`),
and the `absurd.enable_cron` that ships (`:2857`) only wires three
queue-maintenance jobs (`:2940-2994`), never user runs. So of Absurd's two
patterns, **only the application-side scheduler (§4 pattern 1) is available to
us** — and §5 is the single design that follows from it. VALIDATED / VERIFIED.

---

## 5. The design — an app-side ticker driving `dispatch`, keyed by slot

There is exactly one option consistent with Absurd's built-in functionality
(§4 pattern 1; pattern 2 is ruled out by §4a): a recurring **driver inside our
long-lived host** (the `RunService` of §7) that, each tick, computes which cron
slots are due and dispatches them with a **slot-derived idempotency key**.

```
// in RunService, every ~30s while the host runs:
for (const { workflow, expr } of scheduledWorkflows()) {
  const slot = dueSlot(expr);                   // null if nothing due this tick
  if (!slot) continue;
  const runId = `cron:${workflow}:${slot}`;     // = the idempotency key
  runManager.dispatch({ name: workflow, plan, trigger: "schedule", runId });
}
```

**Why a slot-keyed `runId` is exactly-once for free:** the orchestrator task is
spawned with `idempotencyKey = runId` (`runtime.ts:249`). Setting
`runId = cron:<wf>:<slot>` means two overlapping ticks, a restart within the same
minute, or any duplicate dispatch all collapse to one run — `spawn` returns
`created:false` for the dup. This is exactly Absurd's documented dedup trick (§4),
adapted to `work`'s `dispatch → startRun → runtime.run` path instead of a raw
`app.spawn`. `RunManager` should additionally short-circuit a dispatch whose
`runId` already exists, so the run-record bookkeeping doesn't double-count (the
underlying Absurd spawn is idempotent regardless). NEEDS-BUILDING.

- **Driver placement:** the ticker lives in `RunService` (§7), so **both**
  `--web` and `work daemon` get it; it runs only while the host is up — which is
  exactly when a worker is polling. There is **no** `sleepUntil`, no
  self-rescheduling task chain: the slot key, not a journaled wait, is what makes
  it safe. (Pass 1's `sleepUntil` ticker was a non-documented construction and is
  dropped.)
- **Cron math:** "is a slot due this tick?" is computed from the expression with
  the parser of §12. Persist `last_fired_at` / `next_fire_at` in `work.schedules`
  (§6) for the catch-up policy (§10) and the status surface (§9).
- **Not self-durable across downtime** — like cron and like Absurd's own pattern,
  a slot that elapses while the host is down is simply not dispatched. Catch-up is
  the explicit, opt-in policy of §10 (on startup, check `last_fired_at` and fire a
  single coalesced make-up within the window), *not* an Absurd primitive.

---

## 6. Where the scheduler lives — web-server lifecycle & persistence

The web server is the **only** long-lived process; there is no daemon
subcommand (CLI surface confirmed: `run`, `graph`, `resume`, `rerun`, `logs`,
`doctor`, `create`, `init`, `--web`; only `--web` stays alive — `cli.ts:331-360`,
`:590-593`). Today that makes `startWebServer` the only place a scheduler *could*
live. But welding the scheduler to the HTTP server would force anyone who wants
scheduled runs to also run a web console — so **§7 argues for extracting a shared
host (`RunService`) that both `--web` and a new headless daemon wrap**, and the
scheduler hangs off that host, not off the HTTP layer. The lifecycle seams below
are where that host plugs into the *current* server; §7 generalizes them.
VALIDATED.

**Lifecycle seams** (`src/web/server.ts`):

- **Construct** after the RunManager (`:122-130`), gated on
  `ownsEngine && opts.dataDir` — the same gate the durable repositories use
  (`:101-120`), since PGLite is single-process and only the owned-engine path
  persists.
- **Start** after `listen` + the existing `reconcileInterruptedRuns` boot step
  (`:223`) — the scheduler's "catch up on missed fires" logic is the direct
  analog of that reconciliation.
- **Stop** in the returned `close()` (`:782-797`) — `scheduler.stop()` *before*
  `runManager.whenIdle()` so it stops enqueuing during drain. The heartbeat
  Set + clear-all-in-`close()` + `.unref()` pattern (`:140`, `:415`, `:785`) is
  the established model for owning a timer cleanly.

**Discovery:** `listWorkflows(workspace)` (`src/project.ts:141`) already
enumerates every `.workflows/*.yaml` (used by `GET /api/workflows`,
`server.ts:297`). On boot/tick the scheduler reads + `parseWorkflow`s each file
and collects those with `spec.on?.schedule` — the same read-parse-opt-in dance
`loadOptedInSpec` does for webhooks (`server.ts:598-624`). VALIDATED.

**Persistence:** add `src/persistence/schedules.ts` with a `work.schedules`
table, following `RunRepository` (`src/persistence/runs.ts:57-100`) verbatim —
same shared engine, same idempotent `ensureSchema()` call site
(`server.ts:103-110`), same bigint-epoch-ms convention (PG returns bigint as a
string → read via `Number(...)`). Suggested columns
`(workflow text, cron text, last_fired_at bigint, next_fire_at bigint, enabled bool)`.
On boot, `last_fired_at`/`next_fire_at` decide whether a fire was missed during
downtime. Under the §5 design this table **is** the schedule's source of truth
(there is no sleeping Absurd task holding state): the ticker reads it to compute
due slots and the catch-up window, and writes `last_fired_at` on each dispatch.
VALIDATED / PROPOSED.

---

## 7. Hosting without divergence — the `RunService` extraction

The guiding constraint from the maintainer: **web, CLI, and any daemon must share
one core run path; they must not drift into parallel implementations.** The good
news is the core is *already* shared — the work is to stop the web server from
being the sole owner of the lifecycle around it.

**What is already shared core** (VALIDATED):
- `startRun()` (`src/run.ts:82`) is genuinely the one place a compiled plan
  becomes a result. Both the CLI (`cli.ts:698`) and the web `RunManager`
  (`run-manager.ts:202`) call it with the same option shape. It owns work-root
  lifecycle, `uses:` handler composition, egress composition, and
  `AbsurdRuntime` construction — and **borrows** presentation entirely via
  `opts.hooks` (`run.ts:170`) and the engine conditionally
  (`ownsEngine = opts.engine === undefined`, `run.ts:119`).
- The **hooks contract** (`RunHooks`, `src/runtime/types.ts:43-50`) is the
  universal presentation seam. Four independent consumers already implement the
  same `Presenter` interface over identical hooks: `NullPresenter`,
  `BufferedPresenter`, `LayeredPresenter` (`src/tui/presenter.ts`), and
  `WebPresenter` (`src/web/web-presenter.ts:49`, "a third Presenter alongside
  the TUI's"). Presentation is already fully pluggable.

**What is web-only and must NOT be duplicated into a daemon** (VALIDATED): the
`node:http` server + routing + `listen()` (`server.ts:210-288`), CSRF/Host
loopback guards (`:226,:249-260`), SSE plumbing + heartbeats (`:401-432`), the
webhook receiver (`:489-948`), and the `client.ts` UI.

**The ambiguous middle — and the extraction seam** (PROPOSED): `RunManager`
(`src/web/run-manager.ts:111`) is ~80% generic run orchestration a daemon also
wants — the concurrency cap + FIFO queue + load-shedding, the `inFlight` set +
`whenIdle()` graceful drain (`:243`, which exists precisely to avoid orphaning
Absurd workers against an ended pool), and durable history at dispatch/terminal.
Its only web coupling is the SSE subscriber fan-out (`RunRecord.subscribers:
Set<ServerResponse>`, `broadcast`/`subscribe`, `:274-303`) and the hard-coded
`new WebPresenter(...)` in `dispatch` (`:177`). Likewise `startWebServer`'s
prologue (`server.ts:95-130`, `:223`, `:782-798`) is mostly generic: engine boot
+ ownership flag, durable-store `ensureSchema`, `RunManager` construction,
`reconcileInterruptedRuns` (`:815-843`, the crash-resume-on-startup logic a
daemon absolutely needs and which is already dependency-injected), and the
`whenIdle()` → `engine.close()` teardown.

So the recommended refactor is a transport-free **`RunService`** (a.k.a.
`EngineHost`) in a new `src/service/` subsystem that owns
`{ engine + durable stores + RunManager + scheduler }` and exposes
`dispatch(...)` + `close()`:

1. **Make `RunManager` presenter-pluggable** — replace the hard-coded
   `new WebPresenter` (`run-manager.ts:177`) with an injected
   `presenterFor(runId, emit) => Presenter` factory; move the SSE
   subscriber/`broadcast`/`subscribe` methods (`:274-303`) into a web-side
   `SseHub` that registers as the `emit` sink. `RunManager` becomes HTTP-free;
   everything else stays.
2. **Extract the prologue** (engine + stores + `RunManager` +
   `reconcileInterruptedRuns` + the scheduler member) out of `server.ts` into
   `RunService`.
3. **`--web` becomes a thin adapter** that wraps a `RunService`, adds the HTTP
   server + guards + `SseHub` + webhook receiver, and passes a `WebPresenter`
   factory. **`work daemon`/`work schedule`** wraps the *same* `RunService` with
   a `Buffered`/`Null`/`Jsonl` presenter factory and **no HTTP at all**.

Net effect: the daemon and the web server share `RunService` (engine, stores,
`RunManager`, reconcile, scheduler, drain/close) and the untouched `startRun`
core. The scheduler is just a third trigger source feeding the *already-shared*
`dispatch → startRun` path — exactly as the webhook receiver is today. The only
thing the daemon drops is everything under `src/web/` that is HTTP/SSE/CSRF/UI.
NEEDS-BUILDING.

---

## 8. The PGLite constraint forces *one runner per workspace*

Why a multi-process split (a standalone scheduler daemon *alongside* `--web`) is
off the table — and why that actually helps the anti-divergence goal.

**PGLite is single-process-exclusive on its data directory**, not merely
single-connection. The engine pins `pg.Pool({ max: 1 })` and
`PGLiteSocketServer({ maxConnections: 1 })` on a **random, never-advertised
loopback port chosen fresh per boot** (`engine.ts:69-81, 100-101`) — so the
socket is *not* a reusable cross-process service. Worse, opening the same
`.workflows/db/` from two processes raises **no error — silent last-writer-wins
corruption** (`docs/pglite-wasm-postgres-database.md:104`, VERIFIED-LOCALLY; the
sole-owner invariant is restated at `run.ts:63`, `server.ts:70,94`). There is
**no lockfile or single-instance guard anywhere in `src/` today** — the codebase
treats sole ownership as an unenforced invariant. VALIDATED.

**Consequence:** `work --web` and a separate `work daemon` **cannot** run against
the same workspace. The scheduler must live inside the *single* process that owns
the engine. This is the sharpest divergence from the prior-art tools that split a
standalone scheduler from their web server (Airflow, dagu, Temporal, Windmill) —
**they can split only because they sit on a real concurrent database** and
coordinate via row-level locks (`SELECT … FOR UPDATE [SKIP LOCKED]` in Airflow
and Windmill). We have no such substrate. So our model is necessarily the
*combined single process* those same tools also ship for local/dev use —
dagu `start-all`, Airflow `standalone`, Temporal `start-dev`, Windmill
`MODE=standalone` — which is exactly what `--web` already is (engine + RunManager
+ triggers in one process). This is *good* for "don't diverge": the constraint
**forces** the single shared `RunService` rather than permitting parallel
scheduler/server implementations.

**Two things this requires** (NEEDS-BUILDING):
- A **single-instance lock per workspace**, acquired *before* `createAbsurdEngine`
  (since PGLite itself won't error on double-open). The cleanest precedent is
  dagu's directory lock: an `O_EXCL` lock dir / lockfile under `.workflows/db/`
  holding `host-pid-token`, refreshed as a heartbeat, reclaimed after a stale
  threshold (dagu uses 30s). This makes today's silent-corruption failure mode
  *loud*, and it's needed for **both** `--web` and the daemon regardless of
  scheduling. (A PGLite advisory lock can't serve here — it presupposes the very
  connection we're trying to guard.)
- **`--web` and `work daemon` are mutually exclusive per workspace**, and should
  say so clearly (the lock turns the second launch into a clean error, not
  corruption). A user who wants both the console *and* scheduling runs `--web`
  (which hosts the scheduler too); a user who wants headless scheduling without
  the HTTP surface runs `work daemon`.

---

## 9. Prior art — how comparable tools host scheduling

Survey of how local/self-hosted schedulers structure the daemon, lock, drain,
catch up, and report status. The throughline: **foreground by default + external
supervisor; a combined single-process mode for local use; opt-in catch-up.**

| Tool | Daemon model | Single-instance | Catch-up after downtime | Scheduler placement | Status surface |
|---|---|---|---|---|---|
| **dagu** | foreground; `start-all` combines server+scheduler+coordinator in one process; rely on systemd | **dir lock** `.dagu_lock` + `host-pid-token` fence, 30s stale-reclaim heartbeat | **opt-in** `catchupWindow` (off by default; capped 1000 missed; needs queue); `OverlapPolicy: skip` default | separable (`scheduler`/`server`) **or** combined (`start-all`) | per-run unix socket `/status`,`/stop`; `status`/`history`; web UI; opt-in `:8090/health` |
| **Temporal** | foreground; `start-dev` single-process (SQLite, ephemeral unless `--db-filename`); prod = multi-service cluster | durable cluster state + Workflow IDs | **`catchupWindow`, default 1 year, min 10s**; missed actions outside window dropped | server-side system workflow (Worker service), separate from SDK worker | `schedule describe` (shows next runs); `/health`; `operator cluster health` |
| **Airflow** | foreground `airflow scheduler`; `standalone` for dev; systemd in prod | **DB row locks** `SELECT … FOR UPDATE` on `slot_pool` (`use_row_level_locking`) | **`catchup`** — default **True in 2.x, flipped to False in 3.x** to avoid surprise backfill floods; `max_active_runs` throttles | separate process; HA active-active multi-scheduler | `/health` (200/503), heartbeat threshold 30s |
| **Windmill** | foreground; `MODE=standalone` (server+worker) or split | **DB** `FOR UPDATE SKIP LOCKED` + `scheduled_for` EXISTS dedup | **none** — keeps only the next occurrence queued, recomputes from "now"; error/recovery handlers, not backfill | embedded in the queue path (self-rescheduling rows); no scheduler daemon | Runs page (past + future); `/healthz` |
| **n8n** | foreground; Docker/systemd/pm2; queue mode splits main/workers | port-bind (`EADDRINUSE`); multi-main = **Redis TTL leader key** (10s TTL, 3s check) | **none** — missed schedules skipped, resume next | embedded in main; leader-only fires triggers | `/healthz` + `/healthz/readiness` (opt-in) |
| **GH Actions runner** | foreground `run.sh`; `svc.sh` → systemd/launchd; `TimeoutStopSec=5min` | one runner per config directory; server-enforced one-job-at-a-time / `--ephemeral` | **server-side queue** holds jobs until a runner returns (no runner-side catch-up) | none — GitHub dispatches | Idle/Active/Offline in UI + REST; heartbeat connection |
| **systemd timers** | no per-timer daemon; PID 1 / `--user` manager supervises | unit-instance identity (no second concurrent start); templates for parallelism | **`Persistent=`** (default false) → run immediately if a fire was missed while down; mtime stamp files in `/var/lib/systemd/timers/` | embedded in the manager | `systemctl list-timers` (**NEXT/LEFT/LAST/PASSED**) |
| **cron / anacron** | crond daemon (foreground `-f` under systemd) | `flock -n` is the standard overlap guard (job author's job) | cron: **none**. **anacron: catch-up by design** — per-job timestamps (day granularity); exists *for machines not on 24/7* | crond fires; anacron run hourly to pick up misses | timestamp files in `/var/spool/anacron/` |
| **pm2** | "God" daemon (auto-forked); `pm2-runtime`/`--no-daemon` for foreground/containers | one daemon per `$PM2_HOME`; `rpc.sock`/`pm2.pid` | supervisor, not a scheduler; `cron_restart` has **no** missed-fire catch-up | separate God daemon over axon-RPC socket | `list`/`status`/`jlist` (JSON), `monit`, `ping` |

Sources: dagu [docs](https://docs.dagu.cloud/features/scheduling) · Temporal [schedules](https://docs.temporal.io/schedule), [internals](https://github.com/temporalio/temporal/blob/main/docs/architecture/schedules.md) · Airflow [DAG runs/catchup](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html), [scheduler HA](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html) · Windmill [scheduling](https://www.windmill.dev/docs/core_concepts/scheduling), [next-tick PR](https://github.com/windmill-labs/windmill/pull/5022) · n8n [queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) · GH runner [as a service](https://docs.github.com/actions/hosting-your-own-runners/managing-self-hosted-runners/configuring-the-self-hosted-runner-application-as-a-service) · [systemd.timer(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) · [anacron(8)](https://manpages.ubuntu.com/manpages/focal/man8/anacron.8.html) · pm2 [signals](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/), [specifics](https://pm2.keymetrics.io/docs/usage/specifics/).

**Takeaways that shape `work`'s design:**
- **Foreground + external supervisor is universal.** No modern tool self-daemonizes;
  they run in the foreground and lean on systemd/launchd/Docker/pm2. → `work daemon`
  should run in the foreground and document systemd/pm2/launchd for backgrounding —
  not implement its own double-fork. `work`'s existing SIGINT/SIGTERM → `close()` →
  `whenIdle()` drain (`cli.ts:355-359`, `server.ts:782-797`) already matches the
  SIGTERM + ~30s-drain convention (n8n 30s, dagu 30s).
- **A combined single-process mode is the local norm** (`start-all`/`standalone`/
  `start-dev`). `--web` is already ours; a headless `work daemon` is the
  no-HTTP variant — both over the one `RunService`.
- **Single-instance via filesystem lock** (dagu) is the right fit since we have no
  concurrent DB to lock against (unlike Airflow/Windmill).
- **`systemctl list-timers` is the model for a status command** — a `work schedules`
  subcommand listing each scheduled workflow with NEXT (`next_fire_at`) / LAST
  (`last_fired_at`) read from the `work.schedules` table, plus the `--web` history
  UI and the existing `work runs`/`work logs` for execution detail.

---

## 10. Catch-up after downtime & overlap — skip by default, opt-in bounded window

The single most divergent design axis across the prior art, so it warrants an
explicit decision rather than an accident of implementation.

**The spectrum** (VERIFIED): no catch-up — cron, n8n, Windmill, pm2 (skip the
miss, resume at the next future occurrence); opt-in catch-up — systemd
`Persistent=` (default off), dagu `catchupWindow` (default off), Airflow
`catchup` (**flipped from True→False in 3.x precisely because surprise backfill
floods burned people**); catch-up by design — anacron (its entire reason to
exist, for machines not on 24/7) and **Temporal `catchupWindow` (default 1 year,
min 10s)**.

**Recommendation (PROPOSED): default to skip; offer opt-in, bounded catch-up per
schedule.** Rationale:
- **Default skip** matches the modern consensus (Airflow's deliberate 3.x flip;
  cron/n8n/Windmill) and avoids a thundering herd of historical gondolin runs the
  first time a long-down workspace comes back up — especially important here,
  where every fire is a full micro-VM.
- **But design the window in from day one**, because `work` is squarely anacron's
  use case — a *local* tool on a laptop/dev box that is **not** running 24/7, so
  "I closed the laptop over the weekend and my Monday-morning report never ran" is
  the expected complaint. Temporal's `catchupWindow` is the cleanest model and
  maps directly onto the §5 ticker: persist `last_fired_at`; on startup, if the
  most recent missed fire is within the window, fire **once** (coalesce, don't
  replay every interval); otherwise skip to the next future occurrence. A bounded
  window + coalesce-to-one is the safe middle between "lose it silently" and
  "backfill everything."
- Surface it as a per-entry field mirroring the cron block, e.g.
  `schedule: [{ cron: '...', catchUp: false }]` (or a duration window) — opt-in,
  matching dagu/systemd/Temporal ergonomics.

**Overlap policy** (PROPOSED): a prior scheduled run may still be executing when
the next fire is due. Default to **skip** (Temporal's and dagu's default:
`SCHEDULE_OVERLAP_POLICY_SKIP` / `OverlapPolicy: skip`) via a per-workflow
in-flight guard, with the `RunManager` concurrency cap + queue (`run-manager.ts:157-160`)
as the backstop. Leave richer policies (buffer-one, allow-all) as future work;
skip is the right safe default for VM-backed runs. The §5 slot-keyed `runId`
already prevents *duplicate* fires of the same slot; overlap is the orthogonal
"previous run still going" case.

---

## 11. Dispatch — identical to a webhook fire

A scheduled fire compiles and dispatches exactly like the webhook receiver, just
with no inbound payload:

- `compile(spec, { ...reusableOpts(layout) })` — no `event` (cf. the webhook
  path's `compile(spec, { event, ... })`, `server.ts:529`; the no-input form is
  the `handleWebhookTest`/manual shape).
- `runManager.dispatch({ name, layout, plan, trigger: "schedule" })`
  (`run-manager.ts:154`; webhook call site `server.ts:535-543`). The
  `dispatch → launch → startRun` machinery downstream needs **no changes** — it
  already accepts a compiled plan from any trigger source. VALIDATED.

**One required extension:** `RunTrigger` is `"dispatch" | "webhook"`
(`run-manager.ts:33`, mirrored in `runs.ts:22`). Add `"schedule"` so scheduled
runs are labeled in history and the `--web` client UI (`src/web/client.ts`).
NEEDS-BUILDING.

---

## 12. Cron parsing — recommend `croner`

No cron or date/time library is currently a dependency (runtime deps:
`@electric-sql/pglite`, `pglite-socket`, `absurd-sdk`, `pg`, `yaml`; time is bare
`Date`). VALIDATED. Constraints: ESM-only (`"type": "module"`), and esbuild keeps
deps external (`scripts/build.mjs`, `packages: "external"`) so the lib resolves
from `node_modules` in a published package — bundle size is irrelevant;
**transitive dependency count matters**.

**Recommend `croner`** (VERIFIED): zero dependencies, first-class ESM + TS,
MIT, actively maintained (v10.0.1, Feb 2026). Crucially it exposes pure
`nextRun(from)` / `nextRuns(n)` / `msToNext()` that work **without** starting its
internal scheduler — exactly the "compute the due slot, drive our own ticker"
shape §5 needs. Built-in IANA timezone support covers a future `tz:`. (Absurd's
own cron example uses `cron-parser`; either works — croner just avoids the Luxon
dependency `cron-parser` pulls in.)

| Library | Role | Deps | Note |
|---|---|---|---|
| **croner** ✅ | parse + next-run (+ optional scheduler) | **0** | pure `nextRun()`; IANA TZ |
| cron-parser | parse + next/prev | 1 (Luxon) | ubiquitous, but drags in a full datetime lib we don't need |
| cronstrue | human-readable only | 0 | optional — render schedule descriptions in `--web`/`graph` |

Fallback `cron-parser` if maximum adoption matters, but "dependency-light" tips
it to `croner`. `cronstrue` is a *nice-to-have* for UI/`graph` descriptions only —
never for execution. Sources:
[croner](https://github.com/hexagon/croner),
[cron-parser](https://github.com/harrisiirak/cron-parser),
[npmtrends](https://npmtrends.com/cron-parser-vs-cronstrue-vs-later-vs-node-cron-vs-node-schedule).

---

## 13. Durable-cron pitfalls to design around (VERIFIED / PROPOSED)

- **Compute, don't sleep-and-loop.** Persist an absolute `next_fire_at`; on each
  wake recompute the next instant from the expression. Never chain
  `setInterval(period)` — it drifts and double-fires after sleep/clock jumps.
- **Catch-up policy after downtime & overlap policy** — see §10 (the full
  cross-tool analysis and recommendation): default **skip**, opt-in bounded
  catch-up window (coalesce-to-one), overlap default **skip**. `last_fired_at`
  (the `work.schedules` source of truth, §5/§6) detects the gap.
- **Timezone / DST.** UTC default (matches GHA). If `tz:` is added: a wall-clock
  time in the DST "spring-forward" gap may not exist (skip) and in "fall-back"
  may occur twice (dedupe) — croner does the math, but we pick the semantics.
  Always store `next_fire_at` as an absolute UTC instant.
- **Minimum interval.** Decide whether to warn (GHA-like ~5-min floor) at parse
  time or allow sub-minute; POSIX is 1-min granularity regardless. If croner's
  optional 6-field (seconds) is ever exposed, document the divergence from GHA.

---

## 14. Scope checklist (NEEDS-BUILDING)

1. **Spec** — `ScheduleTrigger` + `schedule?` on `OnSpec` (`spec/types.ts`);
   `parseSchedule` + bare-string fix in `parseOn` (`spec/parse.ts`); barrel
   re-export. Validate cron at parse time. Include the opt-in catch-up + overlap
   fields (§10), e.g. `{ cron, tz?, catchUp? }`.
2. **Dependency** — add `croner` to `dependencies` (no build-script change;
   `packages:"external"` handles it).
3. **`RunService` extraction (§7)** — new `src/service/`: lift engine + stores +
   `RunManager` + `reconcileInterruptedRuns` out of `startWebServer`; make
   `RunManager` presenter-pluggable (`run-manager.ts:177`) and move SSE fan-out
   to a web-side `SseHub`. `startRun` untouched. This is the anti-divergence
   spine — do it before the daemon so both hosts share one core.
4. **Scheduler** — the §5 app-side ticker (slot-keyed idempotent `dispatch`),
   owned by `RunService` (so both `--web` and the daemon get it); honors the
   §10 catch-up/overlap policy.
5. **Single-instance lock (§8)** — acquire a `.workflows/db/` lock (dagu-style
   dir/`O_EXCL` lockfile + heartbeat + stale-reclaim) *before* `createAbsurdEngine`,
   for **both** `--web` and the daemon; turns double-open from silent corruption
   into a clean error.
6. **`work daemon`/`work schedule` subcommand (§7-9)** — a headless host wrapping
   `RunService` with a `Buffered`/`Jsonl` presenter, no HTTP; foreground, SIGTERM
   drain via existing `whenIdle()`. Document systemd/pm2/launchd for backgrounding.
   Mutually exclusive with `--web` per workspace.
7. **Persistence** — `src/persistence/schedules.ts` (`work.schedules`) mirroring
   `RunRepository`; `ensureSchema()` at the store-init site.
8. **Trigger label** — `"schedule"` into `RunTrigger` (`run-manager.ts:33`,
   `runs.ts:22`) and the `--web` client UI.
9. **Status surface (§9)** — a `work schedules` subcommand (NEXT/LAST per the
   `systemctl list-timers` model) reading `work.schedules`; scheduled runs show
   in `work runs`/`work logs` and the `--web` history for free once tagged.
10. **Scaffolding (optional)** — a `create workflow --schedule "<cron>"` flag that
    injects an `on: schedule` block via `injectAfterName`
    (`scaffold/templates.ts:154`), parallel to `webhookTriggerBlock`.
11. **e2e** — a `test/e2e/` scheduled-workflow example + parse/scheduler unit
    tests (cron validation, next-fire math, catch-up/overlap policy, idempotent
    fire, single-instance lock).
12. **Docs-site** — user-facing `on: schedule` + `work daemon` reference pages
    (this doc is the maintainer record only).

The downstream `dispatch → startRun → Runtime.run` path is unchanged; the work is
the spec opt-in, the `RunService` extraction, the §5 app-side ticker, the
single-instance lock, and persistence/UI labeling — all converging on **one
shared host** so web/CLI/daemon never diverge.
