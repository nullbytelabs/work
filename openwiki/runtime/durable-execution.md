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

### How It Works

- Each **job** is its own durable Absurd task (idempotency key: `${runId}:${jobId}`).
- Each **step** is a `ctx.step(name, fn)` checkpoint — completed steps are **memoized and never recomputed**.
- The whole run's DAG walk runs inside a **durable orchestrator task** (separate queue from job tasks to avoid deadlock).
- Jobs run in parallel (concurrency cap: 16) via worker tasks on a dedicated `JOBS_QUEUE`.
- **Heartbeats** every 150s (claim timeout 600s) keep long-running agent steps alive.

### Interrupted vs. Failure

- **`interrupted`** — a VM tear-out or process kill. Resumable: re-invoking `run()` with the same `runId` reuses finished jobs and re-drives interrupted ones.
- **`failure`** — a step ran and exited non-zero. Terminal for that job.

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
| `work retry <id>` | Same `runId`, but `resetFailedJobs()` (`src/runtime/absurd/retry-failed.ts`) clears **only failed** job tasks' journal + the orchestrator task. Passing jobs are reused; only failed ones re-run. Skipped downstream jobs never spawned tasks. |

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
- Guest workspace mounted at `/workspace` (read-write).
- Egress policy: deny-by-default with `allowedHosts`, `allowedInternalHosts`, `hostResolves` (dial pins), and `secrets` (injected into outbound headers **host-side only**).
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
| `RunRepository` | `work.runs` | Run metadata: id, workflow, status, trigger, timestamps, inputs, event, error |
| `RunEventRepository` | `work.run_events` | Per-run event stream: `(run_id, seq)` → frame, for log replay |
| `ScheduleRepository` | `work.schedules` | Per-`(workflow, cron)` last-fired baseline for the scheduler |
| `DeliveryRepository` | `work.webhook_deliveries` | Webhook delivery audit log (never payload/secret) |

`RunStatus` = `queued | running | success | failure | interrupted`. `RunTrigger` = `dispatch | webhook | schedule`.

Timestamps are `bigint` epoch-ms (sidesteps timestamptz parsing). `on conflict do nothing` for idempotent inserts. `RunEventRepository.clear(runId)` is used by `retry` to reset the log.

## Key Source References

| Area | Key files |
|---|---|
| Runtime interface | `src/runtime/types.ts` |
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
