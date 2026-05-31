# Phase 1 — walking skeleton

Goal: run the `hello-world` examples end-to-end through real architectural seams,
without committing to the durability backbone still under research
(Absurd-on-PGLite). The local target needs no external infrastructure; the
Gondolin target adds a real micro-VM behind the same interface.

## What's here

```
src/
├── spec/        # YAML -> WorkflowSpec types, parser, validation
├── compiler/    # WorkflowSpec -> ExecutionPlan (env layering, needs topo-sort)
├── targets/     # ExecutionTarget: LocalTarget (host) + GondolinTarget (micro-VM)
├── runtime/     # Runtime interface + DirectRuntime (in-process, sequential)
├── errors.ts    # UserFacingError (clean CLI messages vs. unexpected stack traces)
└── cli.ts       # read -> parse -> compile -> run
```

The four layers are the same seams the README's architecture describes. Phase 1
fills each with its simplest honest implementation:

| Layer | README role | Phase 1 |
|---|---|---|
| spec | "what to run" | full parse + validation of `name`/`env`/`jobs`/`steps`; `needs`/`runs-on`/`uses`/`if` are modeled and validated but only partially acted on |
| compiler | "spec → task graph" | runtime-agnostic `ExecutionPlan`: env layering, default `runs-on`, stable step names, deterministic topo order |
| runtime | "how durably" | `DirectRuntime` runs in-process, no persistence |
| targets | "where" (`runs-on`) | `LocalTarget` (host process) and `GondolinTarget` (secure micro-VM, optional dep loaded lazily) |

Runs on Node's native TypeScript support — no build step and no native-binary
dependencies, so the same `node_modules` works across platforms.

## Run it

```bash
npm install
./pi-workflows ./examples/hello-world-local.yaml
npm test        # unit + integration suite (Node's built-in test runner)
npm run typecheck
```

Flags: `--workdir <dir>` (default: a temp dir), `--quiet` (suppress streaming).
Exit code is `0` on success, `1` on workflow failure, `2` on bad input.

## Tests

`test/` covers each layer in isolation plus the whole pipeline, run via
`node --test`:

- `spec.test.ts` — parse + validation (errors carry a path; env coercion; misplaced `runs-on`)
- `compiler.test.ts` — env layering, default/override `runs-on`, step naming, topo order, cycle detection
- `targets.test.ts` — LocalTarget exec/exit/env/streaming; factory target selection
- `integration.test.ts` — parse→compile→run on inline + the real example; failure/skip semantics; needs ordering

## `runs-on`

A job declares `runs-on`; a workflow-level `runs-on` sets the default for jobs
that omit their own. Two targets are supported:

- **`local`** — runs each step as a host `/bin/bash -lc` child process. Fast, no
  isolation. No extra dependencies. (`examples/hello-world-local.yaml`)
- **`gondolin`** — runs each step inside a hardware-virtualized Alpine micro-VM
  via `@earendil-works/gondolin` (QEMU). Secure, deny-by-default networking.
  (`examples/hello-world-gondolin.yaml`)

### Running the Gondolin example

Gondolin is an **optional dependency** loaded lazily — nothing imports or boots
it unless a workflow uses `runs-on: gondolin`. It requires:

- **Node ≥ 23.6** (native TypeScript + the SDK's own engine floor)
- **QEMU** on the host: `brew install qemu` (macOS) / `apt install qemu-system-*` (Linux)
- the package installed: it's in `optionalDependencies`, so a normal
  `npm install` pulls it; if it can't install on a platform, the rest still works.

```bash
./pi-workflows ./examples/hello-world-gondolin.yaml
```

If the package isn't available, the engine fails fast with an actionable message
(`UserFacingError`) rather than a stack trace. The VM smoke test is opt-in:

```bash
PI_WF_TEST_GONDOLIN=1 npm test
```

Steps run via `/bin/sh -lc` (the minimal Alpine guest has no bash), the per-job
working directory is mounted at `/workspace`, and the VM is always torn down
(`vm.close()`) in a `finally`. Network is deny-by-default; HTTP allowlists and
header-only secret injection (`createHttpHooks`) are wired in the target config
for when steps need egress.

## Semantics

- Steps in a job run sequentially; a failing step (`exitCode != 0`) fails the
  job and skips its remaining steps.
- A failed job marks the workflow failed and skips not-yet-started jobs.
- Env layers `workflow ← job ← step`, the later layer winning.
- `run` steps only. `uses` (agentic) steps are recognized and rejected.

## The Phase 2 upgrade path (deliberate boundaries)

Phase 1 was written so durability and sandboxing drop in by *substitution*, not
rewrite:

- **Durability:** add an `AbsurdRuntime implements Runtime`. The compiled
  `ExecutionPlan` already carries everything it needs — a job becomes an Absurd
  child task, a step becomes `ctx.step(name, fn)` (step names are already stable
  and unique), and `jobOrder` drives the spawn/await sequence. The CLI does not
  change. (See `docs/absurd-durable-workflows.md`.)
- **Sandboxing:** done — `GondolinTarget implements ExecutionTarget`, registered
  in `targets/factory.ts`. Remaining Gondolin work: a curated guest image with
  language runtimes (default Alpine is minimal), workspace artifact persistence
  across steps, and per-job VM resource sizing. (See `docs/gondolin-secure-execution.md`.)
- **Agentic steps:** `uses` steps route into Pi from inside a step body.
  (See `docs/pi-coding-agent-sdk.md`.)
- **`needs` DAG / matrix / `if`:** the spec and plan already model these; the
  runtime gains the logic to await dependencies and expand matrices.

## Known Phase 1 limitations

- No persistence / crash recovery (that is the whole point of the Absurd layer).
- `needs` order is computed and respected, but jobs still run sequentially —
  there is no parallel fan-out yet.
- No `uses` (agentic) steps, no `matrix`, no `if` evaluation, no step-`outputs`
  passing between steps/jobs.
- Gondolin runs on the minimal Alpine guest image (no language runtimes) and
  does not yet persist workspace artifacts across steps or size VM resources.
