# TUI Iteration 2 — richer run view + DAG-aware layout

A follow-on to [`tui-research.md`](./tui-research.md). That note surveyed the
mature tools, concluded a live box-and-edge DAG is overkill, and landed on a
flat **status list keyed by job** with the real graph pushed to a separate
inspection command. This iteration revisits that conclusion with a sharper goal:
**carry more of the run's structure and state into the live view** — the
dependency shape, per-job richness, and the durable run history the engine
already persists — *without* regressing into the unreadable box-and-edge graph
the first pass (correctly) rejected.

The thesis of this iteration: the first note threw away two things the codebase
hands us for free — the **DAG** (`needs` + `jobOrder`) and the **durable run
state** (Absurd's `r_`/`c_`/`e_` tables). A flat status list ignores both. We
can be richer on both axes while keeping the rendering terminal-friendly.

**Status: built (live board + step names + `graph` command).** The live
DAG-aware board, friendly step names, and the standalone `graph` command shipped;
the durable `watch <run-id>` attach mode and the two-pane selectable-logs view
remain future work. The design discussion below is preserved; a "What shipped"
summary follows immediately, and per-section status notes mark what landed.

## What shipped

- **`src/tui/`** — a presenter seam over the runtime's `RunHooks`
  (`selectPresenter` → `Null` for `--quiet`, `Buffered` for CI/pipes, `Layered`
  for an interactive TTY). Zero new dependencies: pure TypeScript + ANSI (see
  "Library choice" for why not Ink/listr2). `levels.ts` (topological depth),
  `store.ts` (`RunStore`, the hook-keyed job state), `render.ts` (the layered
  board), `presenter.ts` (the three presenters + live in-place redraw with
  finished-job logs committed to scrollback).
- **Friendly step names** — the compiler now carries each step's author `name:`
  through as `PlannedStep.title`; the board and the buffered blocks display it
  (falling back to the step id/index). See `src/compiler/compile.ts`.
- **`src/graph/`** — the `graph` command: `emitGraph(plan, format, { steps })`
  in four formats (`mermaid`, `dot`, `json`, `ascii`). With `--steps`, mermaid
  and dot render steps as **first-class nodes** (a subgraph/cluster per job, step
  nodes chained in order, `uses` steps drawn distinctly), and json/ascii list
  them inline.
- **Tests** — `test/tui.test.ts` and `test/graph.test.ts` cover levels, the
  store transitions, board rendering, and all four graph formats incl. `--steps`.

## Recap of what's already wired (unchanged from iteration 1)

The runtime emits the presenter's event stream and requires no engine changes:
`onJobStart → onStepStart / onOutput / onStepEnd → onJobEnd` (see
[`src/runtime/types.ts`](../src/runtime/types.ts), `RunHooks`). Per-step results
carry `status` (`success` / `failure` / `skipped`), `exitCode`, `stdout`,
`stderr`, and `outputs`; per-job results carry `status`, `steps`, and `outputs`
(`StepResult` / `JobResult`). A TUI remains a pure **presenter** layered on these
hooks; the buffered, per-job-flush output in [`src/cli.ts`](../src/cli.ts) stays
the non-TTY default.

## Three data sources, in increasing richness

The current CLI presenter only consumes the *event stream* and discards the rest.
The richer view draws on all three.

| Source | Where | What it gives the view |
|---|---|---|
| **Event stream** | `RunHooks` in `src/runtime/types.ts` | Live skeleton: job/step transitions, streamed stdout/stderr, exit codes, per-step + per-job outputs. |
| **Execution plan** | `ExecutionPlan` in `src/compiler/plan.ts` | The DAG itself — `jobs[id].needs`, topological `jobOrder`, and each job's `runsOn` target (`local` vs `gondolin`). Known *before* the run starts. |
| **Durable Absurd state** | PGLite/Postgres, `src/runtime/absurd/schema.sql` | Persisted runs (`r_`), checkpoints (`c_`), emitted events (`e_`). Attempt numbers, retries, suspend/resume — survive process exit. |

The plan is the piece iteration 1 left on the floor. The durable state is the
piece *no mature tool has* — Turborepo and Nx live views are ephemeral; ours can
attach to an in-progress or resumed run.

## The reconciliation: a layered status list, not a graph

The way to add DAG richness without box-and-edge layout is to render the
**topological structure as indentation/lanes**, not as drawn edges. Derive each
job's dependency depth from `needs` + `jobOrder`; group jobs into levels.

- **Depth communicates blocking:** a job at level *N* is waiting on level *N−1*.
  Indentation reads as "what's downstream of what" without a single edge glyph.
- **Siblings communicate parallelism:** jobs sharing a level are the ones that
  run concurrently — exactly the thing a flat list obscures.
- **No reflow hazard:** indentation and lanes survive terminal resize and
  scrollback; box-and-edge layouts do not. This is the specific failure mode
  iteration 1 flagged, sidestepped rather than re-litigated.

Sketch (TTY, live region):

```
workflow: release            ●3 running  ✓2  ⨯0   00:41
│
├─ ✓ build            local     2/2 steps         00:08
│
├─◓ test              gondolin  1/3 steps         00:33   ← live, current step shown
│   └ > integration-suite
├─◓ lint              local     0/1 steps         00:33
│
└─ ◌ publish          gondolin  blocked on test,lint
```

This keeps the iteration-1 verdict intact (no live graph) while showing the
graph's *information* — depth, parallel fan-out, and what each downstream job is
blocked on. The full box-and-edge DAG still belongs in a separate `graph`
command (Mermaid / Graphviz DOT) for pre-run inspection, exactly as before.

### The parallel-lanes framing is honest

Independent jobs genuinely run in parallel (the README states this as verified),
so the lanes tell the truth. The mechanism, for reference:

- Each job is its own Absurd task (`app.spawn`), scheduled via
  `Promise.all(plan.jobOrder.map(schedule))`, each awaiting only its `needs`.
- A single worker runs with `concurrency = min(jobCount, 16)` and
  `batchSize = concurrency`, so it claims and runs that many handlers at once.
- The *work* inside a step — `target.run(command)` (a subprocess) or an agent's
  network call — is async I/O that does **not** hold the PGLite connection; only
  the short `ctx.step` checkpoint reads/writes touch the single-connection
  (`max:1`) pool.

The one nuance to keep in the legend rather than hide: this is **cooperative I/O
concurrency on one process + one connection**, not CPU parallelism — exactly the
right fit for work' I/O-bound shell and agent jobs (two CPU-bound jobs
wouldn't speed up). The lanes show "in flight," which is accurate.

### Per-job richness the current CLI drops

*Built,* except where noted. For each row, surface the fields the old presenter
never read:

- **state + spinner:** pending / running / success / failed / skipped, mapped
  from the hook transitions.
- **elapsed time:** wall clock from `onJobStart` to `onJobEnd` (and a live
  ticking value while running).
- **step progress:** `current/total` — total from `plan.jobs[id].steps.length`,
  current from `onStepStart` count; show the running step's name inline.
- **target:** `runsOn` from the plan (`local` / `gondolin`) — useful context
  the user otherwise can't see.
- **attempt / retries:** *(latent)* from the Absurd run row (`attempt`, bounded
  by `maxAttempts`). The durable-state payoff, but jobs spawn with a hardcoded
  `defaultMaxAttempts: 1` today, so the badge reads `try 1/1` until per-job
  retries are turned on — a separate change, unrelated to this view.

### Two-pane option (selected-job logs) — FUTURE

Mirror Turborepo/Nx: the layered list on the left, the selected job's live log
on the right (arrow/vim nav to switch selection). Logs stream into the pane via
`<Static>`-style scrollback above the live region so finished output persists.
This is the same per-job buffering we already do, just made selectable instead of
flushed in completion order. The single-pane layered list is what
shipped; this selectable two-pane view is deferred (and would stay hand-rolled,
not Ink, per "Library choice").

## Durable watch / attach — the differentiator (FUTURE)

Because each *job* is an Absurd task and each step within it is a `ctx.step`
checkpoint (the whole-run orchestration is still plain JS — see constraint 1
below, and `docs/absurd-durable-workflows.md`), per-job run state is
**queryable after the fact and mid-flight**: the `r_` runs table holds attempts,
`c_` holds per-step checkpoints, `e_` holds emitted events. `app.spawn` returns
`{ taskID, runID, attempt }`, and Absurd ships a CLI/SDK surface to dump
tasks/runs.

This unlocks a mode the ephemeral tools can't offer:

```
work watch <run-id>     # attach the same TUI to an in-progress or resumed run
```

The presenter reconstructs current state by reading checkpoints/runs rather than
(or in addition to) the live hook stream, then renders the same layered view. It
also means a TUI that's killed and reopened doesn't lose the picture — it
re-derives it from Postgres.

**Two real constraints, found in the code, that scope this honestly:**

1. **Orchestration is not yet durable.** The top-of-file NOTE in
   `runtime.ts` is explicit: *cross-job orchestration lives in the runtime (JS),
   not a durable task, so whole-workflow crash-resume isn't covered yet.* So the
   *per-job* tasks and their `ctx.step` checkpoints (`r_`/`c_`/`e_`) survive a
   host crash, but the DAG walk that spawns and threads them does not. A `watch`
   reader can therefore faithfully reconstruct **each job's** progress from
   Postgres, but "is the whole workflow still advancing?" depends on the JS
   orchestrator still being alive. Full attach-to-a-resumed-*workflow* waits on
   the planned refactor that makes the whole run a durable parent task (tracked
   in `docs/phase-1.md`). Until then, `watch` is best framed as **read-only
   observation of a run owned by a live host process**, not takeover of an
   orphaned one.
2. **`runId` isn't surfaced.** The runtime mints `runId = randomUUID()` per run
   and keys tasks (`job:<name>:<runId>`) and idempotency (`<runId>:<jobId>`) off
   it, but never prints or persists it anywhere a user can grab. `watch
   <run-id>` needs that handle, so a prerequisite is: print the `runId` at run
   start (and/or record a small run-index row) so there's something to pass.

With those addressed, the remaining open item is the replay/ordering contract
(README #2) before the reader trusts checkpoint ordering to reconstruct
step-level progress.

## Library choice — decided: zero-dependency, hand-rolled

**Shipped with no new dependency: pure TypeScript + ANSI.** The deciding
constraint, found when building, overrode the iteration-1 shortlist: work
runs on **Node's native type-stripping** (`erasableSyntaxOnly`, no build step,
no JSX transform). That rules **Ink** out — it's React/JSX and needs a compile
step the project deliberately doesn't have — and makes pulling **listr2** (or any
runtime dep) a poor fit for a project that prides itself on no native/binary deps.

So the live board is hand-rolled: a small in-place redraw using cursor/clear ANSI
escapes, a finished-job "commit to scrollback" akin to Ink's `<Static>`, a
spinner, and width-aware truncation so lines never wrap (which would corrupt the
cursor math). It's the "most work, most control, lightest footprint" option the
iteration-1 research flagged — and the only one compatible with the no-build
constraint. The two-pane selectable-logs view (the one place Ink would have
genuinely helped) is deferred; if it's built, it stays hand-rolled too.

What we did **not** need: any of the rejected libraries, and any engine change —
the presenter is a pure consumer of `RunHooks`.

## Non-TTY / CI (unchanged)

Auto-detect (`!process.stdout.isTTY` or `is-in-ci`) and fall back to today's
buffer-and-flush-per-job output, optionally wrapped in `::group::` markers so
GitHub/Buildkite collapse them. The layered view is strictly the TTY branch.
listr2's SimpleRenderer or Ink's auto CI fallback both cover this; either way the
existing `src/cli.ts` behavior is the contract the fallback must match.

## Concrete build plan (file-by-file)

The guiding constraint: the presenter is a **pure consumer of `RunHooks` + the
plan**. No engine or runtime changes for the live view (the durable `watch`
reader is the only thing that touches Postgres, and only for reads). Ship in the
order below; each step is independently testable and the first three already beat
today's output.

**Status:** Steps 0–3 and Step 5 (`graph`) are **built**; Step 4 (durable
`watch`) is **future**. The code matches this plan closely — `src/tui/{presenter,
levels,store,render}.ts` and `src/graph/` — with one deviation noted under Step 3
(library choice: hand-rolled, not listr2/Ink — see "Library choice" above).

### Step 0 — extract the presenter seam (refactor, no behavior change)

Today `src/cli.ts` inlines the buffer-and-flush hooks. Pull that into a
`Presenter` interface so the CLI picks an implementation by environment:

```ts
// src/tui/presenter.ts  (new)
export interface Presenter {
  hooks: RunHooks;          // handed straight to runtime ctx.hooks
  start(plan: ExecutionPlan): void;
  finish(result: WorkflowResult): void;
}
export function selectPresenter(opts: { tty: boolean; quiet: boolean }): Presenter;
//   quiet            -> NullPresenter (hooks undefined)
//   !tty || is-in-ci -> BufferedPresenter  (today's behavior, the fallback contract)
//   tty              -> LayeredPresenter
```

`src/cli.ts` change is mechanical: build the presenter, pass `presenter.hooks`
as `ctx.hooks`, call `start`/`finish`. The existing buffered logic moves verbatim
into `BufferedPresenter` so the non-TTY contract is preserved by construction
(and the current CLI tests pin it).

### Step 1 — topo-level helper

```ts
// src/tui/levels.ts  (new)
//   level(jobId) = 0 if no needs, else 1 + max(level of needs).
//   Fold over plan.jobOrder (already a valid topo order) so each job's needs
//   are resolved before it. Returns Map<jobId, number> + groups by level.
export function levelize(plan: ExecutionPlan): {
  level: Map<string, number>;
  byLevel: string[][];
};
```

Pure function over `plan.jobs[id].needs` + `plan.jobOrder`. Trivially unit-tested
against the e2e fixtures (`fan-out-fan-in`, `hello-world-needs`) where the
expected levels are obvious.

### Step 2 — the job-state store

The hooks arrive keyed by `jobId` (see `runJobInTask` firing
`onJobStart/onStepStart/onStepEnd/onJobEnd`), and multiple jobs interleave —
so state must be a map, updated by hook, read by the renderer:

```ts
// src/tui/store.ts  (new)
type JobState = {
  id: string;
  runsOn: string;                 // from plan.jobs[id].runsOn
  level: number;                  // from levelize()
  needs: string[];
  status: "pending" | "running" | "success" | "failure" | "skipped";
  totalSteps: number;             // plan.jobs[id].steps.length
  doneSteps: number;              // ++ on onStepEnd
  currentStep?: string;           // set on onStepStart, cleared on end
  attempt: number;                // 1 until retries land (defaultMaxAttempts:1)
  startedAt?: number; endedAt?: number;  // Date.now() at onJobStart/onJobEnd
  logTail: string[];              // ring buffer for the two-pane view
};
export class RunStore {
  constructor(plan: ExecutionPlan, levels: Map<string, number>);
  // one method per hook; each mutates the keyed JobState and bumps a revision
  onJobStart(id): void; onStepStart(id, step): void;
  onOutput(id, step, chunk): void; onStepEnd(id, r): void; onJobEnd(id, r): void;
  snapshot(): JobState[];          // sorted by (level, id) for rendering
}
```

Derive the `pending → running` transition from the first `onJobStart`; a job
still at `pending` with unmet needs renders as "blocked on …". `skipped` comes
straight off the `JobResult.status` in `onJobEnd`.

### Step 3 — `BufferedPresenter` (fallback) and `LayeredPresenter` (TTY)

- `BufferedPresenter`: today's code, moved. Optionally wrap each job block in
  `::group::`/`::endgroup::` when `is-in-ci` so GitHub/Buildkite collapse it.
- `LayeredPresenter`: subscribes its hooks into `RunStore`, renders
  `store.snapshot()` on a throttled tick as the single-pane layered list. *As
  built:* a hand-rolled in-place redraw (cursor/clear ANSI) with a spinner timer
  and finished-job logs committed to scrollback above the live region; the
  optional Ink two-pane is deferred.

*As built,* the library decision landed differently from the iteration-1
shortlist — **hand-rolled, zero new dependencies** — because the project's
native-TS / no-build constraint rules out Ink (JSX) and disfavors listr2. See
"Library choice — decided" above.

### Step 4 — durable `watch` reader (FUTURE — not built)

Gated on the two prerequisites from the "Durable watch / attach" section (surface
`runId`; whole-run-as-durable-task, or accept the read-only-of-a-live-host
framing). A thin read-only query layer over the Absurd `r_`/`c_`/`e_` tables would
reconstruct `RunStore` state without the live hook stream, then render the
identical `LayeredPresenter`. Reuses Steps 1–3 wholesale — the reader is just an
alternate state source.

### Step 5 — `graph` command (BUILT)

`work graph <file|name> [--format mermaid|dot|json|ascii] [--steps]`
(`src/graph/`) emits the compiled `needs` DAG for pre-run inspection — the home
for the real box-and-edge DAG, separate from the live view, sharing `levelize()`.
Resolution mirrors `run` (ad-hoc path, or `--workspace … graph <name>`); it
compiles and exits before any runtime/config setup. Four formats:

- **mermaid** / **dot** — render in a browser / Graphviz. Default is one node per
  job (label = name · target · step count) with `needs` edges.
- **json** — `{ name, jobOrder, jobs: { runsOn, steps, needs, level } }` for
  tooling.
- **ascii** — a dependency-free terminal glance: jobs grouped by topological
  level with upstream `←` annotations.

With **`--steps`**, each job expands to its ordered steps. ascii and json list
them inline (`{ name, kind, uses?, id? }` for json). mermaid and dot make steps
**first-class graph nodes**: a subgraph (mermaid) / `cluster` (dot, via
`compound=true` + `lhead`/`ltail`) per job, step nodes chained in execution order,
`uses` steps drawn distinctly (stadium shape / filled), and job dependencies
linking the clusters. Synthetic node ids keep output valid regardless of job-id
characters; a zero-step job renders a `(no steps)` node so edges always have an
endpoint.

### Testing approach

- `levelize()` and `RunStore`: pure unit tests driven by synthetic hook
  sequences and the e2e plan fixtures — no terminal needed.
- `selectPresenter`: assert the env matrix (quiet / non-TTY / CI / TTY) picks the
  right implementation.
- `BufferedPresenter`: the **existing** CLI output tests are the regression net —
  they must pass unchanged after the Step 0 refactor (that's the whole point of
  moving the logic verbatim).
- `LayeredPresenter` rendering: snapshot-test `store.snapshot()` → rendered
  string for representative states (running fan-out, one failure, a skip cascade)
  rather than driving a real TTY.

### Boundaries to keep

The engine and runtime stay presenter-agnostic (they already only call
`ctx.hooks?.*`); the layered TUI is a TTY-only enhancement; the buffered/grouped
output remains the non-TTY default and the behavioral contract the fallback must
match.

## Open questions specific to this iteration

- **Replay/ordering (README #2):** confirm Absurd's replay contract before the
  future `watch` reader trusts checkpoint ordering to reconstruct step progress.
- **Attempt surfacing:** decide whether retries collapse into one row (with a
  `try N/M` badge) or expand — collapsing matches the mental model of "one job".
  Jobs spawn with a hardcoded `defaultMaxAttempts: 1` today, so attempts are
  always 1; enabling per-job retries is an independent change (lift that constant
  + plumb a retry strategy). Design the badge now; expect `try 1/1` until then.
- **Selection persistence (future two-pane):** when the selected job finishes —
  sticky, or auto-advance to the next running job?

## Sources

- Iteration 1 research + library landscape: [`docs/tui-research.md`](./tui-research.md)
- Event stream / hooks: [`src/runtime/types.ts`](../src/runtime/types.ts)
- DAG + plan: [`src/compiler/plan.ts`](../src/compiler/plan.ts)
- Live TUI (as built): [`src/tui/`](../src/tui/) — `presenter.ts`, `levels.ts`, `store.ts`, `render.ts`; wired in [`src/cli.ts`](../src/cli.ts)
- Graph command (as built): [`src/graph/emit.ts`](../src/graph/emit.ts)
- Durable state model: [`docs/absurd-durable-workflows.md`](./absurd-durable-workflows.md), [`src/runtime/absurd/schema.sql`](../src/runtime/absurd/schema.sql)
- Carry-over design questions: [`README.md`](../README.md) "Open design questions"
