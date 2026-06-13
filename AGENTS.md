# AGENTS.md

This file provides guidance to Pi (and compatible agents) when working with code in this repository.

## What this is

A local workflow engine: GitHub-Actions-style YAML workflows (jobs → steps), each job
isolated in a **gondolin** micro-VM, with durable crash-resumable execution and optional
**AI agent steps** that run a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent inside the sandbox. Published to npm as `@nullbytelabs/work` (the `work` command).
There is **no host-execution mode** — every job runs in a micro-VM (`runs-on: gondolin`,
also the default), so QEMU is required to run anything for real.

## Commands

Runs TypeScript directly via Node ≥ 23.6 native type-stripping — **no build step in development.**

```bash
npm test                 # unit + e2e — boots real micro-VMs, needs QEMU
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run build            # esbuild → dist/ (publish-only; see below)

# run the CLI in dev — invoke the bin shim directly (it runs src/cli.ts when
# there's no dist/, so no build step). This IS the `work` command.
./bin/work.mjs <args>
npm start -- <args>      # same thing via the start script
```

Uses whatever `node` is on your PATH — just keep it current (the shim wants ≥ 23.6,
where native TS type-stripping is on by default).

Run a single test file (each test is a plain `node:test` file):

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/compiler.test.ts
# narrow further by test name:
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-name-pattern "matrix" test/compiler.test.ts
```

`demo.sh` exercises the graph + run paths against `test/e2e/agent-project`. Per the project
memory, verify agent/runtime changes against `demo.sh` and a real run — not just the test suite.

### dist/ and publishing

Dev never touches `dist/`. A *published* package lives under `node_modules`, where Node refuses
to strip types, so `prepack` runs `scripts/build.mjs`: esbuild bundles `src/cli.ts` → `dist/cli.js`
(deps kept external) and copies two runtime assets loaded via `import.meta.url` —
`schema.sql` and `guest-runner-script.mjs` — flat next to it. `bin/work.mjs` prefers
`dist/cli.js` if present, else falls back to `src/cli.ts`. Publishing needs npm 2FA (`--otp`).

> **Footgun:** because the shim prefers `dist/`, running `npm run build` locally (e.g. to
> verify packaging) leaves a `dist/` that **shadows your `src/` edits** for `./bin/work.mjs`
> until you `rm -rf dist`. During development keep `dist/` absent so the shim runs `src/` live.

## Architecture

The CLI pipeline is a straight line (`src/cli.ts`): **resolve → read → parse → compile → run.**

```
spec/      parse + validate YAML into a typed WorkflowSpec
compiler/  WorkflowSpec → ExecutionPlan (the durable, runtime-ready DAG)
runtime/   ExecutionPlan → WorkflowResult (the durable executor)
targets/   where a job's steps actually run (gondolin micro-VM)
```

- **`src/spec/`** — `parseWorkflow()` turns YAML into a validated `WorkflowSpec`. Pure, no I/O
  beyond the text in.
- **`src/compiler/`** — `compile(spec, { inputs })` produces an `ExecutionPlan` of `PlannedJob`s /
  `PlannedStep`s. This is where **inputs are bound** (`inputs.ts`), **matrix** fan-out happens
  (`matrix.ts`), **`${{ }}` expressions** are parsed (`expr.ts`), and **`if:`/`when:` conditions**
  are evaluated (`condition.ts`). Inputs resolve at compile time; `needs.*`/`steps.*` expressions
  resolve later at runtime.
- **`src/runtime/`** — the only runtime is `AbsurdRuntime` (`absurd/runtime.ts`). Each **job** is a
  durable [Absurd](https://www.npmjs.com/package/absurd-sdk) task; each **step** is a memoized
  `ctx.step()` checkpoint, journaled to an in-process Postgres ([PGLite](https://www.npmjs.com/package/@electric-sql/pglite),
  schema in `absurd/schema.sql`) — no external services. It walks the `needs` DAG (independent jobs
  run in parallel up to a concurrency cap), threads each job's `outputs` to its dependents, and
  resolves runtime expressions. The cross-job walk itself runs inside a durable orchestrator task,
  so an interrupted run can be resumed (`work resume <id>`) — see `docs/durable-orchestrator.md`.
- **`src/targets/`** — `ExecutionTarget` abstraction. `GondolinTarget` is the real one (a micro-VM
  per job). `makeTarget` (`factory.ts`) maps `runs-on` → target; **tests inject a `HostTarget`
  double** via `makeTarget` rather than booting VMs. Per project memory: `runs-on: local` was removed
  — host execution is gone; only gondolin exists.

### The shared run path

`src/run.ts`'s `startRun()` is the **single** place that turns a compiled plan into a result. Both
the CLI and the web UI's `RunManager` call it, so they share exactly one config-load /
work-root / runtime-construction / close sequence. It deliberately owns **no presentation** —
callers pass `hooks` (the TUI presenter, or the web SSE sink). When given a shared `engine` it does
not own it (the web server boots one engine for all runs); otherwise it constructs and closes its own.

### Agent steps, actions, and egress

The agent surface is the dumb **`work/agent`** primitive (`src/agent/work-handler.ts`):
`uses: work/agent` runs a real Pi agent **inside the job's micro-VM**, rooted at the checkout
with its full toolset (`src/agent/`), prompted entirely through `with:` (a single
`prompt` or `promptFile`, plus `model`) — no package format, no separate system prompt.
Its final message
becomes the step's `output`. (The old engine-owned `agent/<name>` package format was removed —
see docs/agent-primitive-and-actions.md; don't reintroduce it.)

Richer, reusable behavior lives in **user-space actions** (`src/actions/`): `uses: action/<name>`
resolves a package under `.workflows/actions/<name>/` — either a **JavaScript** action
(`runs.using: node`, `INPUT_*`/`$WORK_OUTPUT` ABI) or a **composite** action (`runs.using: composite`,
a step bundle that can itself `uses: work/agent`). The engine also ships built-in `work/checkout`
and `work/install-node` actions (bundled under `src/actions/builtin/`, run through the same path).
A composite action's inner `uses:` sub-steps route through a late-bound dispatcher wired in `run.ts`.

Key security property: the model is reached only through gondolin's **mediated egress** — the
egress resolver (`makeAgentEgressResolver`) grants allow-all egress to any job with a `uses:` step
(work/action) and **injects the API key host-side**, scoped to the model host, so the key never
enters the guest. `startRun` composes that with a **datasource** egress resolver (`src/egress/`) so
an allowlisted `run:` step can reach a scoped datasource host with a header-injected token. Both are
deny-by-default. Per project memory: agents get the full toolset over their workspace — core does
**not** govern agent permissions, and you must never mock the agent runner.

**Before designing anything that touches sandbox networking, read
`docs/egress-data-path.md`.** The headline invariant: guest DNS is synthetic and
the host re-resolves the SNI hostname and dials from the engine process — the
guest-dialed IP is ignored, so host-loopback upstreams are reachable (that's
what datasource `resolve` pins are for) and no upstream ever needs to be made
"routable from the VM". Gondolin's behavior is checkable in
`node_modules/@earendil-works/gondolin/dist` — that source is the spec; verify
an assumed limitation there before building a workaround for it.

### Project layout resolution (`src/project.ts`)

Two ways to launch: a bare `<workflow.yaml>` path (ad-hoc), or `run <name>` which resolves the
`.workflows/*.yaml` whose `name:` matches. **The checkout differs:** a workflow inside `.workflows/`
checks out the **project root** (parent) into each job; a standalone file checks out its own folder.
`.git/` and `node_modules/` are never staged — jobs install their own deps.

### Other subsystems

- **`src/config/`** — provider/model config for agent steps (`work.json`, gitignored
  because it holds keys; commit `*.example.json`). Layered: global creds home + project override;
  `apiKey` supports `$VAR` expansion. `--no-global` for a hermetic run.
- **`src/tui/`** — presenters. A live DAG-aware board on an interactive TTY; buffered per-job
  blocks in CI/pipes; silent under `--quiet`. Pure consumer of runtime hooks.
- **`src/web/`** — `work --web` boots a local web console over a workspace's `.workflows/`,
  enumerating all pipelines. Adds **webhook triggers** and durable run **history** (PGLite under
  `.workflows/db/`, gitignored). The server owns one shared engine.
- **`src/graph/`** — `graph` subcommand: emit the compiled DAG as mermaid/dot/json/ascii instead of
  running.
- **`src/scaffold/` + `src/init/`** — `create <name>` and `init` (templates: `hello-world`,
  `agent-action`). **`src/doctor/`** — `doctor` preflight checks (QEMU, Node version, etc.).
- **`src/errors.ts`** — `UserFacingError` is caught in `main()` and printed cleanly (no stack);
  anything else prints as an unexpected error with a stack.

## UI work — use the `impeccable` skill

This repo has two frontend surfaces. For **any** design, UX, styling, layout, or
polish work on them, use the project-local **`impeccable`** skill
(`.claude/skills/impeccable/`) — it owns the design flow (setup, register, palette,
live browser iteration) and should drive UI changes rather than ad-hoc edits.

- **`src/web/client.ts`** — the `work --web` console. A single ~63 KB file holding the
  embedded HTML/CSS/JS, served as a string by `src/web/server.ts`. This is the app UI.
- **`docs-site/`** — the VitePress documentation site (`index.md`, `guide/`, `reference/`,
  custom theme in `.vitepress/`).

## Conventions

- ESM throughout, `"type": "module"`. Imports use **explicit `.ts` extensions** (native
  type-stripping requires them) — match that when adding imports.
- Each subsystem has an `index.ts` barrel that re-exports its public surface; import from the
  barrel, not deep paths, across subsystem boundaries.
- `test/e2e/` is a gallery of runnable example workflows (matrix, fan-out/fan-in, conditionals,
  typed inputs, agent project, …); `test/examples.test.ts` drives them. Add an e2e folder when
  adding a workflow feature.
- Keep status comments truthful (project memory): scrub stale "not-yet/phase-N/no-tools" comments
  when you ship the thing they describe.
- **Examples never drive core features.** Before adding engine surface to make an
  `examples/` workflow work, apply the deletion test: if the example were deleted
  tomorrow, would the feature still be worth having, with independent precedent
  (datasource `resolve` passes — curl `--resolve`, docker `--add-host`)? If not,
  the example's constraint is probably a wrong assumption — verify it empirically
  first (a one-line probe beats an architecture).
- Deep-dive design docs live in `docs/` (e.g. `gondolin-secure-execution.md`,
  `pi-in-gondolin.md`, `absurd-durable-workflows.md`, `agent-primitive-and-actions.md`,
  `reusable-workflows.md`) — see `docs/README.md` for the index.
