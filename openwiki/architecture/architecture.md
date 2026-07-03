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

1. **Matrix expansion** (`matrix.ts`) — Cartesian product + `include`/`exclude` (GHA semantics)
2. **Reusable inlining** (`reusable.ts`) — `uses: workflow/<name>` callees are resolved, recursively compiled, and spliced into the flat plan
3. **Step emission** — each job's steps are emitted with interpolated env
4. **Splice inlined jobs** — single-job callee adopts the call's id; multi-job callee gets namespaced `<call>__<subjob>` ids
5. **Output reference rewriting** — output expressions are rewired to the inlined ids

`topoSort(jobs)` uses Kahn's algorithm with **deterministic alphabetical tie-breaking** — critical for replay-stable orchestration.

### Two-Phase Expression Resolution (`expr.ts`)

Expressions (`${{ ... }}`) are resolved in two phases:

- **Compile-time** (baked into plan): `inputs.*`, `matrix.*`, `event.*`
- **Runtime** (left intact for later): `needs.*`, `steps.*`, `secrets.*`

Unknown roots always error — never silently pass. `condition.ts` has a hand-written tokenizer + recursive-descent parser for `if:`/`when:` (no `eval`, no deps).

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

`UserFacingError` is a single error class for actionable conditions meant for end users. The CLI catches it and prints a clean one-liner (no stack trace). Everything else prints as an unexpected error with a stack.

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
