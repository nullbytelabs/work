# `work --web` — Local Web UI: Research + Design

> Research note for a `--web` flag that boots a small local website giving a
> tightened, lightweight **GitHub-Actions-like** experience: `workflow_dispatch`-style
> triggering, auto-generated input forms, a live job DAG, streaming logs, and run
> history. **No code has been written yet** — this consolidates five parallel
> investigations into the engine's integration seams, persistence, the local
> server, the frontend, and the GHA feature mapping. Date: 2026-06-01.
>
> **Verdict:** highly feasible, and mostly an *assembly* job over capabilities the
> engine already exposes. An MVP ships with **zero engine changes and zero new
> dependencies**. The only genuine gaps are persistence-shaped (a queryable run
> record + durable logs) and are cleanly deferrable to a later phase.
>
> **Implementation status (2026-06-03): Phase 0 SHIPPED + Phase 1 run history.**
> Built with zero new dependencies: `src/web/{server,run-manager,web-presenter,
> client,index}.ts`, the `listWorkflows` + `startRun` refactors, a caller-supplied
> `runId` on `RunContext`, and `work --web [--workspace <dir>] [--port 4280]`.
> Server is loopback-only with Host-header + `X-Work-Token` CSRF guards; routes
> match §3; live updates over SSE. Covered by `test/web.test.ts`. The
> hand-drawn-SVG frontend is the documented MVP (not pixel-polished).
>
> **Phase 1–3 SHIPPED.** An engine `query` seam (`AbsurdEngine.query`) backs two
> engine-owned tables (`src/persistence/`): `work.runs` (option B — run metadata,
> recorded at dispatch + finish) and `work.run_events` (every SSE frame, persisted
> per-run with a synchronous seq). `work --web` defaults a persistent `dataDir`
> (`<workspace>/.workflows/db`). So a restarted server not only **lists** past runs
> (Phase 1) but **replays a finished run's full DAG + per-step logs** over the same
> SSE endpoint (Phase 2 — `replayHistorical`), and a **Re-run** button /
> `POST /api/runs/:id/rerun` recompiles a past run's stored inputs and dispatches
> it (Phase 3). Proven by `test/persistence-runs.test.ts`, `test/run-events.test.ts`
> (engine-restart durability) + `test/web-persistence.test.ts` / `test/web-logs.test.ts`
> (server-restart log replay + re-run E2E). **Still deferred:** "re-run failed jobs"
> (durable cross-job resume), live cancel.

---

## 1. Thesis — why this fits the engine so well

Three pieces of existing architecture make a web UI a thin layer rather than a
rebuild:

1. **The run API is already clean and in-process.** `Runtime.run(plan, ctx)`
   (`src/runtime/types.ts:67`) takes a compiled plan and a `RunContext` of
   `{ workRoot, workspaceSource?, workflowDir?, hooks? }` and returns a
   `WorkflowResult`. The runtime writes nothing to stdout itself — **all output
   flows through `RunHooks`**. A web handler passes hooks that push to the browser
   instead of a terminal and gets identical behavior. Nothing about running a
   workflow is CLI-coupled.

2. **The live-data source already exists as an event stream.** `RunHooks`
   (`src/runtime/types.ts:37`) — `onJobStart / onStepStart / onOutput / onStepEnd /
   onJobEnd` — is exactly the feed a live run view wants. The terminal presenter
   (`src/tui/presenter.ts`, `src/tui/store.ts`) is a complete reference consumer:
   `RunStore` demultiplexes the interleaved, `jobId`-keyed hook stream into a
   per-job state model and is **directly reusable** — instantiate one per run, feed
   it hooks, serialize `snapshot()` to the browser.

3. **The DAG and the input schema are already serialized.** `emitGraph(plan,
   "json", {steps})` (`src/graph/emit.ts:193`) hands a client jobs, `needs` edges,
   topological `level`, and per-step expansion — a ready-made layout payload. And
   the typed-inputs schema (`InputSpec`, `src/spec/types.ts:22`) *is* a form spec:
   `type`→widget, `options`→`<select>`, `required`→attr, `pattern`→validation,
   `default`→prefill, `description`→label.

The web UI is an **assembly** over discovery, the inputs schema, the DAG emitter,
and the hook stream — not new engine machinery.

---

## 2. The key alignment: `workflow_dispatch` *is* our only trigger

In GitHub Actions, `workflow_dispatch` is one of many `on:` events, and the input
form only appears if the author opts into it. In pi-workflows, **`on:` is parsed
but never acted on** (`src/spec/types.ts:103`, `src/spec/parse.ts:318`) — there is
no event / cron / PR-trigger machinery at all. So *every* workflow is effectively
dispatch-only, and **the "Run workflow" button is the complete trigger story.**

This is a simplification, not a gap: the UI never needs to model events,
schedules, branches, or refs. (There's also no branch concept — the checkout is
always the project root, `src/project.ts:27` — so GHA's branch dropdown is simply
omitted.)

---

## 3. Architecture at a glance

```
  work --web [--workspace <dir>] [--port 4280]
        │
        ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ node:http server  (127.0.0.1 only, zero new deps)             │
  │                                                              │
  │  GET  /                      → inlined HTML/CSS/JS shell      │
  │  GET  /api/workflows         → listWorkflows(workspace)       │
  │  GET  /api/workflows/:name/form  → spec.inputs (InputSpec)    │
  │  GET  /api/workflows/:name/graph → compile + emitGraph(json)  │
  │  POST /api/runs              → compile(spec,{inputs}) + run   │
  │  GET  /api/runs              → RunManager history (in-mem v1) │
  │  GET  /api/runs/:id/events   → SSE: RunHooks → event frames   │
  └───────────────┬──────────────────────────────────────────────┘
                  │  per dispatch
                  ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ RunManager  (Map<runId, RunRecord>)                          │
  │  • one shared AbsurdEngine injected into each run            │
  │  • per-run subscriber Set<SSE res> + bounded log ring buffer │
  │  • WebPresenter (implements Presenter) drives the SSE stream │
  └───────────────┬──────────────────────────────────────────────┘
                  ▼   reuses, unchanged:
        parseWorkflow → compile → AbsurdRuntime.run(plan, { hooks })
                  │
                  ▼  every job runs in a gondolin micro-VM (sandboxed)
```

Everything below the `RunManager` is existing engine code. The new surface is the
HTTP server, a `WebPresenter` (a third `RunHooks` consumer alongside the two TUI
presenters), the `RunManager`, and the served frontend.

---

## 4. Integration seams (what's reusable, what to refactor)

**Directly reusable, no changes** (all pure, all exported):
- `parseWorkflow` / `compile` / `resolveInputs` — the dispatch pipeline.
- `emitGraph` (`src/graph/emit.ts:29`) + `levelize` (`src/tui/levels.ts:23`) — DAG payload + column layout.
- `RunHooks` contract + `AbsurdRuntime.run(plan, ctx)` — the in-process run API.
- `RunStore` + `JobState` (`src/tui/store.ts`) — the hook-driven per-run state model; serialize `snapshot()` to the browser.
- `InputSpec` from the **parsed spec** — the form schema.

**Two small refactors** (the only ones genuinely needed; both extract currently-inlined logic):
- `listWorkflows(workspace) → [{ name, file }]` — pull the `.workflows/*.yaml`
  name-collection out of `findWorkflowByName` (`src/project.ts:64`), which already
  builds this set internally. Powers the workflow list + the dispatch form.
- `startRun(layout, inputs, hooks) → Promise<WorkflowResult>` — pull config-load +
  `workRoot` + runtime construction + `run` + `close` out of `cli.ts` `main()`
  (`src/cli.ts:204-245`) so both the CLI and the web handler call one function.

**One gotcha — input-form metadata is dropped at compile time.** `compile()` runs
`resolveInputs` (`src/compiler/inputs.ts`), which collapses the rich `InputSpec`
into concrete resolved values; only those land on `ExecutionPlan.inputs`. The
metadata (types, options, pattern, required, descriptions) **never reaches the
plan.** So the web flow must be **`parse → render form from `spec.inputs``**, then
`compile(spec, { inputs: submitted })` on dispatch (where `resolveInputs` does the
server-side validation and throws a human-readable `WorkflowCompileError` you
surface inline).

**Where `--web` slots into the CLI.** Like the `graph` subcommand — an
inspection-style branch handled in `parseArgs` (`src/cli.ts:47`) + `main()` (the
`graph` branch at `src/cli.ts:197` is the precedent). It must branch **before** the
single-workflow resolve, because the UI enumerates *all* pipelines, not one.
`parseArgs` currently rejects unknown flags and gates `--workspace` to `run`/`graph`
— both need a small allowance for `--web`/`--port`.

---

## 5. Transport & live updates — `node:http` + SSE (zero deps)

The use case is **one-way, server→browser**: stream step output + status
transitions. **Server-Sent Events is purpose-built for this and needs no library**
(plain `text/event-stream` over `node:http`; the browser side is one
`EventSource`). A `node_modules` scan confirmed there is no `ws`/framework to lean
on and nothing transitively pulling one in — so building on `node:http` keeps the
**zero-new-dependency** posture intact. WebSocket (a `ws` dep) is only worth it if
the UI later needs low-latency *client→server* interaction during a run
(interactive agent prompts, live cancel-with-ack) — out of scope for trigger +
watch + stream.

**Proposed SSE event protocol** (each frame is `event:`/`data:` with JSON `data`;
the run-init frame seeds the DAG, the rest map 1:1 onto hooks):

```
event: run-init    data: { runId, name, jobOrder, jobs:{<id>:{runsOn,needs,level,steps:[{name,title,kind,uses}]}}, status:"running" }
                          # this is the emitGraph(plan,"json") shape + levelize() levels
event: job-start   data: { runId, jobId }                                    # onJobStart
event: step-start  data: { runId, jobId, stepName, title }                   # onStepStart
event: step-output data: { runId, jobId, stepName, stream, text }            # onOutput (live, chunked)
event: step-end    data: { runId, jobId, stepName, status, exitCode }        # onStepEnd (drop bulk stdout — already streamed)
event: job-end     data: { runId, jobId, status }                           # onJobEnd
event: run-end     data: { runId, status }                                   # after runtime.run resolves
```

Implementation: a `WebPresenter implements Presenter` (`src/tui/presenter.ts:20`)
whose `.hooks` push frames to the run's subscriber set; `start(plan)` emits
`run-init`, `finish(result)` emits `run-end`. The CLI already wires
`presenter.start/hooks/finish` around `runtime.run` (`src/cli.ts:216-244`) — the web
path reuses that exact seam.

**SSE hygiene:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`, `res.flushHeaders()`, a `: ping\n\n` heartbeat ~every 15s,
and track open responses in a `Set` so graceful shutdown can `res.end()` them
(long-lived sockets otherwise block `server.close()`).

**Timing note:** hook payloads carry **no timestamps** — the TUI stamps
`Date.now()` on receipt (`src/tui/store.ts`). The `WebPresenter`/`RunManager` does
the same; per-step durations are derived, not provided.

---

## 6. Long-lived server: the RunManager

The CLI is one-shot (run one workflow, exit). A server is long-lived and hosts
many runs over time. Keep this minimal:

- **Run registry:** `Map<runId, RunRecord>` where `RunRecord = { id, name, status,
  startedAt, subscribers: Set<res>, ring: string[] }`. The `runId` already exists
  — `AbsurdRuntime.run` mints `randomUUID()` internally (`src/runtime/absurd/runtime.ts:131`);
  **surface it** (return it / let the `WebPresenter` own it) so the HTTP layer can
  key on it.
- **Backlog for late subscribers:** a browser opening the SSE stream mid-run needs
  the history, not just future events. Keep a **bounded per-run ring buffer** of
  emitted frames; a fresh `EventSource` replays the backlog, then tails live. (This
  is what `RunStore.log` / `BufferedPresenter` already do per job — retained in the
  manager instead of flushed.)
- **Shared engine:** boot one `AbsurdEngine` at startup and inject it via
  `AbsurdRuntimeOptions.engine` (`src/runtime/absurd/runtime.ts:115`; the
  `ownsEngine` flag means an injected engine isn't closed per run) — cheaper than
  re-creating per run, and the seam already exists (tests use it).
- **Concurrency:** independent jobs already run in parallel *within* a run (worker
  concurrency). Multiple *concurrent runs* is the new axis — allow it (each run is
  an independent set of Absurd tasks), but v1 may serialize triggering to avoid
  several gondolin VMs contending. Worth a deliberate choice.

---

## 7. Frontend — no build step, hand-drawn SVG DAG

Inherit the TUI's already-litigated verdict (`docs/tui-iteration-2.md`:
"zero-dependency, hand-rolled"): **no framework, no bundler, no build.** Serve a
self-contained HTML shell with inline CSS and a browser-native
`<script type="module">`; stream via `EventSource`; use native `<details>` for
collapsible step logs and native form validation.

### 7a. DAG rendering — draw it ourselves (do **not** use Mermaid for the live view)

The decisive finding: `emitGraph`'s `toMermaid()` assigns **synthetic node ids**
(`n0`, `n1`, …) with the real name only in the label (`src/graph/emit.ts:84`).
Mermaid then renders those into DOM ids like `flowchart-n0-<counter>` where the
suffix is an internal, per-render integer — and Mermaid offers **no supported API
for post-render restyling**. Live-updating node status through Mermaid means
either re-rendering on every event (flicker, lost scroll/zoom, ~1MB+ CDN bundle) or
reaching into undocumented SVG id conventions (brittle).

We don't need Mermaid, because we already have the two hard pieces: `toJson()`
gives `{ jobOrder, jobs:{ needs, level, runsOn, steps } }`, and `levelize()` gives
topological depth. That's a **layered DAG** you draw without a layout engine:
`x = level` (column), `y = index-within-level` (row); edges are SVG `<path>` from
each `needs` source to target. ~150 lines of vanilla JS produces an `<svg>` where
every job is `<g class="job" data-job="<id>">`, and **live restyle is a one-liner**:

```js
svg.querySelector(`[data-job="${jobId}"]`).dataset.status = "running"; // CSS does the rest
```

Status colors live in CSS, matching the TUI's vocabulary (`src/tui/render.ts`):
success ✓ green, failure ✗ red, skipped ⊘ yellow, running cyan, pending ◌ gray.
Matrix legs are real nodes (`<base>::<cell>`). `--steps` expands a job node into a
stacked column of step sub-nodes. The CLI's `graph --format mermaid` output stays
as-is for users who paste into external tools — it's just not what the web view
consumes. **Recommendation: hand-drawn layered SVG for both the live and the
static pre-run graph; skip Mermaid entirely.**

### 7b. Auto-generated input forms

Generate from the workflow's `inputs:` (`InputSpec`):

| `InputSpec` | HTML control |
|---|---|
| `type:string` | `<input type=text>` |
| `type:number` | `<input type=number>` → submit `valueAsNumber` |
| `type:boolean` | `<input type=checkbox>` |
| `options:[…]` | `<select>` (overrides base control) |
| `required` | `required` attr |
| `pattern` | `pattern=` (HTML's unanchored `test`, matching `new RegExp(p).test(v)` in `inputs.ts:61`) |
| `default` | `value` / `checked` / pre-selected option |
| `description` | `<label>` + helper text |

**Client validation must mirror the compiler exactly** (`src/compiler/inputs.ts`),
because the compiler is the source of truth and re-validates on submit:
- **strict types, no coercion** — submit a real JSON number for `number` inputs
  (`"36"` is rejected, `inputs.ts:77`); a real boolean for checkboxes.
- **present-only pattern** — don't pattern-check an absent optional input
  (`inputs.ts:49`).
- **unknown keys rejected** — only emit declared inputs.
Native form validation covers most of this for free; a tiny JS pass handles the
typing + present-only nuance. Submit `{inputs:{…}}` to `POST /api/runs`; the server
feeds it to `compile(spec, {inputs})` (same path as the CLI's `--inputs`) and
returns the structured `WorkflowCompileError` message inline on failure.

### 7c. Live log viewer

- **Source:** the SSE `step-output` frames (from `onOutput`). Group lines into a
  collapsible `<details>` per step (native, zero JS to collapse), `<summary>` =
  step title + status glyph + exit code — GHA's per-step log feel.
- **ANSI:** workflow/agent output contains ANSI. Reuse the TUI's matcher
  (`ANSI_RE` in `src/tui/render.ts:39`). Recommend a ~40-line SGR-subset
  **ANSI→HTML** converter (colors, bold/dim/reset → `<span class>`), **HTML-escaping
  text first** (log content is untrusted). Plain stripping is the fine MVP fallback;
  no `ansi-to-html` dependency.
- **Auto-scroll:** pin to bottom unless the user has scrolled up (standard
  log-tail pattern).

### 7d. MVP view set

1. **Workflows list** (`/`) — flat list of `.workflows/*.yaml` by `name:` (peers
   like `ci`, `review`), via `listWorkflows`.
2. **Run / trigger detail** (`/runs/:id`) — the centerpiece: auto-form + Run
   button, live hand-drawn DAG, per-step collapsible logs, status/timing chips
   (reuse the counts/elapsed logic in `src/tui/render.ts:112`).
3. **Run history** (`/runs`) — v1: in-memory list of runs this server launched
   (see §8 caveat).

### 7e. Asset delivery

Start with a **single self-contained HTML string** served from `node:http` (inline
CSS + inline ES-module JS) — it bundles into `dist/cli.js` for free and dev mode
just works. **Important build constraint:** `scripts/build.mjs` bundles `src/` with
esbuild `packages:"external"`; sibling non-TS files are *not* bundled and must be
explicitly copied (as `schema.sql` / `guest-runner-script.mjs` already are). So if
the client grows beyond inline strings, author it as **plain `.js` ES modules**
under `src/web/` and add copy steps + `import.meta.url` resolution (the established
pattern) — the browser can't run `.ts`, and there's no bundler for client code.
Inline-first avoids all of that for the MVP.

---

## 8. Run history & persistence (the real gaps)

The durable substrate is genuinely strong — but **off by default**, and there's no
run-level record or query API. Precise state:

**Already persisted (in the Absurd/PGLite schema, `src/runtime/absurd/schema.sql`):**
- Each **job** is its own Absurd task (`t_default` + `r_default`): status, attempts,
  `started_at`/`completed_at`/`failed_at`, and the full `JobResult` JSON as
  `completed_payload`.
- Each **step** is a checkpoint (`c_default`): the full `StepResult` JSON — including
  **`stdout`/`stderr`, `exitCode`, `status`, `outputs`** — as the checkpoint `state`.
  So a *completed* step's logs are backed by data.

**The blockers:**
1. **Ephemeral by default.** The CLI never sets `dataDir` (`src/cli.ts:228`), so
   PGLite runs purely in-memory and the whole DB dies at process exit — **nothing
   survives across invocations.** The plumbing to persist exists
   (`AbsurdRuntimeOptions.dataDir` → `createAbsurdEngine`, `src/runtime/absurd/engine.ts:71`);
   it's just unset. ⚠️ **No safe multi-process access to one dataDir** (PGLite is
   last-writer-wins) — the web server and a concurrent CLI must not open the same
   dataDir; the server should own it.
2. **No run-level record.** `runId` is a transient `randomUUID()` never written as a
   row (`src/runtime/absurd/runtime.ts:131`); cross-job orchestration is plain JS,
   not a durable task. A "run" is only implicit in task names
   (`job:<workflow>:<runId>`). Absurd's SDK exposes only `fetchTaskResult(taskID)` —
   **no list/history API**; you'd query PGLite directly.
3. **Live-tail logs aren't durable.** `onOutput` chunks stream to presenters only;
   only the *final aggregated* `stdout`/`stderr` lands in the persisted `StepResult`.
   Live-tail of an in-progress step is in-memory (the `RunManager` ring buffer);
   completed-step logs come from the checkpoint JSON *once persistence is on*.

**Options to enable durable history (all Phase 1+):**
- **A. Turn on persistence** (smallest, required): default a persistent `dataDir`
  (e.g. `~/.work/db` or `.workflows/db`); mind the single-process constraint.
- **B. Add a first-class `runs` record** (recommended): an engine-owned table
  (`run_id, workflow, status, started/finished, inputs, trigger`) written at
  run start/finish — gives the history list a clean primary key instead of
  string-parsing task names. Promote the existing `randomUUID()` to a returned,
  persisted id.
- **C. Query layer over PGLite** (SQL) for list + drill-down (no SDK API exists).
- **D. Log persistence** for *live* chunks if wanted: either the server consumes
  the same `onOutput` hooks (works when it's the running process) or a `step_logs`
  append table (buffer to avoid per-chunk write amplification).

**MVP caveat to decide explicitly:** without any of the above, "history" is
**in-memory for the server's lifetime only** — fine for a v1 local dev tool, lost on
restart.

---

## 9. Security & local-server posture

- **Bind `127.0.0.1` only** (never `0.0.0.0`). Precedent: PGLite's socket server
  already binds loopback (`src/runtime/absurd/engine.ts:56`).
- **Port:** default **4280** + `--port <n>`; on `EADDRINUSE`, try the next few then
  error — `engine.ts:53` already demonstrates a bind-with-retry loop to mirror.
- **The action is sandboxed, the trigger surface is what to guard.** Hitting "Run"
  launches jobs that each execute in a gondolin micro-VM (`sandboxed:true` is
  hard-wired, `src/runtime/absurd/runtime.ts:510`; there is no host-execution
  target). So contain the *trigger*, not the action.
- **CSRF / DNS-rebinding against localhost** is the real risk (a malicious site in
  the user's browser POSTing to `127.0.0.1:4280`). Layered, dependency-free
  mitigations: (1) **validate the `Host` header** (reject anything but
  `127.0.0.1:<port>`/`localhost:<port>` — kills DNS-rebinding); (2) **require a custom
  header / startup token** on mutating (`POST`) requests — printed to the console at
  launch and embedded in the served page; cross-site `fetch` can't set it without a
  preflight, and we send no permissive CORS; (3) **never emit
  `Access-Control-Allow-Origin`**. Reads/SSE are `GET`, triggers are `POST` + token.

---

## 10. GitHub Actions → ours: feature map

| GHA surface | Our support | Status |
|---|---|---|
| Workflow list (`.github/workflows/`) | `findWorkflowByName` already scans `.workflows/*.yaml` + reads each `name:` (`src/project.ts:50`) | **Supported** (wrap as a list endpoint) |
| "Run workflow" / `workflow_dispatch` | Manual dispatch is the *only* trigger (`on:` inert) | **Supported, better aligned** |
| Inputs form | `InputSpec` = form spec; `resolveInputs` validates server-side identically | **Supported** |
| Run summary + job DAG | `emitGraph(plan,"json"\|"mermaid")` (`src/graph/emit.ts`); matrix legs are real nodes | **Supported** (hand-drawn SVG from json) |
| Per-step expandable logs (live) | `RunHooks.onOutput` + `StepResult` stdout/stderr; CI presenter already does `::group::` | **Live: supported** |
| Per-step logs (historical) | Logs streamed, not durably stored unless `dataDir` on | **Gap** (persistence) |
| Run history list | No surfaced/queryable run record; ephemeral DB | **Gap** (persistence) |
| Re-run | Re-invoke `run` with stored inputs (recompile) | **Easy once run records exist** |
| Re-run failed jobs (resume) | Cross-job orchestration is plain JS, not durable | **Out of scope** |
| Cancel | `cancel_task` exists in schema but not plumbed runtime→target | **Out of scope (nice-to-have)** |
| Branch/ref dropdown | No branch concept (checkout = project root) | **N/A by design** |
| Secrets/variables manager | Config is file-based (`work.json`, `$VAR`) | **Out of scope** |

---

## 11. MVP scope + phased roadmap

**Phase 0 — MVP (no engine changes, no new deps).** New `src/web/` (server,
inlined client, `RunManager`, `WebPresenter`) + two refactors (`listWorkflows`,
`startRun`) + bridge `RunHooks`→SSE. Views: workflow list, trigger/run detail
(auto-form + live SVG DAG + per-step logs + status chips), session-scoped history.
History is in-memory for the server's lifetime only.

**Phase 1 — Durable run history.** Set a persistent `dataDir`; add a `runs` record
(promote/persist the run id). Unlocks the history list with status/time/duration/
trigger, filterable by workflow.

**Phase 2 — Log persistence + historical run view.** Persist per-step stdout/stderr
keyed by run/job/step so a finished run's logs render after the process exits.

**Phase 3 — Re-run.** Reload stored inputs and re-dispatch (cheap once Phase 1
exists). "Re-run failed jobs" deferred (needs durable cross-job resume).

**Phase 4 — Live matrix polish, cancel, read-only config viewer.** Matrix legs
already render as nodes; cancel needs `cancel_task` plumbed runtime→target; a
read-only model/config view is low-effort (a secrets *manager* stays out of scope).

---

## 12. Open questions / decisions to make

1. **MVP history:** in-memory session-scoped (ship now) vs. wait for durable
   `dataDir` + runs table? (Recommend: ship in-memory, layer durable later.)
2. **Concurrent runs:** allow multiple simultaneous web-triggered runs (each its
   own gondolin VMs) or serialize triggering to bound VM contention?
3. **dataDir location & ownership** when persistence lands (`~/.work/db` vs
   project-local `.workflows/db`), given the single-process constraint.
4. **Live-log durability** (Phase 2): append-table vs per-run log files vs rely on
   the checkpoint JSON for completed steps only.
5. **Assets:** keep the client inline indefinitely, or graduate to `src/web/*.js`
   static modules (with build-copy) once it grows?
6. **Auth token** ergonomics for the localhost CSRF guard (printed token vs. none
   for a purely-loopback tool).

---

## 13. Key files (for the implementer)

- `src/cli.ts:47,197,204` — arg parser; the `graph` inspection-branch precedent; the run sequence to extract into `startRun`.
- `src/project.ts:50` — `findWorkflowByName`; extract `listWorkflows`.
- `src/runtime/types.ts:37,67` — `RunHooks` + `Runtime.run` (the web event source + run API).
- `src/runtime/absurd/runtime.ts:115,131,510` — engine injection; the `runId` to surface; `sandboxed:true`.
- `src/runtime/absurd/engine.ts:53,56,71` — port-retry + loopback bind precedent; `dataDir` plumbing.
- `src/runtime/absurd/schema.sql:148-204` — `t_/r_/c_` tables backing history once persistent.
- `src/tui/presenter.ts:20,67` + `src/tui/store.ts` — `Presenter` shape + `RunStore` (reuse for `WebPresenter`).
- `src/graph/emit.ts:84,193` — `toMermaid` synthetic ids (why we hand-draw) + `toJson` (the DAG payload).
- `src/tui/levels.ts:23` + `src/tui/render.ts:39,112` — `levelize` (SVG layout) + `ANSI_RE` / status-counts (reuse).
- `src/spec/types.ts:22,103` — `InputSpec` (form schema) + inert `on:`.
- `src/compiler/inputs.ts:17,49,77` — the exact validation rules client + server must mirror.
- `scripts/build.mjs` — why inline assets (esbuild `packages:"external"` doesn't bundle siblings).
