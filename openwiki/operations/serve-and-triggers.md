# Serving, Triggers & Observability

Beyond one-shot CLI runs, `work serve` boots a long-lived **local host** for a project: a browser console, an authenticated webhook receiver, and a cron scheduler — one process, the same engine.

## The Web Server (`src/web/`)

`work serve [--workspace <dir>] [--port <n>]` boots an HTTP server bound to **loopback only** (127.0.0.1). Default port: 4280 (retries next ports on EADDRINUSE).

### Security Posture

Layered mitigations against CSRF and DNS-rebinding (`src/web/server.ts`):
- Loopback-only bind — not reachable from the network.
- `Host` header validation — anti-DNS-rebinding (checked against `{127.0.0.1,localhost}:<port>`).
- Startup CSRF token (`X-Work-Token` header required on all POSTs). Constant-time compare via SHA-256 pre-hash (so `timingSafeEqual` always gets equal-length inputs — prevents length-based timing attacks).
- Never emits CORS headers.
- **Webhook routes (`POST /hooks/*`) are exempt** from the Host check and CSRF token — they authenticate cryptographically (HMAC/bearer) instead. This is deliberate: hooks are a server-to-server surface that may arrive via a tunnel with a public `Host` header and no browser CSRF token.
- **Body size caps**: 256 KB on both API (`MAX_API_BODY_BYTES`) and webhook (`MAX_HOOK_BODY_BYTES`) bodies. Oversized payloads abort the stream (`readBodyCapped` destroys it).

### API Routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/` | Serves the inline frontend (`src/web/client.ts`) |
| `GET` | `/api/workflows` | Workflow discovery |
| `GET` | `/api/workflows/:name/form` | Input schema for a workflow |
| `GET` | `/api/workflows/:name/graph` | DAG layout (emitGraph JSON) |
| `POST` | `/api/runs` | Dispatch a run → 202 (async) |
| `GET` | `/api/runs` | Run history |
| `GET` | `/api/runs/:id/events` | SSE live tail + replay |
| `POST` | `/api/runs/:id/rerun` | Fresh run with same inputs |
| `POST` | `/api/runs/:id/retry` | Re-run only failed jobs |
| `GET` | `/api/schedules` | Schedule list |
| `GET` | `/api/webhooks` | Webhook list |
| `GET` | `/api/webhooks/:name/deliveries` | Delivery audit log |
| `POST` | `/api/webhooks/:name/test` | Synthetic webhook test fire |
| `POST` | `/hooks/:name` | Webhook receiver (HMAC/bearer auth + dedup) |

### RunManager (`src/web/run-manager.ts`)

The long-lived run registry. Mints run IDs, tracks `RunRecord` (status, subscribers, bounded replay ring capped at 2000 frames, monotonic seq for durable event ordering). Dispatches runs **in the background** (not awaited) so `POST /api/runs` returns 202 immediately. The DAG is seeded via `presenter.start(plan)` immediately on dispatch — even while a run is queued, an SSE subscriber sees the graph before the run starts. `seq` is minted synchronously before the async `eventStore.append`, ensuring durable frame order matches in-memory order even under concurrent appends.

- `maxConcurrentRuns` default: 4
- `maxQueuedRuns` default: 100 (→ 429 when exceeded)
- Supports durable `RunRepository` + `RunEventRepository` for history surviving restart.

### Slot Reservation

`tryReserve()` / `releaseReservation()` hold a concurrency slot *before* a caller does irreversible work. `dispatch({ reserved: true })` then consumes the held slot — a reserved dispatch is always admitted and never shed. This exists for the retry path: `resetFailedJobs()` deletes the failed jobs' task/checkpoint rows from the durable journal (which can't be reconstructed), so the retry must reserve a slot **before** clearing the journal. If capacity is full, it 429s with the journal untouched; otherwise the reservation guarantees the subsequent dispatch is admitted, avoiding a zombie run (journal wiped, status `running`, nothing relaunched).

### WebPresenter (`src/web/web-presenter.ts`)

A pure translator implementing the `RunHooks` interface — converts runtime events into SSE `Frame` objects (`job-start`, `step-start`, `step-output`, `step-end`, `job-end`). Seeds the DAG via `emitGraph` JSON. Holds no transport; the `RunManager` owns buffering/replay/broadcast.

### The Frontend (`src/web/client.ts`)

A single ~85 KB HTML document with inline CSS (OKLCH color system, light/dark themes) and inline ES-module JS. No external assets, no build step, no network dependencies. Implements DAG visualization (SVG with `data-status`), live SSE event handling, run dispatch, history, input forms, re-run, and the `X-Work-Token` handshake via `<meta name="work-token">`.

### Boot Recovery (`reconcileInterruptedRuns`)

On startup, the server queries `listNonTerminal()` (all `running`/`queued`/`interrupted` runs, unbounded — not the newest-200 page, so a long-running job started 200+ runs ago is still caught) and re-dispatches each with its original `runId`. For webhook-sourced runs, the persisted trigger `event` is restored so `${{ event.* }}` recompiles correctly. A run whose workflow no longer resolves or compiles is honestly marked `failure` rather than sitting as a zombie `running` row. Dispatching only re-enqueues — it returns immediately and proceeds in the background under the run-concurrency cap.

## Webhook Triggers

Webhooks are configured in `work.json` and matched to workflow `on: webhook:` blocks:

```json
{
  "webhooks": {
    "ci": {
      "workflow": "ci",
      "auth": "bearer",
      "secret": "$CI_WEBHOOK_SECRET"
    }
  }
}
```

The webhook receiver (`POST /hooks/:name`):
- Validates auth — **bearer** (shared secret in `Authorization` header) or **hmac** (signature in a configurable header). HMAC verification handles both `sha256=<hex>` (GitHub) and bare `<hex>` (Grafana) formats; the algorithm is pinned to SHA-256, never trusts a header-supplied algorithm.
- **Fail-closed multi-layer gating**: (1) hook must exist in config, (2) `checkHookConfig` verifies enabled + secret resolves + valid auth mode, (3) `authorizeHook` authenticates (before any workflow I/O — so an unauthenticated caller can't learn that a hook exists or spam the audit log with parse errors), (4) `loadOptedInSpec` verifies the workflow declares `on: webhook`, (5) dedup check, (6) body parse must be a JSON object.
- Deduplicates via `DeliveryRepository` — the key is `sha256(hook + raw body)` with a 5-minute TTL window (`DEDUPE_TTL_MS`). A duplicate returns the original `runId` with `deduped: true`. The in-memory ring is pruned opportunistically at >1000 entries.
- Audit log: result, httpStatus, sourceIp — **never** payload/secret.
- Delivers the payload as the workflow's `event` context, accessible via `${{ event.* }}`.

Source presets for known senders (Alertmanager, Grafana, GitHub, GitLab, generic) are available via `work create webhook <name>` — scaffolds both the `work.json` config entry and the workflow's `on: webhook:` block with matching names and correct auth modes.

## Schedule Triggers (`src/scheduler/`)

A transport-free cron scheduler with no HTTP, no engine, no internal timer — just a pure `tick()` function. Everything is injected, making it fully unit-testable.

### How It Works

- `dueSlot(cron, since, now)` (`src/scheduler/due.ts`) walks forward from `since` to `now` using `croner` and returns the **latest** due slot. Skip-by-default — missed slots are never backfilled, only the most recent fires. The walk is bounded by `MAX_COALESCE = 1000` (safety valve for pathological gaps). All evaluation in **UTC**. `nextFire(cron, now)` is a standalone function returning the next scheduled instant — used by `GET /api/schedules` to show upcoming fire times.
- `tick(deps)` (`src/scheduler/scheduler.ts`) iterates all scheduled workflows, checks `dueSlot`, dispatches any with a due slot, records `lastFired`. Never-seen schedules are seeded to "now" (no retroactive fire).
- `seedBaselines()` resets all baselines on boot (drops missed slots while host was down).
- `slotRunId()` generates a stable idempotency key `cron:<wf>:<slot-iso>` so duplicate ticks collapse.

Each schedule is isolated — one bad cron doesn't abort the tick. The web server boots `tick()` on a 30-second interval.

### SchedulerDeps (injected)

`listScheduled`, `store` (ScheduleStore), `dispatch`, `clock`, optional `onError`. The `ScheduleRepository` (`work.schedules` table) persists per-`(workflow, cron)` last-fired baselines.

## Run History & Logs

Durable persistence lives under `.workflows/db/` (PGLite data directory, gitignored). Both CLI and web write identically, so `work runs` and the web UI show the same history.

```bash
work runs [--status <s>]    # list run history
work runs --status failure  # filter by status
work logs <id>              # replay a past run's stored log frames
```

`RunEventRepository` stores a per-run event stream keyed by `(run_id, seq)`. The web UI replays these via SSE on `GET /api/runs/:id/events` — first sends buffered frames, then streams live events. A 15-second `": ping\n\n"` SSE heartbeat keeps connections alive through proxies. If the stored frames lack a terminal `run-end` (the live append is fire-and-forget and `close()` doesn't await pending appends, so a run finishing at shutdown can persist its frames without the closer while `work.runs` still records the terminal status), the replay synthesizes a `run-end` from the run row's status — so the browser stops reconnecting instead of looping forever (its `onerror` is a deliberate no-op). A third fallback, `replayStoredStatus()`, handles runs with zero persisted event frames (recorded before event persistence existed), emitting a minimal `run-init` + `run-end` from just the stored status.

## Observability — OpenTelemetry (`src/observability/`)

Runs can emit **OTLP traces and metrics** — off by default, enabled with one `observability` block in `work.json` (or plain `OTEL_*` env vars):

```json
{
  "observability": {
    "enabled": true,
    "otlpEndpoint": "https://otlp-gateway.example.net/otlp",
    "headers": {
      "Authorization": "Basic $OTLP_TOKEN"
    }
  }
}
```

Point it at any collector to see runs as standard distributed traces with per-model token usage.

### Span Hierarchy

| Span | Attributes |
|---|---|
| **Run** (root, `SpanKind.SERVER`) | `work.run.id`, `work.workflow.name`, `cicd.pipeline.name`, `work.run.resumed` |
| **Job** | `work.job.name`, `cicd.pipeline.task.name`, `host.image.name`, `host.arch`, matrix attrs. Links to `needs` dependency spans. |
| **Job-phase** (`stage`/`provision`/`teardown`) | `work.job.phase` |
| **Step** | `work.step.name`, `work.step.kind`, `work.step.uses`, `work.step.result` |
| **Agent `chat`** (leaf) | `gen_ai.*` semconv, usage tokens, `work.agent.setup_ms`, `work.agent.run_ms` |

Jobs are parented from the stored root context (explicit, never `context.active()` — jobs run concurrently). The run span is created with `root: true` so OTLP backends (e.g. Tempo Drilldown) recognize it as a trace root. The agent `chat` span starts **after** `setupMs` so it represents the actual model-loop window. Note: `mAgentDuration` records from step start (not chat start), so the metric includes setup time while the span does not. Matrix attributes are emitted as `work.matrix.<key>`. Cache token attributes (`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`) are emitted when available. An `interrupted` run status maps to `cancellation` in the `cicd.pipeline.result` vocabulary.

### Metrics

| Instrument | Type | Name |
|---|---|---|
| `mRuns` | Counter | `work.runs` |
| `mJobs` | Counter | `work.jobs` |
| `mSteps` | Counter | `work.steps` |
| `mRunDuration` | Histogram (s) | `work.run.duration` |
| `mJobDuration` | Histogram (s) | `work.job.duration` |
| `mJobPhaseDuration` | Histogram (s) | `work.job.phase.duration` |
| `mStepDuration` | Histogram (s) | `work.step.duration` |
| `mJobsInFlight` | UpDownCounter | `work.jobs.in_flight` |
| `mAgentRequests` | Counter | `work.agent.requests` |
| `mAgentTokens` | Counter | `work.agent.tokens` |
| `mAgentDuration` | Histogram (s) | `work.agent.request.duration` |
| `mResumes` | Counter | `work.run.resumes` |

### Key Design Points

- **Outcome as attribute, not span existence** — a failed step is an ERROR span with `error.type`; a job that absorbs it (continue-on-error) stays non-error. Skipped steps are clean spans with `result=skip`.
- **No-op re-drive guard** — a resumed run that executes zero jobs emits nothing (root span never ended → never exported).
- **Lazy/opt-in** — `@opentelemetry/sdk-node` is dynamically imported only when enabled. Disabled runs never load the SDK.
- **Vendored semconv** — attribute keys are in `src/observability/semconv.ts` (not pinned from upstream — renames are a one-file change).
- **Hook combiner** — `combineRunHooks()` (`src/observability/combine.ts`) fans one run's events to multiple `RunHooks` consumers (presenter + telemetry). Each consumer is **isolated** — a thrown error in one hook is swallowed so it can never abort others or the run.

### Bootstrap

`startTelemetry(config, serviceVersion)` (`src/observability/bootstrap.ts`) starts a `NodeSDK` that pushes both OTLP traces and metrics to a single endpoint (default `http://localhost:4318`, configurable via `OTEL_EXPORTER_OTLP_ENDPOINT` or config). Custom histogram buckets for `work.*.duration`: `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800]` seconds. Returns a `TelemetryHandle` with `tracer`, `meter`, and `shutdown()`.

`resolveTelemetry(config, env)` — the enable/endpoint decision: explicit config wins, else `OTEL_EXPORTER_OTLP_ENDPOINT` env turns it on, else off.

## Key Source References

| Area | Key files |
|---|---|
| Web server | `src/web/server.ts` |
| Run manager | `src/web/run-manager.ts` |
| Web presenter | `src/web/web-presenter.ts` |
| Frontend | `src/web/client.ts` |
| Scheduler | `src/scheduler/scheduler.ts`, `src/scheduler/due.ts` |
| Persistence repos | `src/persistence/runs.ts`, `src/persistence/run-events.ts`, `src/persistence/schedules.ts`, `src/persistence/deliveries.ts` |
| Telemetry emitter | `src/observability/emitter.ts` |
| Semantic conventions | `src/observability/semconv.ts` |
| Hook combiner | `src/observability/combine.ts` |
| SDK bootstrap | `src/observability/bootstrap.ts` |
| Webhook scaffolding | `src/scaffold/webhook.ts` |
| Design records | `docs/web-ui-research.md`, `docs/webhook-triggers-research.md`, `docs/scheduled-triggers-research.md`, `docs/observability-otel-metrics.md` |
