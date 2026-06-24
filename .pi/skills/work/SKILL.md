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
4. **A real run** — `work` graph + run + agent + built-in actions against
   `test/e2e/agent-project`, or the specific e2e example touching your
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
| `work run checks` | one VM, `npm ci`, then lint/typecheck/knip/fan-in each as its own `continue-on-error` step (a failing tool doesn't gate the job; each tool's deterministic `steps.<id>.outcome` is forwarded to `review`) |
| `work run test` | **self-hosts the FULL suite (incl. the real-VM e2e tier) in NESTED gondolin VMs** — runs on `work:nested` (= `work:base` + qemu-system-aarch64 + qemu-img), `npm test` with `WORK_SKIP_VM=""` + `WORK_NESTED=1`. Inner VMs have no `/dev/kvm` so gondolin auto-selects TCG. Needs a roomy host (outer `machine: 64G` hosts ~5 concurrent 8G inner VMs). |
| `work run review` | **pure composition of four focused reusables** (`security-review` / `compiler-review` / `runtime-review` / `web-review` via `uses: workflow/<x>-review`), then a `collect` editor that **merges** their already-verified, capped JSON (it doesn't re-verify), de-dupes/ranks/caps to 6, and emits sentinel-wrapped JSON. **No tooling-reviewer agent** — the caller passes each tool's deterministic OUTCOME via `inputs.*`; `collect` leads with any `failure` and the `show` step prints a deterministic `⚠ TOOLING FAILED` banner regardless of the model. 9 agent VMs (4×[scan+collect] + merge) |
| `work run <subsystem>-review` | **focused, self-contained** review of one subsystem (`security` = agent/egress/config, `compiler` = compiler+spec, `runtime` = runtime+targets, `web` = web+persistence). `scan` (the `review-<x>.md` prompt) → `collect` (verify + suppress via `.review/accepted.md` + cap to 4), emitting **labeled** sentinels `===== REVIEW JSON [<subsystem>] BEGIN/END =====`. Two agent VMs, one narrow context — minutes, not the full ~10. The **same** definition is what `review` (→ `ci`) composes, so a focused run and the full run share one source of truth |

Notes for using them:

- `review` (and `ci`) need a model in `work.json` (gitignored — copy
  `work.example.json`; `apiKey` takes `$VAR` expansion). The key is injected
  host-side, scoped to the model host; it never enters the guest.
- The tool/test steps are `continue-on-error`, so `checks`/`test` **don't fail the
  run** on a red tool — each tool's deterministic `outcome` (success/failure/skipped)
  is forwarded to `review`, which leads with any failure and prints a deterministic
  banner (no agent re-narrates the logs; failure DETAIL stays in the `checks`/`test`
  step output in the run). The hard gate is GitHub Actions (`.github/workflows/ci.yml`,
  which runs `npm test` directly — unaffected by the nested dogfood path).
- `work:nested` is built lazily on first use (stock apk packages, fully portable —
  nothing machine-specific baked in). The 2 mediated-egress assertions in
  `egress-e2e` skip when nested (`WORK_NESTED`): inner/outer VMs share gondolin's
  guest subnet so the on-box model host collides — verified on bare metal instead.
- Reviewers are `machine: small`; up to ~4 subsystem scanners in parallel ≈ 8–10G
  peak RAM. `review` totals **9** agent VMs — four focused reviews (each
  `scan → collect`) plus the final merge `collect` — but each focused `collect` is
  sequential after its own `scan`, so peak concurrency stays at the ~4 scanners.
- Run history persists in `.workflows/db` (PGLite, gitignored):
  `work runs`, `work resume <id>` (reuse finished jobs), `work rerun <id>`,
  `work retry <id>` (re-run only a failed run's failed jobs, reusing the passing ones),
  `work --web` for the console + webhook trigger (`ci` is `on: webhook`).

**Use these to advance the project**: after a meaningful engine change, run
`work run checks` (or full `ci`) as the dogfood smoke test — it exercises
compile → plan → VM boot → `npm ci` → capture outputs → reusable-workflow
inlining → (optionally) ~5 concurrent agent VMs, all in one command. A bug
anywhere in that path tends to surface here first.

## The CI feedback loop (operate the repo's own review on your changes)

This is the full dogfood: have the engine review your work, then act on it.
Reviewers read the **source in the checkout** — each scans its subsystem's
files directly. There is no diff/patch step (and there must not be one): a
reviewer always ponders the whole workspace for its scope.

1. **Run it.** `./bin/work.mjs run ci 2>&1 | tee /tmp/ci-run.log` — a full run
   takes several minutes (two npm-ci VMs, then nine agent VMs — `review`'s four
   focused reviews plus the final merge `collect`); run it in the
   background and wait rather than holding a short-timeout foreground call.
   For review-only iteration, `work run review` skips checks/test (its tooling
   `inputs.*` default to empty, so the deterministic tooling status is just
   blank — no failure to lead with). For a single subsystem, `work run
   <subsystem>-review` is faster still (2 VMs). Each reviewer reads its
   subsystem's source directly — no diff to prepare.
2. **Parse the verdict.** A collect job prints its verified review between
   sentinels. The **aggregate** review (from `work run ci`/`work run review`) uses
   the unlabeled `===== REVIEW JSON BEGIN =====` / `===== REVIEW JSON END =====` —
   extract that block. **Focused** reviews use a scope-labeled variant
   (`===== REVIEW JSON [<subsystem>] BEGIN/END =====`); for `work run
   <subsystem>-review` parse that subsystem's labeled block, and note a full `ci`
   run also prints each inner `[<subsystem>]` block en route to the unlabeled
   aggregate (the unlabeled marker is distinct, so a literal match for it still
   finds only the aggregate). A failed-tool `ci` run also prints a deterministic
   `⚠ TOOLING FAILED` banner just before the aggregate sentinel. Shape:
   `{"verdict": "clean"|"findings", "summary": "...", "findings": [{subsystem,
   file, line, severity, confidence, issue, fix, evidence}, ...]}` (≤ 6,
   already verified against the checkout by the editor agent).
3. **Triage like a maintainer, not a patch bot.** For each finding,
   independently confirm it in the code (the editor verifies, but you own the
   fix). Then either **fix it** (and add a regression test), or **reject it**
   by appending a specific entry to `.review/accepted.md` — that's the
   suppression channel that stops a settled question from resurfacing next
   run. Never silently ignore a finding; route it to one of the two.
4. **Iterate.** Re-run after your fixes. Converging on `"verdict": "clean"` is
   the goal state — the reviewers carry no quota, so clean is reachable.
5. **Recovery:** an interrupted run resumes with `work resume <id>` (id from
   `work runs`); `work rerun <id>` repeats it fresh. Replay a finished (web) run's
   log with `work logs <id>`.

Conventions behind the loop: reviewer prompts live in
`.workflows/prompts/review-*.md` (edit those to tune review behavior — they're
ordinary files, versioned with the code); `.review/accepted.md` is committed and
curated (the suppression channel for settled findings).

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
- Step/job outputs: for an explicit value, append `key=value` (or `key<<EOF`
  heredoc for multiline) to `$WORK_OUTPUT` and read `${{ steps.<id>.outputs.<key>
  }}`. To forward a command's **raw output**, don't hand-roll a capture — every
  `id`ed step exposes `${{ steps.<id>.logs }}` (combined stdout+stderr),
  `${{ steps.<id>.outcome }}` (success/failure/skipped), and
  `${{ steps.<id>.exitCode }}` for free (see `checks.yaml`). Thread across jobs
  with `${{ needs.<job>.outputs.<key> }}`. Inputs bind at compile time;
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
