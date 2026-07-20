# AGENTS.md

This file provides guidance to Pi (and compatible agents) when working with code in this repository.

## What this is

A local workflow engine: YAML workflows (jobs → steps, a `needs` DAG — the syntax will
feel familiar if you know GitHub Actions), each job
isolated in a **gondolin** micro-VM, with durable crash-resumable execution and optional
**AI agent steps** that run a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent inside the sandbox. Published to npm as `@nullbytelabs/work` (the `work` command).
There is **no host-execution mode** — every job runs in a micro-VM (`runs-on: gondolin`,
also the default), so QEMU is required to run anything for real.

## Commands

Runs TypeScript directly via Node ≥ 23.6 native type-stripping — **no build step in development.**

```bash
npm test                 # full suite: unit + e2e — always boots real micro-VMs, needs QEMU
npm run test:unit        # fast inner loop: everything EXCEPT the VM tier (WORK_SKIP_VM)
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run knip             # unused files / exports / deps
npm run check            # lint + typecheck + knip + the three reports below (full static pass)
npm run fan-in           # report-only: afferent coupling of exported symbols (see below)
npm run sloc             # report-only: SLOC distribution — largest files + percentiles (see below)
npm run jscpd            # report-only: copy/paste duplication across src/ TypeScript (see below)
npm run build            # esbuild → dist/ (publish-only; see below)

# Run the CLI: prefer the globally installed `work` command. Use the bin shim
# only for development tasks where you need to verify changes to src/cli.ts
# before the package is installed (e.g. editing the CLI and running it inline).
# The shim runs src/cli.ts when dist/ is absent (no build step required), but
# when `which work` succeeds, that's what should be used — the global install
# is the published `@nullbytelabs/work` package and the one users actually run.
work <args>
# fallback for dev-only verification:
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

Per the project memory, verify agent/runtime changes against a real run — the graph + run
paths against `test/e2e/agent-project`, not just the test suite.

### Structural reports — `fan-in`, `sloc`, `jscpd` (refinement aids, not gates)

`npm run check` runs the static gate (lint, typecheck, knip) and then three **report-only**
analyses that always exit 0 — they print numbers to read, they never fail CI:

- **`fan-in`** — afferent coupling per exported symbol: which types other modules lean on.
  A thin heavy tail = a few load-bearing types; a single dominant node = a god object worth
  breaking up. Read it before changing a high-fan-in symbol — that's the blast radius.
- **`sloc`** — source-line distribution: the largest files, per-file percentiles, and a
  by-subsystem rollup. It flags the files that have grown into split candidates.
- **`jscpd`** — copy/paste duplication across `src/` TypeScript (config in `.jscpd.json`,
  token-based Rabin-Karp, `minTokens: 50`). Surfaces the clone % + each clone's locations.
  No threshold is set, so it's report-only like the other two; the clone % is the trend to
  watch. (The `| awk …` in the script just trims jscpd's promo footer — `awk` is whitelisted
  in `knip.json`'s `ignoreBinaries`. Run `npx jscpd --silent` for a one-line summary.)

Reach for them **during** refactoring and when adding surface, not only at commit time:
`fan-in` tells you what a change ripples into, `sloc` tells you what's getting too big to
hold in one head, `jscpd` tells you what's been copy-pasted instead of factored. `fan-in`
and `sloc` are dependency-free (they reuse the project's own `typescript`); `jscpd` is an
MIT, fully-local dev dependency (no SaaS, no phone-home). All three run in CI's lint job, so
the trend lives in the run logs — watch the shape over time, judged by hand, never as a
pass/fail threshold.

### dist/ and publishing

Dev never touches `dist/`. A *published* package lives under `node_modules`, where Node refuses
to strip types, so `prepack` runs `scripts/build.mjs`: esbuild bundles `src/cli.ts` → `dist/cli.js`
(deps kept external) and copies two runtime assets loaded via `import.meta.url` —
`schema.sql` and `guest-runner-script.mjs` — flat next to it. `bin/work.mjs` prefers
`dist/cli.js` if present, else falls back to `src/cli.ts`.

**Releasing is automated — never `npm publish` by hand.** Cut a release by (1) bumping the
version in a normal commit on `main` (`package.json` + `package-lock.json` + the docs-site
nav label in `.vitepress/config.ts` — see the `release: vX.Y.Z` commits), then (2) pushing a
matching `vX.Y.Z` tag. The tag push triggers `.github/workflows/release.yml`, which verifies
the tag equals `package.json`'s version, builds, runs `npm publish --provenance` (auth via the
`NPM_TOKEN` secret + OIDC build provenance — no local 2FA/`--otp`), and creates the GitHub
Release with auto-generated notes. So the agent's job at release time is the version-bump commit
and (when asked to cut the release) pushing the `vX.Y.Z` tag; the publish itself is CI's.

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

Key security property: egress is **open** — `makeAgentEgressResolver` (`src/agent/egress.ts`,
wired directly in `run.ts`) grants allow-all egress (`["*"]`) to every job. The load-bearing
control is **host-side key injection**: for any model-running step the model's API key is injected
host-side under a per-host env-var name, scoped to that one model host, so the **real key never
enters the guest** (gondolin swaps the placeholder into the Authorization header for that host only).
Credentials a step or action needs flow through the **`secrets:` whitelist** in `work.json` —
each `secrets.NAME` is a literal or `$VAR` env ref resolved host-side, referenced as
`${{ secrets.NAME }}` and passed into a step's `env:` or an action's `with:`. Per project memory:
agents get the full toolset over their workspace — core does **not** govern agent permissions, and
you must never mock the agent runner.

**Before designing anything that touches sandbox networking, read
`docs/egress-data-path.md`.** The headline invariant: guest DNS is synthetic and
the host re-resolves the SNI hostname and dials from the engine process — the
guest-dialed IP is ignored, so no upstream ever needs to be made "routable from
the VM". Gondolin's behavior is checkable in
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
- **`src/scaffold/` + `src/init/`** — `create <noun> <name>` (`workflow` [+ `--webhook`],
  `image`, `webhook`) and `init`. Workflow templates: `hello-world`,
  `agent-action`. The `webhook` generator merges a keyed section into
  `work.json` via the merge-writer (`config-merge.ts`); `image` scaffolds an
  arch-agnostic `.workflows/images/<name>/build-config.json`. **`src/doctor/`** —
  `doctor` preflight checks (QEMU, Node version, etc.).
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

> **After editing anything under `docs-site/`, run the docs build before pushing** —
> `cd docs-site && npm run docs:build`. The main gate (`typecheck`/`lint`/`test`)
> does **not** cover VitePress, so a markdown break compiles clean locally yet fails
> CI. The classic footgun: VitePress (Vue) parses `{{ … }}` as an interpolation even
> inside markdown inline code, so a literal `${{ expr }}` in prose breaks the build
> (a non-identifier like `${{ secrets.* }}` is a hard parse error). Write it as
> `<code v-pre>${{ … }}</code>` in prose (escape `<`/`>` as `&lt;`/`&gt;`); fenced
> code blocks are already safe.

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
  tomorrow, would the feature still be worth having, with independent precedent?
  If not, the example's constraint is probably a wrong assumption — verify it
  empirically first (a one-line probe beats an architecture).
- Deep-dive design docs live in `docs/` (e.g. `gondolin-secure-execution.md`,
  `pi-in-gondolin.md`, `absurd-durable-workflows.md`, `agent-primitive-and-actions.md`,
  `reusable-workflows.md`) — see `docs/README.md` for the index.

## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:
- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
