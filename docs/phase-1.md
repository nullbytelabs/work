# Phase 1 — walking skeleton

Goal: run the `hello-world` examples end-to-end through real architectural seams,
without committing to the durability backbone still under research
(Absurd-on-PGLite). The Gondolin target runs each job in a real micro-VM behind
the `ExecutionTarget` interface; tests drive a lightweight host-process double
through that same interface.

## What's here

```
src/
├── spec/        # YAML -> WorkflowSpec types, parser, validation
├── compiler/    # WorkflowSpec -> ExecutionPlan (env layering, needs topo-sort)
├── targets/     # ExecutionTarget: GondolinTarget (micro-VM) — the only target
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
| targets | "where" (`runs-on`) | `GondolinTarget` (secure micro-VM, optional dep loaded lazily) — every job runs in the sandbox; `runs-on: local` is rejected |

Runs on Node's native TypeScript support — no build step and no native-binary
dependencies, so the same `node_modules` works across platforms.

## Run it

```bash
npm install
./pi-workflows ./test/e2e/hello-world-gondolin/workflow.yaml          # ad-hoc: a file anywhere
./pi-workflows --workspace ./test/e2e/agent-project run ci         # by name (the workflow whose name: is ci)
./pi-workflows --workspace ./test/e2e/agent-project graph ci --steps  # inspect the DAG (no run)
npm test        # unit + integration suite (Node's built-in test runner)
npm run typecheck
```

Two launch styles: a bare `<workflow.yaml>` path (ad-hoc — run a file wherever it
lives), or `[--workspace <dir>] run <name>`, which resolves the `.workflows/*.yaml`
whose `name:` field matches (workspace defaults to the current directory, so from
inside a project it's just `pi-workflows run ci`). Both converge on the same
`{ workflowDir, workspaceSource }` layout (see "Project layout" below).

A run prints live: on an interactive terminal, a **DAG-aware status board** (jobs
by dependency depth, with state, step progress, target, and elapsed; finished step
logs scroll above); in CI or a pipe it falls back to **buffered per-job blocks**.
A third verb, `graph <file|name> [--format mermaid|dot|json|ascii] [--steps]`,
emits the compiled `needs` DAG for inspection instead of running it. Both the
board and the graph are documented in [`tui-iteration-2.md`](./tui-iteration-2.md).

Flags: `--inputs '<json>'` (workflow inputs), `--workdir <dir>` (default: a temp
dir), `--quiet` (suppress output); `--format` / `--steps` apply to `graph`. Exit
code is `0` on success, `1` on workflow failure, `2` on bad input.

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
`${{ inputs.<name> }}` and `${{ matrix.<axis> }}` are resolved at compile time
(dot or `['name']` form); `needs.*`/`steps.*` resolve at runtime; the `github`
context errors rather than passing through.
Idiomatic use is to map an input into a step `env` var, then reference `$NAME`
in the shell — see `test/e2e/with-inputs/`.

## Tests

`test/` covers each layer in isolation plus the whole pipeline, run via
`node --test`:

- `spec.test.ts` — parse + validation (errors carry a path; env coercion; misplaced `runs-on`)
- `compiler.test.ts` — env layering, default/override `runs-on`, step naming, topo order, cycle detection
- `targets.test.ts` — the host-process test double (exec/exit/env/streaming); factory target selection + `runs-on: local` rejection
- `integration.test.ts` — parse→compile→run on inline workflows; failure/skip semantics; needs ordering
- `examples.test.ts` — runs every local workflow in `test/e2e/` end-to-end (the examples double as e2e fixtures)
- `gondolin.test.ts` — GondolinTarget unit checks + an opt-in VM smoke test

## `runs-on`

Each job declares its own `runs-on` (there is no workflow-level default — a
top-level `runs-on` is rejected). A job that omits it falls back to `local`. Two
targets are supported:

- **`local`** — runs each step as a host `/bin/bash -lc` child process. Fast, no
  isolation. No extra dependencies. (`test/e2e/hello-world-gondolin/workflow.yaml`)
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
(`UserFacingError`) rather than a stack trace. The VM smoke tests always run as
part of the suite — they need Node ≥ 23.6 + QEMU on the machine:

```bash
npm test
```

CI provisions that for the `test` job (Node 25): it installs QEMU and enables
`/dev/kvm` on the x86_64 runner (Gondolin ships x86_64 guest images), then runs
`npm test`.

Steps run via `/bin/sh -lc` (portable lowest common denominator; the guest also
ships bash/node/python3), the per-job working directory is mounted at
`/workspace`, and the VM is always torn down
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
- Step kinds: `run` (shell on the target) and `uses: agent/<name>` (an LLM call).

## Outputs

GitHub-Actions-style, resolved at **runtime** (after the producing step/job runs):

- A `run` step writes to **`$WORK_OUTPUT`** (a file the engine reads back — it
  lives in the shared job workspace, so capture works uniformly on both targets), using
  `$GITHUB_OUTPUT` syntax: `key=value` for single-line values, or a heredoc for
  multi-line values (e.g. a whole source file to hand an agent):

  ```bash
  {
    echo "source<<EOF"
    cat main.ts
    echo "EOF"
  } >> "$WORK_OUTPUT"
  ```

- A job exposes `outputs:` mapping names to `${{ steps.<id>.outputs.<key> }}`.
- A dependent reads `${{ needs.<job>.outputs.<name> }}` (in `env`, `run`, `with`);
  multi-line values flow through unchanged.

So `${{ }}` is two-phase: `inputs.*` bind at compile time; `steps.*`/`needs.*`
resolve at runtime. Unknown roots still error. See `test/e2e/agent-project/`.

## Project layout (`.workflows/`)

A real project keeps its pipelines and agents in a `.workflows/` directory, the
analog of `.github/workflows/`. The CLI's `resolveWorkflowLayout` then treats the
**parent** of `.workflows/` as the project root — the checkout staged into each
job — so `npm install`, `npm start`, and source files are present, while agent
packages resolve from `.workflows/agents/`. A standalone `workflow.yaml` not in a
`.workflows/` folder uses its own directory as both. This convention also powers
`run <name>`: `findWorkflowByName` scans `<workspace>/.workflows/*.yaml` and
selects the one whose `name:` matches, then feeds it through the same resolver —
so name-based and path-based launches are the same code path, just a different
front door. The checkout is staged like
a fresh `git checkout`: `node_modules/` and `.git/` are never copied (each job
installs its own deps — copying a foreign `node_modules` breaks native binaries).
`test/e2e/agent-project/` is the worked example: two independent pipelines in
`.workflows/` — `ci.yaml` (`npm install` → `tsc` validity → `npm start` smoke) and
`review.yaml` (a workspace-aware agent reads `main.ts` and reviews it).

## Agent steps (`uses: agent/<name>`)

`uses: agent/summarize` runs an agent **package the project supplies** — a
directory beside the workflow definition, checked in like a GitHub Actions local
action. Packages are **not** shipped in the engine; the `agent` handler resolves
them relative to the workflow's directory (`<workflowDir>/agents/<name>/`). In
the full project shape that's `.workflows/agents/<name>/`:

```
<project root>/             # the checkout jobs run against (npm, source, …)
  package.json
  main.ts
  .workflows/               # workflowDir — like .github/workflows/
    ci.yaml                 # one or more pipelines (resolved by `name:`)
    review.yaml
    agents/
      summarize/
        agent.yaml          # manifest: description, declared inputs/outputs
        instructions.md     # system prompt (standing persona/policy)
        task.md             # task template; {{ input }} placeholders bound from `with`
        # skills/, extension.ts — reserved for future multi-turn / skills support
```

This is the boundary the user asked for: the engine ships the agent *handler*
(how to run an agent), the project ships the agent *packages* (what each agent
is). Remote sourcing (`agent/<name>@<ref>` from github/gitlab/codeberg) and
project/user override search paths are future work that lives entirely inside
the agent layer — `loadAgent(name, agentsDir)` already takes the search dir, so
adding a resolver (clone + cache → a local dir) doesn't touch the durable core.
See `test/e2e/agent-project/` for a project that brings its own `summarize`.

**The durable core is agent-agnostic.** It dispatches a `uses:` step to a
registered handler by **scheme** (`<scheme>/<…>`) via a small `UsesHandler`
contract (`src/runtime/types.ts`) and imports none of the agent/LLM/config code;
an unregistered scheme fails with `no handler registered for uses: …`. The
`agent` handler (`src/agent/uses-handler.ts`, `createAgentUsesHandler`) is
composed into the runtime at the edge (the CLI, or tests). So "what runs
durably" stays cleanly separated from "what a step happens to do."

The step's `with:` binds the package's declared inputs into `task.md`; the
package is loaded from disk through an `AgentRunner` seam. The **default runner
is the Pi coding-agent SDK** (`@earendil-works/pi-coding-agent`, an optional
dependency loaded lazily; needs Node ≥ 22.19): it registers an OpenAI-compatible
provider in memory and drives `session.prompt()`, which resolves only after the
full run **including retries**. The result is exposed as
`steps.<id>.outputs.summary`; a `length` finish adds a truncation warning. The
runner is injectable, so tests use a mock and never call inference. (Multi-turn,
Pi resource pass-through, and remote action sourcing are next — see
`docs/agent-primitive-and-actions.md`. Note: the engine deliberately does **not**
police an agent's tools — they run VM-isolated in-guest.)

**Config** (`--config <file>`, `$WORK_CONFIG`, or `./work.json`):

```json
{
  "providers": { "fireworks": { "baseUrl": "https://api.fireworks.ai/inference/v1", "apiKey": "$FIREWORKS_API_KEY" } },
  "models": { "kimi": { "provider": "fireworks", "model": "accounts/fireworks/models/kimi-k2p6" } },
  "defaultModel": "kimi"
}
```

`apiKey` supports `$VAR`/`${VAR}` expansion. Today's agent runs Pi's full
default toolset over the job's checkout; the direction for richer agents — a dumb
`work/agent` primitive plus user-space (composite/JS) actions — is designed in
`docs/agent-primitive-and-actions.md`.

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
  in `targets/factory.ts`. The guest ships sh/bash/node/npm/python3, so steps run
  in-sandbox without a custom image. Remaining Gondolin work: workspace artifact
  persistence across steps and per-job VM resource sizing. (See `docs/gondolin-secure-execution.md`.)
- **Agentic steps:** done — `uses: agent/<name>` resolves a project-local agent
  package (`instructions.md` + `task.md` + manifest), validates `with` against its
  declared inputs, and runs a real Pi session (full default toolset over the
  checkout) through a registered `uses:` handler — host-side or in-guest per
  `runs-on`. Still ahead: a dumb `work/agent` primitive, user-space (composite/JS)
  actions, and remote sourcing. (See `docs/agent-primitive-and-actions.md` for that
  direction, `docs/pi-coding-agent-sdk.md` for the Pi surface.)
- **`needs` DAG:** done — the runtime walks the dependency graph and runs
  independent jobs in parallel via worker `concurrency`. **`matrix` / `if`** are
  now executed too: the compiler expands `strategy.matrix` into one independent
  leg per cell (cartesian product + `include`/`exclude`), and the runtime
  evaluates `if`/`when` to gate jobs and steps. Still future work: matrix
  `max-parallel` / `fail-fast`.

## Known Phase 1 limitations

- Durable step checkpointing works, but **cross-process crash-resume** isn't
  wired yet (the cross-job orchestration lives in the runtime, not a durable
  task; needs a persistent dataDir + run id + `--resume`). The default PGLite is
  ephemeral in-memory per run.
- `strategy.matrix` expansion and `if:`/`when:` evaluation are implemented
  (cartesian product + `include`/`exclude`; a safe GHA-subset condition
  evaluator). Not yet: matrix `max-parallel` / `fail-fast`, and the `github`
  expression context. Agent `uses:` steps and `steps.*`/`needs.*`
  output passing **are** implemented (see the "Agent steps" and "Outputs"
  sections above). The `agent` handler runs Pi with its full default toolset
  rooted at the job workspace, so an agent reads/edits the checkout directly
  (e.g. `summarize` reviews `main.ts` in-place); what's not yet built is
  **multi-turn / multi-step** agent orchestration.
- Gondolin does not yet persist workspace artifacts across steps or size VM
  resources. (The guest image is well-equipped — sh/bash/node/npm/python3 — so
  steps run in the sandbox without a host toolchain.)
