---
name: work
description: Meta skill for developing the `work` engine itself — the dev/verify loop, the test tiers and what each proves, and dogfooding (using `work run ci/checks/test/review` and the e2e gallery to advance work with work). Use when hacking on this repo — changing engine code, adding features, verifying changes, or running the project's own workflows.
---

# Hacking on `work`, with `work`

AGENTS.md covers the architecture map and conventions. This skill is the
**operational layer on top**: how to actually develop, verify, and dogfood.
The prime directive here: this project verifies itself with itself — when you
change the engine, the strongest evidence is a **real `work` run**, not a
green unit suite.

## The dev loop

No build step: `./bin/work.mjs <args>` runs `src/cli.ts` live via Node ≥ 23.6
type-stripping. **Footgun:** if `dist/` exists (someone ran `npm run build`),
the shim prefers it and **shadows your src/ edits** — `rm -rf dist` and keep
it absent during development.

```bash
./bin/work.mjs doctor                # preflight: Node, gondolin SDK, QEMU, config
./bin/work.mjs --workspace <dir> graph <name> --steps   # inspect compilation w/o running
./bin/work.mjs --workspace <dir> run <name>             # the real thing (boots VMs)
```

Single test file / single test:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/compiler.test.ts
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-name-pattern "matrix" test/compiler.test.ts
```

## The verification ladder (cheap → expensive; climb as far as the change warrants)

1. **`npm run check`** — lint + typecheck + knip + fan-in. Always.
2. **`npm run test:unit`** — the full suite with `WORK_SKIP_VM=1`: VM-dependent
   tests self-skip, the rest run against the injected `HostTarget` double
   (`test/_support.ts`). No QEMU. Fast. Proves logic, **not** target behavior.
3. **`npm test`** — everything, real micro-VMs. Needs QEMU. This is what CI
   (`.github/workflows/ci.yml`) gates on.
4. **A real run** — `./demo.sh` (graph + run + agent + built-in actions against
   `test/e2e/agent-project`), or the specific e2e example touching your
   change. **Per project memory, agent/runtime changes are not verified until
   a real run passes** — the test doubles can't catch staging, egress, or
   guest-side issues.
5. **Gated tiers** when relevant: `WORK_TEST_IMAGES=1` (real `work:base` image
   build e2e), `npm run mutation` (curated mutation check — does the suite
   actually catch planted bugs in gating/auth/secret paths?).

Rules that shape tests: never mock the agent runner; tests inject a
`makeTarget` double rather than booting VMs; each new workflow *feature* gets
a `test/e2e/<name>/` example folder — `test/examples.test.ts` picks it up
automatically, and the gallery doubles as documentation.

## Dogfooding: the repo's own pipelines

`.workflows/` holds the project's own CI, run by the engine being developed:

| Pipeline | What it does |
|---|---|
| `work run ci` | composes the other three via job-level `uses: workflow/<name>` — checks → test → review, fail-fast ordering |
| `work run checks` | one VM, `npm ci`, then lint/typecheck/knip/fan-in each as its own `continue-on-error` step (a failing tool doesn't gate the job; its output is captured for `review`) |
| `work run test` | one VM, the `test:unit` tier as a single `continue-on-error` step |
| `work run review` | **five parallel work/agent reviewers** (one per subsystem via `promptFile` from `.workflows/prompts/`, + one reviewing the tooling output passed in as `inputs.*`), then a `collect` editor that **verifies candidates against the checkout**, suppresses `.review/accepted.md` entries, and emits sentinel-wrapped JSON |

Notes for using them:

- `review` (and `ci`) need a model in `work.json` (gitignored — copy
  `work.example.json`; `apiKey` takes `$VAR` expansion). The key is injected
  host-side via mediated egress; it never enters the guest.
- The tool steps are `continue-on-error`, so `checks`/`test` **don't fail the
  run** on a red tool — the failure is captured and the review agent interprets
  it. The hard gate is GitHub Actions.
- Reviewers are `machine: small`; five in parallel ≈ 10G peak RAM.
- Run history persists in `.workflows/db` (PGLite, gitignored):
  `work runs`, `work resume <id>` (reuse finished jobs), `work rerun <id>`,
  `work --web` for the console + webhook trigger (`ci` is `on: webhook`).

**Use these to advance the project**: after a meaningful engine change, run
`work run checks` (or full `ci`) as the dogfood smoke test — it exercises
compile → plan → VM boot → `npm ci` → capture outputs → reusable-workflow
inlining → (optionally) five concurrent agent VMs, all in one command. A bug
anywhere in that path tends to surface here first.

## The CI feedback loop (operate the repo's own review on your changes)

This is the full dogfood: have the engine review your work, then act on it.

1. **Scope the review to your change.** Write the pending diff where the
   reviewers look for it:
   ```bash
   git diff > .review/diff.patch        # or `git diff main`, or include staged: `git diff HEAD`
   ```
   With a patch present, each subsystem reviewer reads it and returns `[]`
   when its scope is untouched; without one, the review is a broad sweep.
2. **Run it.** `./bin/work.mjs run ci 2>&1 | tee /tmp/ci-run.log` — a full run
   takes several minutes (two npm-ci VMs, then six agent VMs); run it in the
   background and wait rather than holding a short-timeout foreground call.
   For review-only iteration, `work run review` skips checks/test (its
   tooling reviewer will just report there was no ci feeding it).
3. **Parse the verdict.** The collect job prints the verified review between
   sentinels — extract the block between `===== REVIEW JSON BEGIN =====` and
   `===== REVIEW JSON END =====` from the run output. Shape:
   `{"verdict": "clean"|"findings", "summary": "...", "findings": [{subsystem,
   file, line, severity, confidence, issue, fix, evidence}, ...]}` (≤ 6,
   already verified against the checkout by the editor agent).
4. **Triage like a maintainer, not a patch bot.** For each finding,
   independently confirm it in the code (the editor verifies, but you own the
   fix). Then either **fix it** (and add a regression test), or **reject it**
   by appending a specific entry to `.review/accepted.md` — that's the
   suppression channel that stops a settled question from resurfacing next
   run. Never silently ignore a finding; route it to one of the two.
5. **Iterate.** Refresh `.review/diff.patch` with your new diff and re-run.
   Converging on `"verdict": "clean"` is the goal state — the reviewers carry
   no quota, so clean is reachable.
6. **Recovery:** an interrupted run resumes with `work resume <id>` (id from
   `work runs`); `work rerun <id>` repeats it fresh.

Conventions behind the loop: reviewer prompts live in
`.workflows/prompts/review-*.md` (edit those to tune review behavior — they're
ordinary files, versioned with the code); `.review/diff.patch` is gitignored
scratch; `.review/accepted.md` is committed and curated.

## Authoring workflows (the facts you need most often)

- Shape: GitHub-Actions-like — `name`, `on` (`workflow_call` for reusables,
  `webhook` for triggers), `jobs.<id>.{runs-on, needs, machine, outputs, steps}`,
  steps are `run:` XOR `uses:`. Canonical reference:
  `docs-site/reference/workflow-syntax.md`; live examples: `test/e2e/`.
- `runs-on: gondolin` (stock guest, the default) or `work:base` (git/jq/curl —
  needed for `npm ci` style jobs). Custom variants via
  `.workflows/images/<name>/build-config.json`.
- `machine:` catalog (`src/compiler/machines.ts`): small 2G / **medium 8G
  (default)** / large 12G / xlarge 24G. The 8G default exists because knip's
  oxc parser reserves a ~6 GiB ArrayBuffer — don't lower it casually.
- Job outputs: append `key=value` (or `key<<EOF` heredoc for multiline) to
  `$WORK_OUTPUT`; thread with `${{ needs.<job>.outputs.<key> }}` /
  `${{ steps.<id>.outputs.<key> }}`. Inputs bind at compile time;
  `needs.*`/`steps.*` resolve at runtime.
- Agent steps: `uses: work/agent` + `with: { prompt | promptFile, model? }` —
  a real Pi agent in-guest, full toolset over the checkout, final message =
  step `output`. Multi-output: declare 2+ outputs and have the agent return a
  JSON object. Don't reintroduce the removed `agent/<name>` package format.
- Checkout semantics: a workflow in `.workflows/` stages the **project root**
  into each job at `/workspace`; a standalone `workflow.yaml` stages its own
  folder. `.git/` and `node_modules/` are never staged — jobs `npm ci`
  themselves.

## Where to look things up

- Architecture + conventions: `AGENTS.md`. Design rationale: `docs/README.md`
  (the design-records index — read the relevant record before reworking a
  subsystem).
- Layer deep-dives, sibling skills: **absurd** (durable tasks/orchestrator),
  **gondolin** (VM target, egress, secrets), **pglite** (the embedded
  Postgres and its single-connection rules).
- UI work (web console `src/web/client.ts`, docs-site): use the
  **impeccable** skill — never ad-hoc style edits.
- User-facing failures: throw `UserFacingError` (clean message, exit 1);
  reserve usage errors/exit 2 for `fail()` in the CLI.
