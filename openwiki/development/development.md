---
type: Developer Guide
title: Development & Testing
description: Developer workflow reference for the work engine — npm commands, running the CLI and single tests in dev, the unit/property/integration/E2E/web test tiers, static structural reports (fan-in, sloc, jscpd), build and automated release process, coding conventions, dogfooded CI (.workflows/), GitHub Actions CI, Pi agent integration, and key source file references.
resource: package.json
tags: [development, testing, ci, build, release, conventions, dogfooding, cli]
---

# Development & Testing

## Commands

The project runs TypeScript directly via Node ≥ 23.6 native type-stripping — **no build step in development.**

```bash
npm test                 # full suite: unit + e2e — always boots real micro-VMs, needs QEMU
npm run test:unit        # fast inner loop: everything EXCEPT the VM tier (WORK_SKIP_VM=1)
npm run test:web         # Playwright tests for the web UI
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run knip             # unused files / exports / deps
npm run check            # lint + typecheck + knip + fan-in + sloc + jscpd (full static pass)
npm run fan-in           # report-only: afferent coupling of exported symbols
npm run sloc             # report-only: SLOC distribution — largest files + percentiles
npm run jscpd            # report-only: copy/paste duplication across src/ TypeScript
npm run build            # esbuild → dist/ (publish-only)
```

### Running the CLI in Dev

```bash
./bin/work.mjs <args>      # runs src/cli.ts directly (no dist/, no build step)
npm start -- <args>        # same thing via the start script
```

The shim prefers `dist/cli.js` if present, else falls back to `src/cli.ts`. **During development keep `dist/` absent** so the shim runs `src/` live — running `npm run build` locally leaves a `dist/` that shadows your `src/` edits until you `rm -rf dist`.

### Running a Single Test

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/compiler.test.ts
# narrow by test name:
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-name-pattern "matrix" test/compiler.test.ts
```

### Verifying Agent/Runtime Changes

Per project memory: verify agent/runtime changes against a real run — the graph + run paths against `test/e2e/agent-project`, not just the test suite.

## Test Tiers

The suite is a pyramid: wide unit base, diamond integration waist, pinpoint VM tip.

| Tier | Files | How | Speed |
|---|---|---|---|
| **Unit** | `test/*.test.ts` (~45 files) | Deterministic logic tests. Use injected `HostTarget` double (no QEMU). | Fast |
| **Property-based** | `test/*.property.test.ts` (8 files) | `fast-check` property tests for pure compiler/spec surfaces. | Fast |
| **Integration** | `test/integration.test.ts`, `test/durable-resume.test.ts`, `test/in-guest-agent.test.ts`, `test/reusable.test.ts` | Multi-component (runtime + persistence + targets). | Medium |
| **E2E (real VM)** | `test/e2e/` (22 example folders) | Real VM end-to-end tests. `test/examples.test.ts` auto-discovers them. Doubles as documentation. | Slow |
| **Web E2E** | `test/web-e2e/` | Playwright tests for the web UI. | Medium |

### Fast Inner Loop

`npm run test:unit` sets `WORK_SKIP_VM=1` to skip the VM tier entirely. Use this for the inner loop; run `npm test` before pushing.

### Test Support (`test/_support.ts`)

- Boots one PGLite-backed Absurd engine per test file.
- `HostTarget` — test-only target that runs commands as host child processes (no QEMU).
- `mockAgentRunner` — deterministic agent runner stub (no network). **Never mock the agent runner in production paths.**
- `vmTestSkip()` — helper for conditionally skipping VM tests.

### E2E Fixture Gallery (`test/e2e/`)

Each folder is a runnable example workflow: `hello-world-gondolin/`, `fan-out-fan-in/`, `matrix-build/`, `agent-project/`, `work-base-image/`, `work-pi-image/`, etc. Add an e2e folder when adding a workflow feature. See [Workflow Syntax](../workflows/workflow-syntax.md).

## Structural Reports (refinement aids, not gates)

`npm run check` runs the static gate (lint, typecheck, knip) and then three **report-only** analyses that always exit 0 — they print numbers to read, never fail CI:

- **`fan-in`** — afferent coupling per exported symbol: which types other modules lean on. Read it before changing a high-fan-in symbol — that's the blast radius.
- **`sloc`** — source-line distribution: the largest files, per-file percentiles, by-subsystem rollup. Flags files that are split candidates.
- **`jscpd`** — copy/paste duplication across `src/` TypeScript (`.jscpd.json`, token-based Rabin-Karp, `minTokens: 50`). The clone % is the trend to watch.

Reach for them **during** refactoring and when adding surface, not only at commit time. All three run in CI's lint job, so the trend lives in the run logs.

## Building & Publishing

Dev never touches `dist/`. A *published* package lives under `node_modules`, where Node refuses to strip types, so `prepack` runs `scripts/build.mjs`: esbuild bundles `src/cli.ts` → `dist/cli.js` (deps kept external) and copies runtime assets loaded via `import.meta.url` — `schema.sql`, `guest-runner-script.mjs`, builtin actions, and image build-configs — flat next to it.

### Releasing

**Releasing is automated — never `npm publish` by hand.**

1. Bump the version in a normal commit on `main` (`package.json` + `package-lock.json` + the docs-site nav label in `.vitepress/config.ts` — see the `release: vX.Y.Z` commits).
2. Push a matching `vX.Y.Z` tag.
3. The tag push triggers `.github/workflows/release.yml`, which verifies the tag equals `package.json`'s version, builds, runs `npm publish --provenance` (auth via `NPM_TOKEN` secret + OIDC build provenance), and creates the GitHub Release with auto-generated notes.

The agent's job at release time is the version-bump commit and (when asked to cut the release) pushing the `vX.Y.Z` tag; the publish itself is CI's.

## Conventions

- **ESM throughout**, `"type": "module"`. Imports use **explicit `.ts` extensions** (native type-stripping requires them).
- Each subsystem has an `index.ts` barrel that re-exports its public surface; import from the barrel, not deep paths, across subsystem boundaries.
- `test/e2e/` is a gallery of runnable example workflows. Add an e2e folder when adding a workflow feature.
- Keep status comments truthful — scrub stale "not-yet/phase-N/no-tools" comments when you ship the thing they describe.
- **Examples never drive core features.** Before adding engine surface to make an `examples/` workflow work, apply the deletion test: if the example were deleted tomorrow, would the feature still be worth having, with independent precedent?
- Deep-dive design docs live in `docs/` (architecture rationale, threat models, trade-offs). See `docs/README.md` for the index.
- `UserFacingError` (`src/errors.ts`) is caught in `main()` and printed cleanly (no stack). Use it for actionable conditions meant for end users.

## UI Work

For **any** design, UX, styling, layout, or polish work on the two frontend surfaces (`src/web/client.ts` and `docs-site/`), use the project-local **`impeccable`** skill (`.claude/skills/impeccable/`) — it owns the design flow.

> **After editing anything under `docs-site/`, run the docs build before pushing** — `cd docs-site && npm run docs:build`. The main gate does **not** cover VitePress, so a markdown break compiles clean locally yet fails CI. The classic footgun: VitePress parses `{{ … }}` as interpolation even in inline code — write `${{ … }}` as `<code v-pre>${{ … }}</code>` in prose.

## Dogfooded CI (`.workflows/`)

The repo dogfoods itself — `.workflows/` holds the project's own CI pipelines:

| Workflow | Purpose |
|---|---|
| `ci.yaml` | Top-level CI (`work run ci`). Triggered by `on: webhook`. Calls reusable workflows: `checks` → `test` → `docs`. |
| `checks.yaml` | Reusable static-checks — lint, typecheck, knip, fan-in, sloc as separate steps. Hard gate. |
| `test.yaml` | Reusable test workflow — full suite self-hosted in nested gondolin VMs (`work:nested` image with QEMU). |
| `docs.yaml` | Reusable docs-build — renders VitePress in a VM. |
| `review.yaml` + domain-specific review workflows | Agent code review — run on demand, use AI to review code changes. |
| `trace-analysis.yaml` | Tempo trace analysis via a composite action. |
| `images/nested/` | `work:nested` custom image — `work:base` + QEMU for nested VM testing. |

## GitHub Actions CI (`.github/workflows/`)

| File | Purpose |
|---|---|
| `ci.yml` | `lint-and-typecheck` (gate: lint/typecheck/knip; report-only: fan-in/sloc/jscpd), `docs` (VitePress build check), `test` (full `npm test` with QEMU), `e2e`. Node 25, npm ci, concurrency cancellation. |
| `docs.yml` | Deploys VitePress docs on push-to-main. |
| `release.yml` | npm publish on tag push. |

## Pi Agent Integration (`.pi/`)

The repo includes Pi skills and prompts for developing the engine itself:

- `.pi/skills/work/SKILL.md` — meta-skill for developing the `work` engine (dev/verify loop, test tiers, dogfooding).
- `.pi/skills/gondolin/SKILL.md`, `.pi/skills/absurd/SKILL.md`, `.pi/skills/pglite/SKILL.md` — subsystem concept skills.
- `.pi/prompts/` — 9 slash-command prompts (`wrun`, `wserve`, `wgraph`, `wresume`, `wreview`, `wscaffold`, `wtriage`, `wruns`, `wci`).
- `.pi/extensions/work/index.ts` — Pi extension making the coding agent a first-class `work` operator (read-only tools: run history, DAG, doctor, review findings). Guardrails: blocks real runs while `dist/` exists, blocks reading `work.json`.

## Key Source References

| Area | Key files |
|---|---|
| Build script | `scripts/build.mjs` |
| Structural reports | `scripts/fan-in.mjs`, `scripts/sloc.mjs` |
| Mutation testing | `scripts/mutation-check.mjs` |
| Test support | `test/_support.ts` |
| E2E fixtures | `test/e2e/` |
| CI pipelines | `.workflows/ci.yaml`, `.workflows/checks.yaml`, `.workflows/test.yaml` |
| GitHub Actions CI | `.github/workflows/ci.yml` |
| Design records | `docs/README.md`, `docs/testing-strategy-review.md`, `docs/property-based-testing.md` |
