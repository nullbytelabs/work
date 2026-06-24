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
> added the *hosting* question, and **Pass 3** validated every load-bearing claim
> against the code (Appendices A-F) and **reframed §7**: the scheduler is a module
> inside one long-lived host, **`work serve`** (an API server + console client) —
> there is no separate daemon and no `RunService` subsystem extraction. The
> prior-art survey (cron, anacron, systemd timers, dagu, n8n, GitHub Actions
> runner, Airflow, Windmill, Temporal, pm2) and catch-up/overlap analysis stand.
>
> Tags used throughout: **VALIDATED** (grounded in our code, file:line) /
> **VERIFIED** (cited external standard/vendor doc) / **PROPOSED** (a design
> choice) / **NEEDS-BUILDING** (net-new engine work). Appendices A-F record the
> Pass-3 validation (local experiments + source checks).
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
   PGLite *"runs in Postgres single-user mode, which means a single connection"*
   ([Electric — PGlite v0.4](https://electric.ax/blog/2026/03/25/announcing-pglite-v04)),
   an architecture it adopts because Emscripten-compiled programs cannot fork new
   processes — so there is no postmaster to spawn background workers
   ([PGlite — How it works](https://pglite.dev/docs/about#how-it-works)).
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
long-lived host** (the `serve` process of §7) that, each tick, computes which cron
slots are due and dispatches them with a **slot-derived idempotency key**.

```
// in the scheduler module serve boots, every ~30s while the host runs:
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

- **Driver placement:** the ticker is the standalone scheduler module `serve`
  boots (§7); it runs only while the host is up — which is exactly when a worker
  is polling. There is **no** `sleepUntil`, no
  self-rescheduling task chain: the slot key, not a journaled wait, is what makes
  it safe. (Pass 1's `sleepUntil` ticker was a non-documented construction and is
  dropped.)
- **Cron math:** "is a slot due this tick?" is computed from the expression with
  the parser of §12. Persist `last_fired_at` in `work.schedules` (§6); the status
  surface (§9) computes next-fire from the cron on demand.
- **Not self-durable across downtime** — like cron and like Absurd's own pattern,
  a slot that elapses while the host is down is simply not dispatched. There is no
  catch-up (§10): on restart `seedBaselines` re-baselines to "now" and the schedule
  resumes at the next future slot.

---

## 6. Where the scheduler lives — `serve` lifecycle & persistence

There is exactly one long-lived process, and it's the HTTP host: today's
`work --web`, which §7 reframes as **`work serve`** (an API server + console
client). The other commands are one-shot (`run`, `graph`, `resume`, `rerun`,
`logs`, `doctor`, `create`, `init` — CLI surface confirmed at `cli.ts:331-360`,
`:590-593`; only `--web` stays alive, and there is **no** `daemon`/`serve`/
`schedule` subcommand today — net-new). The scheduler **boots inside `serve`** as
a standalone module wired to `runManager.dispatch` — it does not get its own
process and does not need the HTTP layer to function (it's the §5 internal
ticker). The lifecycle seams below are exactly where the server already boots its
other long-lived machinery, so the scheduler slots in beside them. VALIDATED.

**Lifecycle seams** (`src/web/server.ts`):

- **Construct** after the RunManager (`:122-130`), gated on
  `ownsEngine && opts.dataDir` — the same gate the durable repositories use
  (`:101-120`), since PGLite is single-process and only the owned-engine path
  persists.
- **Start** after `listen` + the existing `reconcileInterruptedRuns` boot step
  (`:223`) — the scheduler's boot re-baselining (`seedBaselines`) sits alongside
  that reconciliation as the other boot-time fixup.
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
string → read via `Number(...)`). Columns `(workflow text, cron text,
last_fired_at bigint)`. On boot, `seedBaselines` resets `last_fired_at` to "now",
so slots missed during downtime are dropped (no catch-up, §10). Under the §5 design
this table **is** the schedule's source of truth (there is no sleeping Absurd task
holding state): the ticker reads it to compute due slots and writes `last_fired_at`
on each dispatch. VALIDATED.

---

## 7. One host: `work serve` (API server + console client)

> **Reframed (2026-06-15).** An earlier draft proposed extracting a transport-free
> `RunService` so that `--web` and a *separate headless daemon* could share a core
> without diverging. Fact-finding (Appendix F) collapsed that: there is no second
> long-lived host. The single-process constraint (§8) means a long-lived host must
> expose an API anyway to be inspectable, so the one honest model is **`work
> serve`** — the existing web server, doing double duty as API + webhook receiver
> + console + scheduler. With one host there is **nothing to diverge from**, so the
> large `RunService` subsystem extraction is **retired**; what remains is a small
> standalone scheduler module.

The mental model is three layers, and the middle one is an *API*, not a UI:

1. **Run core** — `startRun()` (`src/run.ts:82`) is the one place a compiled plan
   becomes a result; the CLI (`cli.ts:698`) and the web `RunManager`
   (`run-manager.ts:202`) already call it identically, borrowing presentation via
   `opts.hooks` (`run.ts:170`) and the engine conditionally
   (`ownsEngine`, `run.ts:119`). No network. The scheduler feeds this path like
   any other trigger.
2. **HTTP API** (`work serve`) — the inbound surface: run query/control + status
   (`/api/*`, JSON + SSE) **and** the webhook receiver (`/hooks/*`). Two trust
   zones on one loopback listener (Appendix F / §8): `/api/*` is loopback +
   CSRF-gated; `/hooks/*` is exempt and authenticates cryptographically, reached
   from outside via a tunnel. Both already exist.
3. **Console** — `client.ts` is a static SPA served at `/`, a pure *client* of the
   API (Appendix F). Optional (`--no-console` if ever wanted); not a separate mode.

**What `serve` is, concretely:** today's `startWebServer` (`server.ts`) plus the
§5 scheduler, renamed. Its prologue already does everything a long-lived host
needs — engine boot + ownership, durable-store `ensureSchema`, `RunManager`
construction, `reconcileInterruptedRuns` (`server.ts:815-843`, crash-resume on
startup, already dependency-injected), and the `whenIdle()` → `engine.close()`
drain. The `RunManager` (`run-manager.ts:111`) — concurrency cap + FIFO queue +
load-shed, `inFlight` + `whenIdle()` drain, durable history — stays exactly as is;
its SSE fan-out and `WebPresenter` are simply part of `serve`, not something to be
abstracted away for a second consumer that no longer exists.

**The only new structuring** (NEEDS-BUILDING, small): the scheduler is a
**standalone module** the `serve` prologue constructs and starts (per the §6
lifecycle seams), taking `runManager.dispatch` injected as a function. That keeps
it unit-testable without booting HTTP and tangles it into no route handler — the
clean seam, without a new `src/service/` subsystem, a presenter-pluggable
`RunManager`, or an `SseHub` split. The scheduler is just one more trigger source
feeding the already-shared `dispatch → startRun` path, exactly as the webhook
receiver is today.

---

## 8. One owner per workspace — the scheduler lives in the engine-owning process

`work` is single-process per workspace: one host owns a workspace's
`.workflows/db` engine at a time, and `--web` and the CLI (or two hosts) don't run
against the same workspace concurrently. This is a **settled, accepted operating
assumption** of the project — not a constraint to solve here.

The only design consequence that matters for scheduling: the scheduler **lives
inside that single engine-owning process** — `work serve` (§7) — alongside the
RunManager and the other triggers, exactly where the server already puts them. This
is the *combined single-process* model local schedulers ship for dev use (dagu
`start-all`, Airflow `standalone`, Temporal `start-dev`, Windmill `MODE=standalone`);
tools that split a standalone scheduler from their server can only do so because
they sit on a concurrent database, which we don't. So the constraint is actually
**clarifying**: there is one long-lived host (`serve`), and the scheduler is a
module inside it — no second process, no parallel scheduler/server implementations
to keep from diverging. A further consequence (§7): because a long-lived host must
expose an API to be inspectable under single-process, `serve` *is* the API server —
which is why there's no separate headless daemon.

*Optional guardrail (not a prerequisite):* a dagu-style filesystem lock under
`.workflows/db/` acquired before the engine opens would turn an accidental
double-launch into a clean error instead of letting it through. It's a small,
late, take-it-or-leave-it add — never a gate on the scheduler work, and orthogonal
to it.

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
  they run in the foreground and lean on systemd/launchd/Docker/pm2. → `work serve`
  runs in the foreground and documents systemd/pm2/launchd for backgrounding — not
  its own double-fork. `work`'s existing SIGINT/SIGTERM → `close()` → `whenIdle()`
  drain (`cli.ts:355-359`, `server.ts:782-797`) already matches the SIGTERM +
  ~30s-drain convention (n8n 30s, dagu 30s).
- **A combined single-process mode is the local norm** (`start-all`/`standalone`/
  `start-dev`). `work serve` is exactly that: engine + RunManager + scheduler +
  webhook receiver + console in one foreground process. There is no separate
  headless daemon (§7).
- **If** a single-instance guard is ever wanted, a dagu-style filesystem lock is
  the fitting shape (we have no concurrent DB to lock against, unlike
  Airflow/Windmill) — but it's an optional guardrail, not a requirement (§8).
- **`systemctl list-timers` is the model for the status *content*** (NEXT / LAST per
  schedule) — but **not for a CLI command**. Scheduling exists only inside a running
  `serve` host, and that host owns the workspace's `work.schedules` exclusively
  (single-process, §8), so a separate `work schedules` process reading the DB would
  be the double-open hazard, not a feature. The status surface is therefore a
  **`GET /api/schedules` endpoint + a console panel** (NEXT/LAST), read *through* the
  host like `/api/runs` already is — never a DB-opening CLI. Execution detail stays
  in the console run history (and `work runs`/`work logs` when serve is down).

---

## 10. Catch-up after downtime & overlap — skip, no catch-up

The single most divergent design axis across the prior art, so it warrants an
explicit decision rather than an accident of implementation.

**The spectrum** (VERIFIED): no catch-up — cron, n8n, Windmill, pm2 (skip the
miss, resume at the next future occurrence); opt-in catch-up — systemd
`Persistent=` (default off), dagu `catchupWindow` (default off), Airflow
`catchup` (**flipped from True→False in 3.x precisely because surprise backfill
floods burned people**); catch-up by design — anacron (its entire reason to
exist, for machines not on 24/7) and **Temporal `catchupWindow` (default 1 year,
min 10s)**.

**Decision: skip, full stop — no catch-up, not even opt-in.** A slot that elapses
while the host is down is dropped; on restart the schedule resumes at the next
future occurrence (`seedBaselines` re-baselines every schedule to "now"). This
matches the modern consensus (Airflow's deliberate 3.x flip; cron/n8n/Windmill)
and avoids a thundering herd of historical gondolin runs the first time a long-down
workspace comes back up — especially important here, where every fire is a full
micro-VM. A configurable catch-up window (Temporal/dagu-style) was considered and
**rejected**: it's surface area we don't need — if a missed run matters, trigger it
by hand. The schema stays `{ cron }`, with no catch-up field.

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
- **Missed-slot & overlap policy** — see §10: missed slots are **skipped** with no
  catch-up (`seedBaselines` re-baselines on boot), and overlap defaults to **skip**.
  `last_fired_at` (the `work.schedules` source of truth, §5/§6) is the baseline.
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
   re-export. Validate cron at parse time. The entry schema is `{ cron }` — no
   catch-up field (§10).
2. **Dependency** — add `croner` to `dependencies` (no build-script change;
   `packages:"external"` handles it).
3. **Rename `--web` → `work serve`, scheduler as a module (§7)** — promote the
   long-lived server to a `serve` subcommand (keep `--web` as an alias if wanted)
   and have its prologue construct + start a **standalone scheduler module**
   taking `runManager.dispatch` injected. No `src/service/` subsystem, no
   `RunManager` presenter-refactor, no `SseHub` split — the full `RunService`
   extraction is retired (one host, nothing to diverge from). `startRun`,
   `RunManager`, and the HTTP layer are untouched.
4. **Scheduler** — the §5 app-side ticker (slot-keyed idempotent `dispatch`),
   the module from step 3; honors the §10 skip + overlap policy. Unit-testable
   with a fake `dispatch`, no HTTP needed.
5. **Single-instance lock (§8, optional / not a gate)** — a `.workflows/db/` lock
   acquired before the engine opens would turn an accidental double-launch into a
   clean error. Single-instance is already an accepted operating assumption, so
   this is a take-it-or-leave-it guardrail, independent of and not blocking the
   scheduler work.
6. **`work serve` ergonomics (§7-9)** — foreground, SIGTERM drain via existing
   `whenIdle()`; document systemd/pm2/launchd for backgrounding. Stays
   loopback-bound (`server.ts:869`); webhooks reach it via a tunnel, not a
   `--host` flag (Appendix F). Optional `--no-console` to skip serving the SPA.
7. **Persistence** — `src/persistence/schedules.ts` (`work.schedules`) mirroring
   `RunRepository`; `ensureSchema()` at the store-init site.
8. **Trigger label** — `"schedule"` into `RunTrigger` (`run-manager.ts:33`,
   `runs.ts:22`) and the `--web` client UI.
9. **Status surface (§9)** — a `GET /api/schedules` endpoint + a `serve` console
   panel (NEXT/LAST per schedule, `systemctl list-timers` content), read through the
   running host. **No CLI command** — scheduling is a serve-mode concept and the
   host owns the DB exclusively (a separate reader is the double-open hazard, §8).
   Scheduled runs already show in the console history (and `work runs`/`work logs`
   when serve is down) for free once tagged.
10. **e2e** — a `test/e2e/` scheduled-workflow example + parse/scheduler unit
    tests (cron validation, next-fire math, skip-on-restart, overlap policy,
    idempotent fire).
11. **Docs-site** — user-facing `on: schedule` + `work serve` reference pages
    (this doc is the maintainer record only).

The downstream `dispatch → startRun → Runtime.run` path is unchanged; the work is
the spec opt-in, the `--web` → `work serve` rename with a scheduler module, the §5
app-side ticker, and persistence/UI labeling — all inside **one host** (`serve`),
so there are no parallel implementations to keep from diverging.

---

## Appendix A — §7 validation (local, 2026-06-15)

Three parallel readers checked every file:line in §7 against the branch. **All
line references are exact (no drift); every structural claim holds.** Material
findings:

> *Note (Pass 3):* this appendix validated the original `RunService`-extraction
> framing. §7 was later reframed to the lighter `serve` model (Appendix F), which
> **retires** the extraction. The underlying *facts* below are unchanged and still
> load-bearing — they're now the reason the rename is cheap rather than the reason
> an extraction is safe. Mentions of "the extraction seam"/"§7 step 1" read as the
> historical motivation.

- **`startRun` is genuinely the sole plan→result path** (CONFIRMED). Defined
  `run.ts:82`; CLI call `cli.ts:698`; web `RunManager.launch` call
  `run-manager.ts:202`. It owns work-root lifecycle (`run.ts:86-89`, cleanup
  `:178`), `uses:` handler composition (`:100-113`), egress composition
  (`:148-151`), `AbsurdRuntime` construction (`:145-163`), borrows presentation
  via `opts.hooks` (`:170`), and conditionally owns the engine
  (`ownsEngine = opts.engine === undefined`, `:119`).
- **Nuance on "same option shape"** (PARTIALLY-VALID → sharpened): the two call
  sites share the core fields (`plan`, `workspaceSource`, `workflowDir`, `config`,
  `runId`, `hooks`) but diverge exactly on the **engine-ownership
  seam** — CLI passes `dataDir`/`workdir` (owns + persists its own engine), web
  passes `engine`/`makeTarget` (borrows the shared one). This *reinforces* the
  §7 design: `RunService` is precisely the missing owner of that seam.
- **Presenter/hooks seam is fully pluggable** (CONFIRMED). `RunHooks`
  (`runtime/types.ts:43-50`) is a pure interface; the runtime imports no
  presenter. `Presenter` interface at `tui/presenter.ts:20-25`; four impls —
  `NullPresenter`/`BufferedPresenter`/`LayeredPresenter` (`tui/presenter.ts`) and
  `WebPresenter` (`web/web-presenter.ts:49-116`). Dependency flow is strictly
  one-way (presenters → runtime); the **only** presenter coupling in the run path
  is the hard-coded `new WebPresenter(...)` at `run-manager.ts:177` — exactly the
  seam §7 step 1 targets.
- **`RunManager` web coupling is as narrow as claimed** (CONFIRMED). Class at
  `run-manager.ts:111`. Generic core: concurrency cap + load-shed
  (`:157-160`; defaults **maxConcurrent 4** `:108`, **maxQueued 100** `:109`),
  FIFO queue (`:125`, drain `:262-268`), `inFlight` set (`:135`) + `whenIdle()`
  drain (`:243-248`). A grep for `ServerResponse`/`http`/`res.` found **only two**
  web couplings: `RunRecord.subscribers: Set<ServerResponse>` + `broadcast`/
  `subscribe` (`:274-303`), and the `WebPresenter` instantiation (`:177`). Both
  are the seams §7 step 1 already names — no hidden third coupling.
- **`reconcileInterruptedRuns` is already dependency-injected** (CONFIRMED,
  `server.ts:815-843`): it takes `{ runStore, workspace, dispatch }` and is wired
  at `:223` with `dispatch: (o) => runManager.dispatch(o)`. It lifts into
  `RunService` unchanged — and is the direct structural analog of the §5/§10
  boot re-baselining (`seedBaselines`).
- **Supporting material for §5**: `dispatch(opts: DispatchOptions)` (`:154`)
  **already accepts a caller-supplied `runId`** — `DispatchOptions.runId?` with
  the comment *"Caller-supplied run id (tests pin it); minted when omitted,"*
  consumed as `opts.runId ?? randomUUID()` (`:155`). The §5 slot-keyed-`runId`
  dispatch needs **no signature change** to `dispatch`. `RunTrigger =
  "dispatch" | "webhook"` confirmed at both `run-manager.ts:33` and
  `persistence/runs.ts:22` (the §11 `"schedule"` addition is a two-line change).

**Verdict:** §7 is sound as written. The extraction is real refactoring work, but
every seam it relies on (shared `startRun`, pluggable hooks, narrow `RunManager`
coupling, injected reconcile, caller-supplied `runId`) exists today as claimed.

---

## Appendix B — §5 validation (local, 2026-06-15)

Two readers + **one live experiment** (booting the project's own in-memory Absurd
engine — PGLite, no QEMU) checked the slot-keyed exactly-once mechanism. **The
core dedup is empirically proven; the threading claims are exact; the one gap §5
flags is real and correctly scoped.**

- **Threading is exactly as claimed** (CONFIRMED). `RunContext.runId`
  (`runtime/types.ts:76`, *"web layer mints this up front… defaults to a random
  UUID… the CLI path"*) → extracted at `runtime/absurd/runtime.ts:194`
  (`const runId = ctx.runId ?? randomUUID()`) → spawned at `runtime.ts:249`:
  `app.spawn(orchTaskName, {}, { queue: QUEUE, idempotencyKey: runId })`. Exact
  line, exact shape.
- **Dedup proven empirically** (CONFIRMED — live run). Three spawns, two distinct
  idempotency keys, against `createAbsurdEngine`:

  ```
  spawn A (key=slot0): { taskID: …038b, created: true  }
  spawn B (key=slot0): { taskID: …038b, created: false }   ← identical taskID
  spawn C (key=slot1): { taskID: …06c5, created: true  }
  A.taskID === B.taskID → true ;  A.taskID === C.taskID → false
  absurd.t_default: 2 rows total for 3 spawns (1 per distinct key)
  ```

  So overlapping ticks / crash-restart within one slot collapse to a single task,
  exactly as §5 needs. Dedup happens **at `spawn` (the insert), not at
  claim/execute** — no worker need run. Mechanism confirmed in source too:
  `SpawnResult.created:boolean` (`absurd-sdk/dist/index.d.ts:82`); the per-queue
  insert returns `false` + the **existing** taskID on conflict (`schema.sql:776`);
  and `runtime.ts:250-251` already branches on `!spawned.created`.
- **Watch-out surfaced by the experiment** (NEW): on a duplicate key the second
  spawn's **payload is discarded** — the original task's params win. Harmless for
  cron (the payload is just `scheduledFor`, derivable from the slot), but worth
  stating so no one later relies on per-fire payload variation through the same
  slot key.
- **`SpawnOptions` has no scheduling field** (CONFIRMED): the full set is
  `maxAttempts, retryStrategy, headers, queue, cancellation, idempotencyKey`
  (`index.d.ts:22-29`) — no `runAt`/`scheduleAt`, no recurring API. `ctx.sleepUntil`
  exists (`index.d.ts:247`) but is a `TaskContext` suspend primitive, unrelated to
  spawn dedup — §5 correctly drops it.
- **The `RunManager` short-circuit gap is real, and sharper than stated**
  (CONFIRMED NEEDS-BUILDING, with nuance). The durable layer is *already*
  idempotent on `runId`: `work.runs.run_id` is a PRIMARY KEY and
  `RunRepository.insert` uses `on conflict (run_id) do nothing`
  (`persistence/runs.ts:61,85`) — so **history will not double-count**. The gap is
  purely **in-memory**: `dispatch` unconditionally does `this.runs.set(id, record)`
  + `this.order.push(id)` (`run-manager.ts:172-173`) with no existing-id check, so
  a re-dispatch of a live slot id duplicates the `order` entry and can fire a
  second `launch()` that races the first on `record.status`/`ring`. Absurd's spawn
  still collapses the *actual* run to one task — but the bookkeeping needs the
  short-circuit §5 calls for. Net: the claim is accurate; the fix is a one-line
  `if (this.runs.has(id)) return …` guard in `dispatch`, not a structural change.

**Verdict:** §5's design rests on a mechanism that **works as described and is now
demonstrated**, not just cited. The single NEEDS-BUILDING item (RunManager
short-circuit) is confirmed real and is a small, well-localized guard.

---

## Appendix C — §8 validation (local, 2026-06-15)

Single-instance is an accepted given (see §8); the only thing worth confirming is
the *design consequence*. The socket server is genuinely process-local — its
loopback port is `49152 + Math.floor(Math.random() * 16000)` chosen fresh per boot
(`engine.ts:71`) and never exported/persisted — so a second process could never
share the engine, which is *why* there is exactly one long-lived host (`work
serve`, §7) with the scheduler as a module inside it. The optional guardrail lock
is unbuilt and remains optional. No further litigation of the single-process model
is needed.

---

## Appendix D — §3 validation (local, 2026-06-15)

A reader + **a live parse run** (`parseWorkflow` over three real YAML strings)
checked the spec-surface asymmetry. **Every claim is exact — including the
predicted error string — and the two-path behavior reproduces precisely.**

- **`OnSpec` has only `webhook?` / `workflow_call?`** (CONFIRMED, `types.ts:183-186`)
  — no `schedule`; no `parseSchedule` exists anywhere in `src/` (grep-empty).
- **The asymmetry reproduces exactly** (CONFIRMED — live `parseWorkflow`):
  - **Bare `on: schedule` → throws.** `WorkflowParseError`, message
    `on: unknown trigger "schedule" (supported triggers are "webhook",
    "workflow_call")` — matches the doc's predicted text verbatim
    (`parse.ts:226`).
  - **Mapping `on: { schedule: [{ cron: '…' }] }` → parses, silently dropped.**
    Result is `spec.on = {}`; the `schedule` key and `cron` value never appear
    anywhere in the spec. No error.
  - Baseline (no `on:`) control → `spec.on === undefined`, harness sane.
- **The mechanism is deliberate** (CONFIRMED): `parseOn` (`parse.ts:219-239`)
  handles the two forms differently by design — the string branch enumerates the
  two known names and throws otherwise (`:226`); the mapping branch is explicitly
  *"Be liberal: pass through unknown trigger keys untouched"* (`:233-238`), copying
  only `webhook`/`workflow_call` and never inspecting other keys. So **both paths
  need updating** as §3 says: add `schedule` to the string allow-list *and* the
  mapping dispatch; the mapping form is the real target.
- **The `on` doc comment is exactly as flagged** (CONFIRMED, `types.ts:192`):
  *"Trigger declaration (`on:`). Validated but not acted on by the engine; the
  webhook receiver reads it."* — §3 correctly notes this must change for
  `schedule` (which *is* consumed by execution machinery).

**Verdict:** §3 is precise to the error message. The "additive hook points" framing
holds, with one sharpened point: the silent-drop is not an oversight to route
around but an intentional liberal-passthrough that the `schedule` work must
explicitly close for this one key (validating cron at parse time, per §3).

---

## Appendix E — §4/§4a validation (local + sources, 2026-06-15)

A schema reader + **a live `CREATE EXTENSION pg_cron` probe** + an external
citation fact-check verified the "Absurd has no scheduler; pg_cron is unavailable"
argument. (The `SpawnOptions`/`created:false` half is covered in Appendix B.)
**The thesis holds and the schema claims are exact; one external citation was
mis-attributed and has been corrected in §4a.**

- **`spawn_task` schema claims exact** (CONFIRMED). `absurd.spawn_task(p_queue_name,
  p_task_name, p_params, p_options)` returning `(task_id, run_id, attempt, created)`
  at `schema.sql:682`; header comment *"Task execution flows through `spawn_task`"*
  at `:19`. So §4a's correction of pass 1 (a SQL-side spawn is a *supported* entry
  point, not a private-table bypass) is right.
- **pg_cron is used only for guarded maintenance** (CONFIRMED, *stronger* than
  stated). Every `cron.` reference is behind a `to_regclass('cron.job')` check —
  and there are **more guards than §4a cited** (`:359, 2613, 2634, 2642, 2692,
  2911, 3039`). `enable_cron` (`:2857`) schedules exactly three jobs (`:2985-2995`)
  — partition maintenance, queue cleanup, detach planning — and **zero user task
  runs**. No unguarded `cron.` call exists.
- **pg_cron genuinely cannot load on our PGLite** (CONFIRMED — live probe, v0.5.1):

  ```
  pg_cron in pg_available_extensions: []
  CREATE EXTENSION pg_cron  →  ERROR: extension "pg_cron" is not available
  to_regclass('cron.job')   →  null
  available extensions      →  plpgsql
  ```

  So the guards are inert on our engine, exactly as claimed. **Precision finding**:
  the *operative* blocker is §4a reason 3 (PGLite ships only WASM-compiled
  extensions; pg_cron isn't one) — the extension is rejected as "not available"
  *before* the background-worker / `shared_preload_libraries` concerns (reasons 1-2)
  are ever reached. All three reasons are true, but they are not sequential gates:
  reason 3 fires first. The three-reason structure is still sound as defense in
  depth.
- **External citations: 3 of 4 accurate, 1 corrected** (sources fetched).
  Reason-1 (pg_cron README: *"creates a background worker"* + `shared_preload_libraries`
  *"required to load pg_cron background worker on start-up"*) — accurate verbatim.
  Reason-2's *PostgreSQL* property (`shared_preload_libraries` ignored under
  `--single`: PostgresMain bypasses `process_shared_preload_libraries()`) — accurate
  to the pgsql-hackers message, and the unresolved thread *strengthens* the point.
  Reason-3 catalog (pglite.dev lists pgvector/pg_uuidv7/PostGIS/AGE, **not** pg_cron)
  — accurate (42-extension catalog, pg_cron absent). **Defect found & fixed**: the
  v0.4 blog was quoted as saying Emscripten/WASM *"cannot fork new processes"* and
  *"eliminates the need for background workers or the postmaster process"* — those
  phrases are **not** in that blog (it supports only *"single-user mode … a single
  connection"*). The fork/no-postmaster explanation lives in PGlite's
  *How it works* docs. §4a now cites the blog for single-connection and PGlite's
  architecture docs for the fork rationale; the underlying fact was always true,
  only mis-sourced.

**Verdict:** §4's core — Absurd ships no scheduler, the only available pattern is
app-side `spawn` + slot idempotency, and pg_cron is off the table on PGLite — is
correct and now empirically demonstrated end to end. The lone issue was a quotation
mis-attribution in §4a, corrected in place.

---

## Appendix F — the `serve` reframe (local, 2026-06-15)

Three readers checked the existing web server to decide whether an API-first
single-host model (`work serve`) is sound, and the findings **reframed §7** —
retiring the `RunService` extraction. The shift is mostly a rename; the structure
is already there.

- **The server is already an API + static client** (CONFIRMED, agent A). Route
  table at `server.ts:275-288`: `/api/*` returns JSON (`sendJson`), `/api/runs/:id/
  events` is SSE, `/` serves one static `client.ts` SPA shell with a stateless CSRF
  token — no server-side rendering, no sessions. The console is a pure HTTP client
  of the API. Recasting "web layer" → "API server + console client" is a **rename,
  not a refactor**.
- **The two trust zones already exist** (CONFIRMED, agent B — the load-bearing
  one). The loopback `Host`-header check and CSRF gate both test `!isHook`
  (`server.ts:249-260`), so `/hooks/*` is **deliberately exempt** and authenticates
  cryptographically instead — HMAC-SHA256 (`verifyHmacSha256`, `:941-948`,
  `timingSafeEqual`) or bearer (`constantTimeEqual`), fail-closed, with an explicit
  design comment at `:241-246`. So "webhooks reachable from outside while run
  control + console stay loopback" is **built, not net-new**. (Note: only `/hooks/*`
  should be externally reachable; do **not** widen `isHook` to `/api/*`.)
- **Bind is loopback-only by design; webhooks arrive via a tunnel** (CONFIRMED,
  agent C). `server.listen(port, "127.0.0.1", …)` is hard-coded (`server.ts:869`)
  for DNS-rebinding protection; `--port` exists (`cli.ts:103-110`, default 4280),
  `--host` does **not**. The webhook receiver expects a *public* `Host` from a
  tunnel domain — i.e. external reach comes from a tunnel forwarding to loopback,
  **not** from binding `0.0.0.0`. So `serve` keeps the loopback bind; there is no
  `--host` to add. (Better for a minimal attack surface.)
- **No `serve`/`daemon`/`schedule` scaffolding exists** (CONFIRMED, agent C) — net
  new, but small: a subcommand wrapping the existing server + the scheduler module.

**Consequence — why §7's extraction is retired:** the extraction's whole purpose
was to keep `--web` and a *separate* headless daemon from diverging. But the
single-process constraint (§8) means any long-lived host must expose an API to be
inspectable (you can't run `work runs` against a workspace another process owns) —
so the one honest model is a single API-serving host, `work serve`. With no second
host, there is nothing to diverge from, and the `src/service/` subsystem +
presenter-pluggable `RunManager` + `SseHub` split are over-engineering. What's left
is a standalone scheduler module the `serve` prologue boots — a small seam, not a
spine. The collapse *reduces* surface: one new long-lived verb, not two hosts.

**Verdict:** the API-first `serve` model is sound and largely pre-built. The CLI
becomes `work run` (one-shot) + `work serve` (long-lived: API + webhooks +
scheduler + console). §§6-9, 14 updated to match.
