---
type: Architecture Reference
title: Architecture
description: Detailed overview of the `work` engine's layered compile pipeline, covering the spec, compiler, runtime, and target layers, the ExecutionPlan seam, matrix expansion, reusable workflow inlining, machine sizing, and durable checkpointing.
resource: src/cli.ts
tags: [architecture, pipeline, compiler, runtime, execution-plan, run-path, errors]
---

# Architecture

The `work` engine is a straight-line pipeline with layered separation of concerns. Each layer is independently swappable and has a clean boundary.

## The Compile Pipeline

```
YAML text → parseWorkflow() → WorkflowSpec → compile() → ExecutionPlan → AbsurdRuntime.run() → WorkflowResult
```

Stated in `src/cli.ts`'s header: **resolve → read → parse → compile → run.**

| Layer | Subsystem | Responsibility | Source |
|---|---|---|---|
| **What to run** | `src/spec/` | Turn YAML into a validated `WorkflowSpec`. Pure, no I/O. | `spec/parse.ts`, `spec/types.ts` |
| **How to plan** | `src/compiler/` | Transform `WorkflowSpec` into a runtime-agnostic `ExecutionPlan`. | `compiler/compile.ts`, `plan.ts`, `expr.ts`, `matrix.ts`, `inputs.ts`, `condition.ts`, `reusable.ts` |
| **How durably** | `src/runtime/` | Execute the plan with durable checkpointing. | `runtime/absurd/runtime.ts`, `runtime/types.ts` |
| **Where** | `src/targets/` | Run steps inside a micro-VM. | `targets/gondolin.ts`, `targets/factory.ts` |

## Spec Layer (`src/spec/`)

`parseWorkflow(yamlText)` turns YAML into a validated `WorkflowSpec`. It validates input types/options/patterns, cron expressions (via `croner`), and produces human-friendly errors with paths (e.g. `jobs.build.steps[0]`).

Key types (`spec/types.ts`):
- `WorkflowSpec` — `name`, `on` (triggers), `inputs`, `env`, `jobs`
- `JobSpec` — `runsOn`, `needs`, `if`, `strategy` (matrix), `steps` or `uses` (reusable call), `outputs`
- `StepSpec` — `run` (shell) or `uses` (agent/action), `with`, `if`, `continueOnError`, `env`

The spec is **completely runtime-agnostic** — it describes intent only. The `on:` trigger block is validated here but acted on separately by the webhook receiver and scheduler.

## Compiler Layer (`src/compiler/`)

`compile(spec, opts)` produces an `ExecutionPlan` via a 5-pass compilation:

1. **Matrix expansion** (`matrix.ts`) — Cartesian product + `include`/`exclude` (GHA semantics). `exclude` is applied before `include`. An `include` entry extends a matching cell with extra keys (without overwriting an axis value), or appends a standalone cell when it matches nothing. An axis-less matrix starts empty and is defined entirely by `include`. Each cell becomes a `PlannedJob` with id `<base>::<cell>` (path-safe).
2. **Reusable inlining** (`reusable.ts`) — `uses: workflow/<name>` callees are resolved, recursively compiled, and spliced into the flat plan. A `with:` value containing `${{ needs.* }}` is marked **deferred** — passed through verbatim (not type-checked), resolving at runtime through the callee's inherited `needs`. `steps.*` in `with:` is rejected (a reusable call has no steps).
3. **Step emission** — each job's steps are emitted with interpolated env
4. **Splice inlined jobs** — single-job callee adopts the call's id; multi-job callee gets namespaced `<call>__<subjob>` ids
5. **Output reference rewriting** — output expressions are rewired to the inlined ids

`topoSort(jobs)` uses Kahn's algorithm with **deterministic alphabetical tie-breaking** — critical for replay-stable orchestration.

### The `ExecutionPlan` (`plan.ts`)

The plan is the seam between "what to run" (the spec) and "how durably / where" (a Runtime + ExecutionTarget). It is fully runtime-agnostic.

Key types:
- `ExecutionPlan` — `name`, `jobs` (id → `PlannedJob`), `jobOrder` (topological), resolved `inputs`, resolved `event` payload, `warnings` (non-fatal authoring warnings surfaced on stderr)
- `PlannedJob` — `id` (`<base>::<cell>` for a matrix leg), `title`, `runsOn`, `machine` (`ResolvedMachine`), `needs`, `if`, `matrix` cell, `steps`, `outputs`
- `PlannedStep` — `name` (`<jobId>/<stepId-or-index>`), `title`, `id`, `run`/`uses`, `with`, `if`, `continueOnError`, resolved `env` (workflow ← job ← step, may carry deferred expressions)

The `event` payload rides along on the plan so the runtime can evaluate `event.*` in deferred `if:`/`when:` conditions — `${{ event.* }}` references in `run:`/`env:`/`with:`/`outputs:` strings are baked at compile time like `inputs`, but `if:`/`when:` is a runtime evaluation.

Before the passes run, `assertNoMatrixBaseRefs` rejects `needs.<matrixJob>.outputs.*` / `.result` references up front — a matrix job fans out into one leg per cell, so its outputs are ambiguous when keyed by the base id (the runtime keys `needs` by leg id). This mirrors `assertNoMatrixOutputs` on the reusable-workflow path. See [Workflow Syntax — Expressions](../workflows/workflow-syntax.md#expressions).

### Machine Sizing (`machines.ts`)

`machine:` resolves to a concrete `ResolvedMachine` (cpus + qemu-syntax memory) stored on each `PlannedJob`. Four named catalog types:

| Type | vCPU | RAM |
|---|---|---|
| `small` | 2 | 2G |
| `medium` (default) | 2 | 8G |
| `large` | 4 | 12G |
| `xlarge` | 8 | 24G |

A custom spec (`machine: { cpus: 8, memory: 16G }`) may set either dimension — an unset one inherits from `medium`. The default is `medium` (8G) because knip's parser (oxc) eagerly reserves a single ~6 GiB `ArrayBuffer` per parse; the reservation must fit under the guest's commit limit or knip dies at `new ArrayBuffer` with "Array buffer allocation failed." Disk sizing is not exposed in the machine spec — gondolin's `rootfs.size` mechanism (guest-side `resize2fs` at boot) is not wired into `machines.ts`, so there is no `disk:` dimension to set. See [Workflow Syntax — Machine Sizing](../workflows/workflow-syntax.md#machine-sizing).

### Two-Phase Expression Resolution (`expr.ts`)

Expressions (`${{ ... }}`) are resolved in two phases:

- **Compile-time** (baked into plan): `inputs.*`, `matrix.*`, `event.*`
- **Runtime** (left intact for later): `needs.*`, `steps.*`, `secrets.*`

Unknown roots always error — never silently pass. `condition.ts` has a hand-written tokenizer + recursive-descent parser for `if:`/`when:` (no `eval`, no deps).

### Conditionals Grammar

The condition engine is a pragmatic subset of the GitHub-Actions expression language:

- **Context access**: `inputs.<name>`, `matrix.<axis>`, `needs.<job>.result`, `needs.<job>.outputs.<key>`, `steps.<id>.result`, `steps.<id>.outputs.<key>`, `steps.<id>.outcome`, `steps.<id>.exitCode`, `event.<path>` (including array indexing: `event.alerts[0].labels.severity`).
- **Literals**: single/double-quoted strings, numbers, `true`/`false`/`null`.
- **Operators**: `==` `!=` `&&` `||` `!` and parentheses. Equality is loose — numeric when both operands look numeric, else string.
- **Status functions**: `success()` `failure()` `always()` `cancelled()`.

A condition may be wrapped in `${{ ... }}` (as in README examples) or written bare — both are accepted. Anything outside this grammar (unknown context root, comparison operators like `<`, helpers like `contains()`) raises a clear error rather than silently passing, so an unsupported condition is never mistaken for `true`.

**`secrets.*` is deliberately absent from the condition context.** Secrets are available in `run:`/`env:`/`with:` interpolation but **not** in `if:`/`when:` conditions or job-output interpolation — this prevents a secret from leaking via a skip-pattern branch or persisting into a journaled job output. The runtime threads `secrets` into the expression context (`exprCtx`) but omits it from the condition context (`condCtx`) and job-output interpolation (see [Durable Execution](../runtime/durable-execution.md#secrets-isolation)).

### Input Resolution (`inputs.ts`)

`resolveInputs(declared, provided, deferred?)` validates provided inputs against the declared spec and produces concrete values:

- **Strict typing — no coercion.** A string `"36"` is rejected for a `number` input; mismatches are errors, not silent conversions.
- **Defaults** are applied when an input is not provided. A **required** input that's missing (and has no default) throws.
- **Optional + unprovided + no default** → a type-appropriate empty sentinel: `0` for number, `false` for boolean, `""` for string. These sentinels are **not** constraint-validated — only inputs that were actually supplied (or have an explicit default) are checked against `options`/`pattern`.
- **`options`** — value must be one of the listed options.
- **`pattern`** — a regex the value must match (string inputs only).
- **Deferred inputs** — when a reusable-workflow caller passes `${{ needs.* }}` through `with:`, the input is marked deferred: its value isn't known at compile time, so it's passed through verbatim as a string for substitution into the callee, where `${{ inputs.<name> }}` expands to that expression and resolves at runtime.

Unknown provided keys (not declared in `inputs:`) are rejected up front.

### Prototype-Pollution Hardening

Input, `needs`, and `steps` lookups all use `Object.hasOwn` rather than `in` or a bare index — a key colliding with an `Object.prototype` member (`toString`, `constructor`, `__proto__`, …) reads as missing/undeclared instead of resolving to the inherited function. This matters because untrusted webhook payloads flow through `event.*` path access (`walkPath`); the same guard is applied in `resolveInputs`, `resolveNeeds`, `resolveSteps`, `addJob`, and `parseOutputProducer`. See [Workflow Syntax — Expressions](../workflows/workflow-syntax.md#expressions).

### Filesystem-Pure Compiler

`resolveWorkflow` is **injected** by the caller (`project.ts`'s `resolveWorkflowRef`) so the compiler stays filesystem-pure — it does no file reads. This makes the compiler fully unit-testable. Depth cap: 10 levels. Cycle detection via `_chain` tracking. `MAX_PLAN_JOBS = 1000` guards against runaway expansion.

## Runtime Layer (`src/runtime/`)

The only runtime is `AbsurdRuntime` (`absurd/runtime.ts`). See [Durable Execution & Targets](../runtime/durable-execution.md) for full detail.

Key interface (`runtime/types.ts`):
```typescript
interface Runtime {
  readonly kind: string;
  run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult>;
}
```

The runtime is **agent-agnostic** — `UsesHandler` dispatches `uses:` by scheme (`work/`, `action/`), and handlers are composed in at the `run.ts` layer. The durable core imports zero agent/config code.

## The Shared Run Path (`src/run.ts`)

`startRun()` is the **single** dispatch point that turns a compiled `ExecutionPlan` into a result. Both the CLI and the web UI's `RunManager` call it, ensuring exactly one run path with identical config loading, work-root allocation, runtime construction, and close semantics.

### `startRun()` Pipeline

1. **Secrets fail-fast** — scan the plan for `${{ secrets.* }}` references, check against `work.json`'s `secrets:` whitelist, `$ENV`-expand values. Unfulfillable secrets throw before any work begins.
2. **Resolve runId** — caller-supplied (web mints upfront) or `randomUUID()`. Keys the journal, history row, runtime, and work dir.
3. **Prepare work root** — caller-provided `workdir` is kept; otherwise mints `tmpdir()/work-<runId>`. Stable across resume (not a fresh mkdtemp — completed steps' filesystem side-effects survive).
4. **Compose `uses:` handlers** — `work/` handler (agent + built-ins) + `action/` handler, with a late-bound `SubUsesDispatch` for nested `uses:` inside composite actions.
5. **Create/own the engine** — when `opts.engine` is undefined, creates one (persistent if `dataDir` given; ephemeral otherwise). An injected engine (web) is shared and not closed.
6. **Telemetry** — built from `config.observability` (off unless enabled). Hooks are combined with caller's presenter hooks.
7. **Durable record** — when persistent: `RunRepository.insert()` + `WebPresenter` recorder writing frames to `RunEventRepository`.
8. **Construct `AbsurdRuntime`** with engine, handlers, egress resolver, secrets, image resolver, optional `makeTarget` override.
9. **Run** → `runtime.run(plan, ctx)`.
10. **Finally** — flush telemetry, close runtime, close owned engine, remove work dir **only on terminal outcome** (keep for resumable/interrupted runs).

**Presentation is deliberately excluded** from `startRun`. The caller passes `hooks` (the TUI presenter or the web SSE sink). This means the web layer reuses `startRun` untouched.

## The Entrypoint (`src/cli.ts`)

`main()` flow:
1. Early dispatch: `version`, `doctor`, `create`, `init` (own flag parsing).
2. `parseArgs(argv)` — flag handler table, positional subcommand resolution.
3. `runs` / `logs` / `serve` — branch and exit early.
4. `resume`/`rerun`/`retry` — `applyRecover()` looks up the prior run's workflow + inputs from history, folds them into `args`. `retry` additionally calls `resetFailedJobs()`.
5. **Resolve layout** — `findWorkflowByName()` or `resolveWorkflowLayout()` → `{ file, workflowDir, workspaceSource }`.
6. **Read + parse + compile** — `parseWorkflow()` → `compile(spec, { inputs, resolveWorkflow })`.
7. `graph` — emit DAG and exit (no runtime).
8. **Dispatch** — `dispatchRun()` loads config, picks a presenter, determines persistence, resolves runId, calls `startRun()`, renders result, exits.

## Project Layout (`src/project.ts`)

Two ways to launch:
- **Ad-hoc**: a bare `<workflow.yaml>` path. Checks out the workflow's own folder.
- **By name**: `run <name>` resolves the `.workflows/*.yaml` whose `name:` matches. Checks out the **project root** (parent) into each job.

`.git/` and `node_modules/` are never staged — jobs install their own deps.

`resolveWorkflowRef(ref, fromDir)` is the `ResolveWorkflow` implementation injected into the compiler. It resolves `workflow/<name>` and `./path.yaml` references synchronously (keeps `compile()` synchronous).

## Error Handling (`src/errors.ts`)

`UserFacingError` is the base class for actionable, end-user-facing errors. The CLI catches it and prints a clean message (no stack trace) via `formatUserFacing()`; everything else prints as an unexpected error with a stack.

The clean-vs-stack distinction is **structural, not per-call-site**: all three authoring-error classes — `WorkflowParseError` (`spec/parse.ts`), `WorkflowCompileError` (`compiler/compile.ts`), and `ConditionError` (`compiler/condition.ts`) — **extend `UserFacingError`**, so even a code path that forgets to catch the concrete subtype still prints clean. Call sites still catch the concrete type where they need a specific exit code (2), HTTP status (400), or behavior (`ConditionError` → a job-condition failure step). `test/error-contract.test.ts` guards this contract.

A `UserFacingError` may carry structured context — all optional:
- **`path`** — the logical location of the offending node (`jobs.build.steps[0]`), prefixed onto the message and exposed as a field.
- **`hint`** — a one-line actionable remediation.
- **`docs`** — a documentation URL (centralized in the `DOCS` map, served from GitHub Pages).

`formatUserFacing(err)` renders the message, then optional `hint:` and `see:` lines — every CLI surface routes through it. The web server reads the structured fields directly into its 400 JSON response (`sendCompileError`).

## How It All Connects

```
                         cli.ts
                           │
                    parseArgs → resolve layout (project.ts)
                           │
                    readFile → parseWorkflow (spec/)
                           │
                    compile(spec, { resolveWorkflow }) (compiler/)
                           │
                    ExecutionPlan
                           │
                    dispatchRun → startRun (run.ts)
                           │
               ┌───────────┼───────────────┐
               │           │               │
          secrets      AbsurdEngine    UsesHandler[]
          fail-fast    (runtime/absurd)  (agent + actions)
               │           │               │
               └───── AbsurdRuntime.run(plan, ctx) ──────┐
                           │                              │
                    per-job: makeTarget(runsOn)           │
                           │                              │
                    GondolinTarget.provision()             │
                    GondolinTarget.run(command)            │
                    GondolinTarget.dispose()               │
                           │                              │
                    RunHooks (presenter/SSE/telemetry) ◄──┘
                           │
                    WorkflowResult
                           │
               ┌───────────┴───────────┐
               │                       │
          RunRepository           RunEventRepository
          (work.runs)             (work.run_events)
```

## Key Source References

| Area | Key files |
|---|---|
| Entrypoint | `src/cli.ts` |
| Shared run path | `src/run.ts` |
| Project layout | `src/project.ts` |
| Spec parsing | `src/spec/parse.ts`, `src/spec/types.ts` |
| Compilation | `src/compiler/compile.ts`, `src/compiler/plan.ts`, `src/compiler/expr.ts`, `src/compiler/matrix.ts`, `src/compiler/condition.ts`, `src/compiler/reusable.ts` |
| Runtime | `src/runtime/types.ts`, `src/runtime/absurd/runtime.ts`, `src/runtime/absurd/engine.ts` |
| Targets | `src/targets/types.ts`, `src/targets/gondolin.ts`, `src/targets/factory.ts` |
| Errors | `src/errors.ts` |
