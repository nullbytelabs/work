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
**Status: design — not built.**

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

### Open: is the parallel-lanes framing honest? (code says yes, a comment says no)

Fan-out itself is **not** in question — the `needs` DAG is expressed and executed
correctly ([`test/e2e/fan-out-fan-in/workflow.yaml`](../test/e2e/fan-out-fan-in/workflow.yaml)
is a working diamond), and [`src/runtime/absurd/runtime.ts`](../src/runtime/absurd/runtime.ts)
spawns each independent job as its own Absurd task. What's unresolved is narrower:
whether independent siblings *execute at the same wall-clock instant*, which is
what the parallel-lanes visual implies.

The code reads as genuinely concurrent:

- Each job is its own Absurd task (`app.spawn`), scheduled via
  `Promise.all(plan.jobOrder.map(schedule))`, each awaiting only its `needs`.
- A single worker runs with `concurrency = min(jobCount, 16)` and
  `batchSize = concurrency`, so it can claim and run that many handlers at once.
- The *work* inside a step — `target.run(command)` (a subprocess) or an agent's
  network call — is async I/O that does **not** hold the PGLite connection; only
  the short `ctx.step` checkpoint reads/writes touch the single-connection
  (`max:1`) pool.

But the fixture's own note disagrees: *"today jobs run in deterministic
topological order (alphabetical among ready jobs); true parallel execution of the
middle tier is a planned runtime enhancement."* That's either stale (written
before the `Promise.all`/worker-concurrency runtime) or accurate (the worker
effectively drains the queue serially in practice). **Reading the code can't
settle it** — this needs the actual spike README #1 calls for: run the diamond
with timing instrumentation and observe whether the middle tier overlaps.

Implication for the design, not blocking: if execution turns out serial today,
the lanes still correctly show DAG *structure* (depth, what's blocked on what) —
just relabel the live state so concurrently-*ready* jobs don't claim to be
concurrently-*running*. If it's genuinely concurrent, add the legend caveat that
it's **cooperative I/O concurrency on one process + one connection**, not CPU
parallelism (right for I/O-bound shell/agent jobs; two CPU-bound jobs wouldn't
speed up). Either way the layered view is correct; only the running/ready wording
depends on the spike.

### Per-job richness the current CLI drops

For each row, surface the fields the present presenter never reads:

- **state + spinner:** pending / running / success / failed / skipped, mapped
  from the hook transitions.
- **elapsed time:** wall clock from `onJobStart` to `onJobEnd` (and a live
  ticking value while running).
- **step progress:** `current/total` — total from `plan.jobs[id].steps.length`,
  current from `onStepStart` count; show the running step's name inline.
- **target:** `runsOn` from the plan (`local` / `gondolin`) — useful context
  the user otherwise can't see.
- **attempt / retries:** from the Absurd run row (`attempt`, bounded by
  `maxAttempts`). This is the durable-state payoff: retries are invisible in a
  pure event-stream view.

### Two-pane option (selected-job logs)

Mirror Turborepo/Nx: the layered list on the left, the selected job's live log
on the right (arrow/vim nav to switch selection). Logs stream into the pane via
`<Static>`-style scrollback above the live region so finished output persists.
This is the same per-job buffering we already do, just made selectable instead of
flushed in completion order. Reserve this for the Ink path (below); the
single-pane layered list is the floor.

## Durable watch / attach — the differentiator

Because each *job* is an Absurd task and each step within it is a `ctx.step`
checkpoint (the whole-run orchestration is still plain JS — see constraint 1
below, and `docs/absurd-durable-workflows.md`), per-job run state is
**queryable after the fact and mid-flight**: the `r_` runs table holds attempts,
`c_` holds per-step checkpoints, `e_` holds emitted events. `app.spawn` returns
`{ taskID, runID, attempt }`, and Absurd ships a CLI/SDK surface to dump
tasks/runs.

This unlocks a mode the ephemeral tools can't offer:

```
pi-workflows watch <run-id>     # attach the same TUI to an in-progress or resumed run
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

## Library choice

Unchanged in spirit from iteration 1, now decided by which features above we
commit to:

- **Ink** (7.x) — needed for the two-pane layout, freeform lanes, and
  `<Static>` streaming-log region with a live board above. Cost: pulls React 19
  + Yoga. Pick this if we want the selectable-logs view and the richest layered
  rendering. Bridge the hooks into a small store an Ink component subscribes to.
- **listr2** (10.x) — sufficient for the single-pane layered list if we model
  levels as nested task groups; lightest path, best built-in non-TTY fallback.
  It prefers to own execution, so we bridge our emitter → its task promises.
  Pick this if two-pane and durable-attach are out of scope for the first cut.

Recommendation: **start on listr2 for the layered single-pane list** (fastest to
a richer-than-today view, cheapest fallback), and reach for **Ink only if/when**
two-pane selectable logs or the `watch` attach mode justify the weight.

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
  `store.snapshot()` on a throttled tick (~10–15 Hz) as the layered list. Start
  single-pane (listr2 nested groups by level, or a hand-rolled `log-update`
  block); add the Ink two-pane only if/when we commit to selectable logs.

Library decision stays as in the previous section: **listr2 first** for the
single-pane layered list (lightest, best built-in CI fallback), **Ink** only when
two-pane selectable logs or the `watch` attach view justify React + Yoga.

### Step 4 — durable `watch` reader (separate, gated)

Only after the two prerequisites from the "Durable watch / attach" section
(surface `runId`; whole-run-as-durable-task, or accept the
read-only-of-a-live-host framing). A thin read-only query layer over
the Absurd `r_`/`c_`/`e_` tables reconstructs `RunStore` state without the live
hook stream, then renders the identical `LayeredPresenter`. Reuses Steps 1–3
wholesale — the reader is just an alternate state source.

### Step 5 — `graph` command (separate, pre-existing plan)

`pi-workflows graph <workflow.yaml>` emits the `needs` DAG as Mermaid / Graphviz
DOT / JSON. Still the home for the real box-and-edge DAG; unrelated to the live
view beyond sharing `levelize()`.

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

- **Running vs ready (README #1):** fan-out works; open question is whether
  independent siblings *run* simultaneously or the worker drains them serially.
  Code suggests concurrent, a fixture comment says serial — needs a timing spike
  to settle. Only the live "running" wording depends on it (see the section
  above); the DAG structure renders correctly regardless.
- **Replay/ordering (README #2):** confirm Absurd's replay contract before the
  `watch` reader trusts checkpoint ordering to reconstruct step progress.
- **Attempt surfacing:** decide whether retries collapse into one row (with a
  `try N/M` badge) or expand — collapsing matches the mental model of "one job".
  Note jobs are currently spawned with a hardcoded `defaultMaxAttempts: 1` in
  `runtime.ts`, so attempts are always 1 today; enabling per-job retries is an
  independent change (lift that constant + plumb a retry strategy), unrelated to
  fan-out. Design the badge now; expect `try 1/1` until retries are turned on.
- **Selection persistence:** in two-pane mode, what's selected when the selected
  job finishes — sticky, or auto-advance to the next running job?

## Sources

- Iteration 1 research + library landscape: [`docs/tui-research.md`](./tui-research.md)
- Event stream / hooks: [`src/runtime/types.ts`](../src/runtime/types.ts)
- DAG + plan: [`src/compiler/plan.ts`](../src/compiler/plan.ts)
- Current presenter: [`src/cli.ts`](../src/cli.ts)
- Durable state model: [`docs/absurd-durable-workflows.md`](./absurd-durable-workflows.md), [`src/runtime/absurd/schema.sql`](../src/runtime/absurd/schema.sql)
- Carry-over design questions: [`README.md`](../README.md) "Open design questions"
