---
type: Technical Reference
title: Durable Execution & Targets
description: How the OpenWiki workflow runtime executes jobs and steps durably via the AbsurdRuntime, journaling checkpoints to in-process PGLite Postgres for interruption-safe resume, retry, and rerun. Covers job phases (stage/provision/teardown), fine-grained DAG scheduling, if-gating, continue-on-error, secrets isolation, StepInterrupted vs terminal failures, output capture, the AbsurdEngine, and the GondolinTarget micro-VM execution target.
resource: src/runtime/absurd/runtime.ts
tags: [runtime, durable-execution, absurd, pglite, gondolin, execution-target, resume, retry, images, persistence]
---

# Durable Execution & Targets

Every workflow runs durably: each **job** is an Absurd task and each **step** is a checkpoint, journaled to an in-process Postgres (PGLite). No external services. Interrupted runs resume; failed jobs can be retried individually.

## The Runtime (`src/runtime/`)

The only runtime implementation is `AbsurdRuntime` (`src/runtime/absurd/runtime.ts`).

### Key Interface

```typescript
interface Runtime {
  readonly kind: string;
  run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult>;
}
```

`RunContext` carries: `workRoot`, `workspaceSource` (checkout), `workflowDir`, `hooks`, `runId`.

`RunHooks` is the lifecycle event stream: `onWorkflowStart`, `onJobStart`, `onStepStart`, `onOutput`, `onStepEnd`, `onJobEnd`, `onWorkflowEnd`, plus `onJobPhaseStart/End` (stage/provision/teardown). The TUI presenter and web SSE sink both implement `RunHooks`.

### Job Phases — `stage` / `provision` / `teardown`

Each job is bracketed with three sub-phase spans (`withJobPhase`):

- **`stage`** — staging the checkout into the workdir like a fresh `git checkout`: never carries a foreign `node_modules` (a job installs its own — copying one across platforms breaks native deps) or `.git`.
- **`provision`** — booting the micro-VM. A provision failure produces a synthetic step result so the failure is attributable without a real step.
- **`teardown`** — disposing the target. **Best-effort and never rethrows**: a `vm.close()` failure must not overwrite an in-flight `JobInterrupted` (the caller's `finally` is propagating it) — were it to, `runJobInTask`'s catch would see a non-`JobInterrupted` error, return a terminal `failure` instead of re-throwing, and silently break durable resume. A dispose failure is recorded on the teardown span for diagnosis and then swallowed; the VM is already going away.

### How It Works

- Each **job** is its own durable Absurd task (idempotency key: `${runId}:${jobId}`).
- Each **step** is a `ctx.step(name, fn)` checkpoint — completed steps are **memoized and never recomputed**.
- The whole run's DAG walk runs inside a **durable orchestrator task** (separate queue from job tasks to avoid deadlock).
- Jobs run in parallel (concurrency cap: 16) via worker tasks on a dedicated `JOBS_QUEUE`.
- **Heartbeats** every 150s (claim timeout 600s) keep long-running agent steps alive.

### Fine-Grained Scheduling

The DAG walk is not wave-barriered: a job spawns the instant its dependencies resolve, so a long fan-out doesn't wait for the slowest sibling of the previous level. The orchestrator's `Promise.all` over `jobOrder` resolves as each job settles; a job whose task ends `failed` (an interruption) throws `JobInterrupted` so the orchestrator task fails and a later re-spawn re-drives the whole run.

### Job `if:` Gating

With no `if:`, a job runs only if **every** dependency succeeded — the default. An `if:` takes over entirely, enabling `always()` / `failure()` to run a job after an upstream failure. A malformed `if:` produces a synthetic error step (`jobConditionError`) rather than a silent skip. Note `needs` is keyed by leg id for matrix jobs — see the compile-time `assertNoMatrixBaseRefs` guard in [Architecture](../architecture/architecture.md).

### `continue-on-error`

A step with `continue-on-error: true` records its failure outcome (visible in `steps.<id>.result` / `.outcome` / `.exitCode`) but does **not** set the job's `failed` flag — the job carries on and can still succeed. This pairs with output capture below: the step can run a tool, record its combined output, exit non-zero, and still expose that output to a consumer while preserving the real failure in `status`.

### Secrets Isolation

Secrets are available in `run:`/`env:`/`with:` interpolation but **deliberately not** threaded into the condition context (`condCtx`) or job-output interpolation. This prevents a secret from leaking via a skip-pattern branch (e.g. `if: ${{ secrets.token != '' }}` would otherwise reveal whether a secret is set) or persisting into a journaled job output. The runtime constructs `exprCtx` with `secrets` but builds `condCtx` without them (`src/runtime/absurd/runtime.ts`).

### `StepInterrupted` — `run:`/`uses:` Interruption Symmetry

A `run:` step gets the resumable interruption path for free: a `target.run` rejection (a VM tear-out) is wrapped in `StepInterrupted` and propagates as a `JobInterrupted`. A `uses:` step's handler would otherwise swallow the same rejection into a terminal failure. So the `uses:` dispatcher wraps `exec` to throw `StepInterrupted` (`src/runtime/types.ts`) on a `target.run` rejection, and every handler's `catch` re-throws it (never `fail()`s it) — so the run is recorded `interrupted` (resumable), not `failure`. This `run:`/`uses:` symmetry is what durable resume depends on.

### Interrupted vs. Terminal Throw

A throw from `executeStep` is **not** automatically an interruption. `runSteps` distinguishes two kinds:

- **`StepInterrupted`** — the target/VM was torn out under the step (it never reached a verdict). Raises `JobInterrupted` so the job task fails and a later invocation **resumes** from here.
- **Any other throw** — a terminal, deterministic error (e.g. a bad expression: a missing `needs`/`steps` output from a skipped upstream). Re-running would throw the identical error forever, so the step is recorded as a terminal `failure` (`failed = true`, no later steps run, no resume).

`runShellStep` wraps its `target.run` call to throw `StepInterrupted` on rejection, so a VM tear-out routes to the resumable path while an expression-resolution throw (which happens *before* `target.run`) propagates raw as a terminal failure.

### Output Capture (`src/runtime/output.ts`)

A `run:` step's `$WORK_OUTPUT` file lives at `target.workspacePath/.work-output-<stepName>` (where `<stepName>` is sanitized: non-word characters → `_`) and is **pre-deleted before each run** so a stale file from a prior attempt can't leak outputs into a resumed step. After the command finishes, the file is parsed (`parseOutputFile`) with GitHub-Actions `$GITHUB_OUTPUT` semantics: `key=value` for single-line values and a heredoc block (`key<<DELIM` … `DELIM`) for multi-line values; a later write to the same key wins. Keys are trimmed; values are **not** trimmed (leading/trailing whitespace is preserved). Lines with no `=` or an empty key are silently skipped. The heredoc delimiter line must exactly match the declared delimiter.

**Outputs are captured regardless of exit code** (GitHub captures `$GITHUB_OUTPUT` either way). This is what lets a `continue-on-error` step that runs a tool, records its combined output, and exits non-zero still expose that output to a consumer — the step's real failure is preserved in `status`. The same ABI is shared by JS actions (`runGuestNode`), so a user-space action writes outputs identically.

See [Workflow Syntax — `$WORK_OUTPUT`](../workflows/workflow-syntax.md#work_output) for the author-facing syntax.

### Interrupted vs. Failure

- **`interrupted`** — a VM tear-out or process kill (`StepInterrupted`). Resumable: re-invoking `run()` with the same `runId` reuses finished jobs and re-drives interrupted ones.
- **`failure`** — a step ran and exited non-zero, or a step threw a non-`StepInterrupted` error (a deterministic authoring error like a missing output). Terminal for that job.

This distinction drives the recovery UX (`resume` vs. `retry`).

## The Engine (`src/runtime/absurd/engine.ts`)

`AbsurdEngine` boots an in-process **PGLite** (WASM Postgres) with the Absurd schema, exposed over a Postgres wire-protocol socket.

| Property | Value |
|---|---|
| `app` | Orchestrator client (runs the DAG walk) |
| `jobsApp` | Separate queue client (runs individual job tasks) |
| `query` | Generic SQL for app-owned tables (`work.runs`, `work.run_events`, etc.) |
| `close` | Shuts down the socket |
| `pool.max` | 1 — PGLite is single-connection |
| `dataDir` | For persistence; omit for ephemeral in-memory |
| Schema version | Vendored at `absurd/schema.sql` (v0.4.0) |

### Separate Queues

The orchestrator runs on its own queue, separate from the `JOBS_QUEUE`. This prevents deadlock — an orchestrator awaiting jobs can't starve them of worker slots.

## Resume, Rerun, Retry

| Command | Behavior |
|---|---|
| `work resume <id>` | Re-invoke `run()` with the same `runId`. Finished jobs are reused (memoized); interrupted jobs are re-driven. |
| `work rerun <id>` | Fresh run with the same inputs but a **new** `runId`. Everything re-executes. |
| `work retry <id>` | Same `runId`, but `resetFailedJobs()` (`src/runtime/absurd/retry-failed.ts`) clears **only failed** job tasks' journal + the orchestrator task. A failed job is detected as either `state === "failed"` (an interruption) or `state === "completed" && status === "failure"` (a clean non-zero exit). Passing jobs are reused; only failed ones re-run. Skipped downstream jobs never spawned tasks. Returns `jobsReset` — the cleared job IDs (empty = nothing failed). |

`applyRecover()` in `src/cli.ts` looks up the prior run's workflow + inputs from history and folds them into the run args.

## The Execution Target (`src/targets/`)

### `ExecutionTarget` Interface

```typescript
interface ExecutionTarget {
  readonly kind: string;
  readonly workspacePath: string;       // guest mount path (/workspace)
  provision(): Promise<void>;            // boot the VM
  run(command, opts): Promise<RunResult>; // execute a step
  dispose(): Promise<void>;              // teardown (must be idempotent)
}
```

### GondolinTarget — The Only Target

`GondolinTarget` (`src/targets/gondolin.ts`) is the **only production target**. It runs steps inside a hardware-virtualized micro-VM (QEMU via `@earendil-works/gondolin`).

- Gondolin is an **optional dependency** — loaded **lazily** via dynamic `import()` inside `provision()`. The module is importable and tests pass without it.
- Guest workspace mounted at `/workspace` (read-write) via `RealFSProvider` (host filesystem passthrough).
- Commands run with `/bin/sh -lc` (login shell) — the `-l` flag sets up PATH so installed tools resolve.
- Egress policy: deny-by-default with `allowedHosts`, `allowedInternalHosts`, `hostResolves` (dial pins), and `secrets` (injected into outbound headers **host-side only**). **Network mediation is conditional** — `httpHooks` are only installed when one of `allowedHosts`, `allowedInternalHosts`, or `secrets` is configured. A job with none of these gets **open outbound network** (no hooks installed), which is how a plain `run: npm install` reaches the registry. Mediation scopes *injected secrets* to their host; it is not a sandbox over general egress for trusted workflow steps.
- `resolveImagePath` — lazily resolves/builds a `work:<image>` custom guest at provision time.

**No host-execution target exists.** `runs-on: local` is explicitly rejected. Every job runs in the sandbox — this is a security-first decision.

### Factory (`src/targets/factory.ts`)

`makeTarget(runsOn, ctx)` — `parseRunsOn` validates, then constructs `GondolinTarget`. Both `gondolin` and `work:<image>` run on the same Gondolin VM — they differ only in the guest image. The `TargetFactory` is overridable; tests inject a `HostTarget` double (runs commands as host child processes) via `run.ts`'s `makeTarget` option.

## Custom VM Images (`src/images/`)

`work:<variant>` images are managed through build-configs and Gondolin's own builder.

| Image | Source | Contents |
|---|---|---|
| `work:base` | `src/images/image-builtin/base/build-config.json` | Alpine 3.23, linux-virt kernel, bash, certs, curl, git, jq, nodejs, npm, uv, python3, openssh. The capable default. |
| `work:pi` | `src/images/image-builtin/pi/build-config.json` | `work:base` + globally pre-installed Pi coding agent. Used by agent steps to skip npm install. |
| `work:<custom>` | `.workflows/images/<name>/build-config.json` | User-defined. Scaffolds via `work create image <name>`. |

### How Images Build

`ensureImageTag()` (`src/images/build.ts`):
1. Resolves the build-config path — **user** images (`.workflows/images/<variant>/`) override **bundled** built-ins (`src/images/image-builtin/<variant>/`).
2. Injects host arch into a temp copy of the config (built-in configs ship arch-agnostic).
3. Calls `gondolin build` via the Gondolin CLI.
4. Reuses already-built tags (checks `gondolin image ls`).
5. Concurrent jobs share a single in-flight build via a `Map<string, Promise>`.

`listImages()` returns the union of user + bundled images. `work:base` is itself dogfood — an ordinary bundled config, not special-cased.

## Persistence (`src/persistence/`)

All repositories ride the engine's generic `query` seam (their own `work.*` tables, not Absurd's). Schemas are created idempotently on every boot.

| Repository | Table | Purpose |
|---|---|---|
| `RunRepository` | `work.runs` | Run metadata: id, workflow, status, trigger, timestamps, inputs, `event` (resolved trigger payload, so `${{ event.* }}` survives resume/rerun), error. `listNonTerminal()` returns all running/queued/interrupted runs (unbounded, oldest-first) for boot-time reconciliation. `list()` defaults to 200 rows newest-first. |
| `RunEventRepository` | `work.run_events` | Per-run event stream: `(run_id, seq)` → frame, for log replay. `has()` distinguishes a real past run from an unknown id. |
| `ScheduleRepository` | `work.schedules` | Per-`(workflow, cron)` last-fired baseline for the scheduler |
| `DeliveryRepository` | `work.webhook_deliveries` | Webhook delivery audit log (never payload/secret). `DeliveryResult` enum: `accepted` \| `duplicate` \| `unauthorized` \| `forbidden` \| `disabled` \| `not_opted_in` \| `too_large` \| `bad_request` \| `at_capacity` \| `test`. `listForHook()` defaults to 50 newest. |

`RunStatus` = `queued | running | success | failure | interrupted`. `RunTrigger` = `dispatch | webhook | schedule`.

Timestamps are `bigint` epoch-ms (sidesteps timestamptz parsing). `on conflict do nothing` for idempotent inserts. `RunEventRepository.clear(runId)` is used by `retry` to reset the log.

## Key Source References

| Area | Key files |
|---|---|
| Runtime interface | `src/runtime/types.ts` (`Runtime`, `RunHooks`, `StepInterrupted`, `UsesHandler`) |
| AbsurdRuntime | `src/runtime/absurd/runtime.ts` |
| AbsurdEngine | `src/runtime/absurd/engine.ts` |
| Retry failed jobs | `src/runtime/absurd/retry-failed.ts` |
| Absurd schema | `src/runtime/absurd/schema.sql` |
| Output capture | `src/runtime/output.ts` |
| Target interface | `src/targets/types.ts` |
| GondolinTarget | `src/targets/gondolin.ts` |
| Target factory | `src/targets/factory.ts` |
| Image registry | `src/images/registry.ts` |
| Image builder | `src/images/build.ts` |
| Built-in image configs | `src/images/image-builtin/base/build-config.json`, `src/images/image-builtin/pi/build-config.json` |
| Persistence repos | `src/persistence/runs.ts`, `src/persistence/run-events.ts`, `src/persistence/schedules.ts`, `src/persistence/deliveries.ts` |
| Design records | `docs/absurd-durable-workflows.md`, `docs/durable-orchestrator.md`, `docs/gondolin-secure-execution.md`, `docs/pglite-wasm-postgres-database.md`, `docs/gondolin-custom-images.md` |
