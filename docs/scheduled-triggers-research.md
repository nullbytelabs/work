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
> builds on [`absurd-durable-workflows.md`](absurd-durable-workflows.md) §10 and
> [`durable-orchestrator.md`](durable-orchestrator.md) — durability rides Absurd's
> `sleepUntil` primitive, not an external `pg_cron`.
>
> Written pre-implementation (2026-06-15); consolidates four parallel
> investigations (trigger/spec surface, Absurd timing primitives, web-server
> lifecycle/persistence, cron syntax + library prior-art).
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

## 4. Absurd can schedule its own wake-ups — via `sleepUntil`, nothing else

The most important finding for durability. Verified against `absurd-sdk@0.4.0`
(`dist/index.d.ts`/`index.js`) and our vendored schema.

**Absurd has exactly one durable-timing primitive:**

- `ctx.sleepUntil(stepName, wakeAt: Date)` (`index.d.ts:247`) and
  `ctx.sleepFor(stepName, seconds)` (`index.d.ts:241`).

There is **no** native cron, recurring/periodic task, or `runAt`-at-spawn-time.
`SpawnOptions` (`index.d.ts:22-29`) has only `maxAttempts`, `retryStrategy`,
`headers`, `queue`, `cancellation`, `idempotencyKey` — **you cannot tell
`spawn()` to fire at a future time.** The `pg_cron` references in
`src/runtime/absurd/schema.sql` (e.g. `:2857`) are strictly for queue
partition maintenance/cleanup — *not* for triggering user runs — and PGLite has
no `pg_cron` anyway. VALIDATED.

**How `sleepUntil` is durable** (`index.js:150-161`): it checkpoints the wake
time (survives crash/replay — on resume it re-reads the *stored* `wakeAt`),
calls `absurd.schedule_run` which sets the run to `state='sleeping'`,
`available_at = wakeAt` (`schema.sql:1059-1103`), then throws `SuspendTask` to
unwind the handler. The worker claim query picks up runs
`where state in ('pending','sleeping') and available_at <= now()`
(`schema.sql:932-942`), so a sleeping run becomes claimable **automatically the
moment its wake time passes** — re-running the handler from the top, where
completed steps replay from cache and `sleepUntil` now returns immediately.

**The one genuine limitation:** wake-up is driven solely by the **worker poll
loop** (`index.js:665-694`; this repo polls at 0.05s, `runtime.ts:239-240`).
There is no timer thread — *a sleep only fires while a worker is polling its
queue.* So a scheduler must live where a worker is persistently alive: the
**web server's shared engine**, not the per-run ephemeral runtime, which closes
its workers when the run ends (`runtime.ts:261-262`). VALIDATED.

---

## 5. Two viable designs

### Option A (recommended) — a self-rescheduling durable "ticker" task

Model each schedule as a short durable task that computes the next fire, sleeps
to it, fires the run, then tail-spawns the next tick:

```
registerTask("cron:<workflow>", async (params, ctx) => {
  const nextAt = await ctx.step("compute-next",
    () => nextCronTime(params.expr, params.fromISO));   // our cron math
  await ctx.sleepUntil("wait", new Date(nextAt));        // durable suspend
  await ctx.step("fire",
    () => dispatchRun(workflow, { idempotencyKey: `cron:<wf>:${nextAt}` }));
  await ctx.step("reschedule",
    () => app.spawn("cron:<wf>", { expr, fromISO: nextAt },
                    { idempotencyKey: `cron:<wf>:tick:${nextAt}` }));
});
```

- **Durable across restarts:** the wake time is journaled; a re-claim resumes the
  suspended tick and fires on time (or immediately, if the time already passed
  while down — `nextCronTime` decides catch-up vs. skip-missed).
- **Exactly-once:** `idempotencyKey` keyed on the fire timestamp dedups both the
  fire and the chaining across crashes/replays (`spawn` returns `created:false`
  for a dup).
- **Bounded journals:** tail-spawning a fresh tick per fire keeps each task's
  journal small. A single `while(true){ sleepUntil; ... }` loop also works but
  accumulates unbounded `sleepUntil#N` checkpoints in one run — avoid for an
  indefinitely-recurring schedule.
- **Queue placement:** the ticker lives on the `default` (or its own) queue with
  a persistently-running worker at server boot — *not* the per-run
  orchestrator/jobs queues that come and go.

This is the only way to get Absurd to "schedule the next fire itself," and it
needs no external services — it fits the long-lived web-server model exactly.
NEEDS-BUILDING.

### Option B — an external in-process ticker

A `setInterval` in the web server that, on each tick, checks which schedules are
due and calls `RunManager.dispatch`. Simpler to write and reuses the existing
trigger machinery, but **the schedule itself is not durable** — a window missed
while the process is down is just gone, with no journaled record of intended
fires. Acceptable only if "best-effort while the server is up" is the bar.

**Recommendation:** Option A for durability, but note both share the same
*discovery* and *dispatch* seams below — Option B is a strict subset, so an
incremental path could ship B first and journal it into A.

---

## 6. Where the scheduler lives — web-server lifecycle & persistence

The web server is the **only** long-lived process; there is no daemon
subcommand (CLI surface confirmed: `run`, `graph`, `resume`, `rerun`, `logs`,
`doctor`, `create`, `init`, `--web`; only `--web` stays alive — `cli.ts:331-360`,
`:590-593`). So the scheduler belongs inside `startWebServer`. VALIDATED.

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
downtime. With Option A, this table is largely a *projection* for the UI — the
durable truth is the sleeping Absurd task — but it's still wanted for operator
visibility. VALIDATED / PROPOSED.

---

## 7. Dispatch — identical to a webhook fire

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

## 8. Cron parsing — recommend `croner`

No cron or date/time library is currently a dependency (runtime deps:
`@electric-sql/pglite`, `pglite-socket`, `absurd-sdk`, `pg`, `yaml`; time is bare
`Date`). VALIDATED. Constraints: ESM-only (`"type": "module"`), and esbuild keeps
deps external (`scripts/build.mjs`, `packages: "external"`) so the lib resolves
from `node_modules` in a published package — bundle size is irrelevant;
**transitive dependency count matters**.

**Recommend `croner`** (VERIFIED): zero dependencies, first-class ESM + TS,
MIT, actively maintained (v10.0.1, Feb 2026). Crucially it exposes pure
`nextRun(from)` / `nextRuns(n)` / `msToNext()` that work **without** starting its
internal scheduler — exactly the "compute next fire, drive our own durable timer"
model Option A wants. Built-in IANA timezone support covers a future `tz:`.

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

## 9. Durable-cron pitfalls to design around (VERIFIED / PROPOSED)

- **Compute, don't sleep-and-loop.** Persist an absolute `next_fire_at`; on each
  wake recompute the next instant from the expression. Never chain
  `setInterval(period)` — it drifts and double-fires after sleep/clock jumps.
- **Catch-up policy after downtime.** Decide explicitly: **skip** missed (GHA-like,
  fire next future occurrence), **coalesce** many-missed into one, or **backfill
  all**. Recommended default: skip-or-coalesce, never blind replay. `last_fired_at`
  detects the gap. This is the policy `nextCronTime` encodes in §5.
- **Overlap policy.** A prior run may still be executing when the next fire is
  due — choose skip / queue / allow-concurrent. RunManager already has a
  concurrency cap + queue (`run-manager.ts:157-160`) for the queue case; a
  per-workflow in-flight guard gives skip.
- **Timezone / DST.** UTC default (matches GHA). If `tz:` is added: a wall-clock
  time in the DST "spring-forward" gap may not exist (skip) and in "fall-back"
  may occur twice (dedupe) — croner does the math, but we pick the semantics.
  Always store `next_fire_at` as an absolute UTC instant.
- **Minimum interval.** Decide whether to warn (GHA-like ~5-min floor) at parse
  time or allow sub-minute; POSIX is 1-min granularity regardless. If croner's
  optional 6-field (seconds) is ever exposed, document the divergence from GHA.

---

## 10. Scope checklist (NEEDS-BUILDING)

1. **Spec** — `ScheduleTrigger` + `schedule?` on `OnSpec` (`spec/types.ts`);
   `parseSchedule` + bare-string fix in `parseOn` (`spec/parse.ts`); barrel
   re-export. Validate cron at parse time.
2. **Dependency** — add `croner` to `dependencies` (no build-script change;
   `packages:"external"` handles it).
3. **Scheduler** — the §5 Option-A ticker task, owned by `startWebServer`
   (construct/start/stop seams in §6), on a persistently-worked queue.
4. **Persistence** — `src/persistence/schedules.ts` (`work.schedules`) mirroring
   `RunRepository`; `ensureSchema()` at the server's store-init site.
5. **Trigger label** — `"schedule"` into `RunTrigger` (`run-manager.ts:33`,
   `runs.ts:22`) and the `--web` client UI.
6. **Scaffolding (optional)** — a `create workflow --schedule "<cron>"` flag that
   injects an `on: schedule` block via `injectAfterName`
   (`scaffold/templates.ts:154`), parallel to `webhookTriggerBlock`.
7. **e2e** — a `test/e2e/` scheduled-workflow example + parse/scheduler unit
   tests (cron validation, next-fire math, catch-up policy, idempotent fire).
8. **Docs-site** — user-facing `on: schedule` reference page (this doc is the
   maintainer record only).

The downstream `dispatch → startRun → Runtime.run` path is unchanged; the work
is the spec opt-in, the durable ticker, and its persistence/UI labeling.
