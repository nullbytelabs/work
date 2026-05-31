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
├── runtime/     # Runtime interface + AbsurdRuntime (Absurd + PGLite) + vendored schema.sql
├── errors.ts    # UserFacingError (clean CLI messages vs. unexpected stack traces)
└── cli.ts       # read -> parse -> compile -> run
```

The four layers are the same seams the README's architecture describes. Phase 1
fills each with its simplest honest implementation:

| Layer | README role | Phase 1 |
|---|---|---|
| spec | "what to run" | full parse + validation of `name`/`inputs`/`env`/`jobs`/`steps`; `needs`/`runs-on` acted on; `uses`/`if` modeled but rejected at parse/compile |
| compiler | "spec → task graph" | runtime-agnostic `ExecutionPlan`: env layering, default `runs-on`, stable step names, deterministic topo order |
| runtime | "how durably" | `AbsurdRuntime` on Absurd + in-process PGLite; steps are durable `ctx.step` checkpoints (memoized across retries) |
| targets | "where" (`runs-on`) | `LocalTarget` (host process) and `GondolinTarget` (secure micro-VM, optional dep loaded lazily) |

Runs on Node's native TypeScript support — no build step and no native-binary
dependencies, so the same `node_modules` works across platforms.

## Run it

```bash
npm install
./pi-workflows ./test/e2e/hello-world-local/workflow.yaml
npm test        # unit + integration suite (Node's built-in test runner)
npm run typecheck
```

Flags: `--inputs '<json>'` (workflow inputs), `--workdir <dir>` (default: a temp
dir), `--quiet` (suppress streaming). Exit code is `0` on success, `1` on
workflow failure, `2` on bad input.

## Inputs

A workflow declares `inputs:` and reads them with `${{ inputs.<name> }}`:

```yaml
inputs:
  name:                 # shorthand: optional string
  age: 36               # scalar shorthand: number input, default 36 (type inferred)
  count: { type: number, required: true, default: 3, description: "…" }
  release: { options: [dev, staging, prod], required: true }   # enum
  id: { pattern: "^[0-9a-fA-F-]{36}$" }                        # regex (a UUID is just a pattern)
```

Types are `string | boolean | number`. Values are passed as a JSON object
(`--inputs '{"name":"josh","age":40}'`) and validated against the declarations:
unknown inputs, missing-`required`, **type mismatches**, out-of-`options`, and
`pattern` mismatches all error. Typing is **strict**, with no coercion (a string
`"40"` is rejected for a `number` input). `pattern` is a regex (`test`, so include
anchors) and applies to string inputs — it's the single general validator, so the
engine ships **no named-`format` registry** to grow. An *absent optional* input
isn't validated (an optional pattern-constrained input that wasn't provided
resolves to `""` rather than failing).
Resolved values are **interpolated at compile time** into `run` and `env`, so the
durable plan contains concrete values and the runtime never sees an expression.
Only `${{ inputs.<name> }}` is supported today (dot or `['name']` form); any other
expression context (`matrix`, `github`, …) errors rather than passing through.
Idiomatic use is to map an input into a step `env` var, then reference `$NAME`
in the shell — see `test/e2e/with-inputs/`.

## Tests

`test/` covers each layer in isolation plus the whole pipeline, run via
`node --test`:

- `spec.test.ts` — parse + validation (errors carry a path; env coercion; misplaced `runs-on`)
- `compiler.test.ts` — env layering, default/override `runs-on`, step naming, topo order, cycle detection
- `targets.test.ts` — LocalTarget exec/exit/env/streaming; factory target selection
- `integration.test.ts` — parse→compile→run on inline workflows; failure/skip semantics; needs ordering
- `examples.test.ts` — runs every local workflow in `test/e2e/` end-to-end (the examples double as e2e fixtures)
- `gondolin.test.ts` — GondolinTarget unit checks + an opt-in VM smoke test

## `runs-on`

Each job declares its own `runs-on` (there is no workflow-level default — a
top-level `runs-on` is rejected). A job that omits it falls back to `local`. Two
targets are supported:

- **`local`** — runs each step as a host `/bin/bash -lc` child process. Fast, no
  isolation. No extra dependencies. (`test/e2e/hello-world-local/workflow.yaml`)
- **`gondolin`** — runs each step inside a hardware-virtualized Alpine micro-VM
  via `@earendil-works/gondolin` (QEMU). Secure, deny-by-default networking.
  (`test/e2e/hello-world-gondolin/workflow.yaml`)

### Running the Gondolin example

Gondolin is an **optional dependency** loaded lazily — nothing imports or boots
it unless a workflow uses `runs-on: gondolin`. It requires:

- **Node ≥ 23.6** (native TypeScript + the SDK's own engine floor)
- **QEMU** on the host: `brew install qemu` (macOS) / `apt install qemu-system-*` (Linux)
- the package installed: it's in `optionalDependencies`, so a normal
  `npm install` pulls it; if it can't install on a platform, the rest still works.

```bash
./pi-workflows ./test/e2e/hello-world-gondolin/workflow.yaml
```

If the package isn't available, the engine fails fast with an actionable message
(`UserFacingError`) rather than a stack trace. The VM smoke tests are opt-in:

```bash
PI_WF_TEST_GONDOLIN=1 npm test
```

CI runs the full suite with these enabled: the `test` job (Node 25) installs
QEMU and enables `/dev/kvm` on the x86_64 runner (Gondolin ships x86_64 guest
images), then runs `PI_WF_TEST_GONDOLIN=1 npm test`.

Steps run via `/bin/sh -lc` (the minimal Alpine guest has no bash), the per-job
working directory is mounted at `/workspace`, and the VM is always torn down
(`vm.close()`) in a `finally`. Network is deny-by-default; HTTP allowlists and
header-only secret injection (`createHttpHooks`) are wired in the target config
for when steps need egress.

## Semantics

- Steps in a job run sequentially; a failing step (`exitCode != 0`) fails the
  job and skips its remaining steps.
- Independent jobs run **in parallel** (Absurd worker `concurrency` + fan-out);
  the `needs` DAG gates ordering. A job is **skipped** only if one of its
  dependencies failed or was skipped — independent jobs are unaffected. The
  workflow fails if any job failed.
- Env layers `workflow ← job ← step`, the later layer winning.
- `run` steps only. `uses` (agentic) steps are recognized and rejected.

## The Phase 2 upgrade path (deliberate boundaries)

Phase 1 was written so durability and sandboxing drop in by *substitution*, not
rewrite:

- **Durability:** done — `AbsurdRuntime implements Runtime` runs every workflow
  as one Absurd task with each `<job>/<step>` as a durable `ctx.step` checkpoint,
  on an in-process PGLite (vendored `schema.sql` @ 0.4.0). Remaining: cross-process
  **crash-resume** (a persistent dataDir + a run id + `--resume`), and a server
  Postgres provider option for production. (See `docs/absurd-durable-workflows.md`
  and `docs/pglite-wasm-postgres-database.md`.)
- **Sandboxing:** done — `GondolinTarget implements ExecutionTarget`, registered
  in `targets/factory.ts`. Remaining Gondolin work: a curated guest image with
  language runtimes (default Alpine is minimal), workspace artifact persistence
  across steps, and per-job VM resource sizing. (See `docs/gondolin-secure-execution.md`.)
- **Agentic steps:** `uses: agent/<name>@<ref>` resolves a named, versioned
  agent package (system prompt + tools + model default), validates `with`
  against its declared inputs at compile time, and routes into a Pi session from
  inside a step body. The parse layer gains `AgentRef` syntax validation, the
  compiler resolves the package and emits an `AgentStep`, and `direct.ts` gains
  the branch that currently rejects `uses`. (See
  `docs/agent-uses-interface.md` for the interface, `docs/pi-coding-agent-sdk.md`
  for the Pi surface.)
- **`needs` DAG:** done — the runtime walks the dependency graph and runs
  independent jobs in parallel via worker `concurrency`. **`matrix` / `if`** are
  still modeled-but-not-executed (matrix expansion and conditional evaluation
  are future work).

## Known Phase 1 limitations

- Durable step checkpointing works, but **cross-process crash-resume** isn't
  wired yet (the cross-job orchestration lives in the runtime, not a durable
  task; needs a persistent dataDir + run id + `--resume`). The default PGLite is
  ephemeral in-memory per run.
- No `uses` (agentic) steps, no `matrix`, no `if` evaluation, no step-`outputs`
  passing between steps/jobs.
- Gondolin runs on the minimal Alpine guest image (no language runtimes) and
  does not yet persist workspace artifacts across steps or size VM resources.
