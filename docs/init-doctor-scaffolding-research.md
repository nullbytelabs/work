# `work init` / `work create` / `work doctor` — research & design

Status tags used below: **VERIFIED** (confirmed against the current tree, file:line),
**PROPOSED** (a design recommendation), **NEEDS-BUILDING** (nothing in the codebase
does this yet). The headline: *all three commands are greenfield.* `parseArgs` only
dispatches `run`, `graph`, and a bare `<file.yaml>` path (`src/cli.ts:104-129`); there
is no `init`/`create`/`doctor`, no global config, no scaffolder. But the engine already
ships most of the *seams* these commands need — the work is wiring, not invention.

---

## 0. What already exists that we get to reuse

The pleasant surprise: the hard primitives are in the tree, just not exposed as commands.

| Seam | Where | Reused by |
|---|---|---|
| Node ≥ 23.6 preflight | `bin/work.mjs:14-21`, `package.json:18-20` | `doctor` (report it instead of crashing) |
| gondolin import + QEMU probe + actionable error | `src/targets/gondolin.ts:64-77`, `:121-127` | `doctor` (reuse the *same* probe, don't duplicate) |
| Pure, fs-free validators | `parseWorkflow` (`src/spec/parse.ts:269`), `compile` (`src/compiler/compile.ts:206`), `parseConfig` (`src/config/index.ts:54`) | `create`/`init` (validate generated files for free) |
| `.workflows/` layout + by-name resolution | `src/project.ts` (`WORKFLOWS_DIR`, `findWorkflowByName`) | the `create` → `run <name>` payoff |
| TTY/CI detection | `src/tui/presenter.ts:35-52`, `detectCI` | gating prompts + color |
| `UserFacingError` → clean `exit 1` | `src/errors.ts`, caught at `src/cli.ts:249` | state-conflict errors ("already exists, pass --force") |
| `PI_WF_PROG` (invoked-name plumbing) | `bin/work.mjs:34`, used in `printUsage` `src/cli.ts:135` | next-steps epilogues, error prefixes |
| `mkdtemp`/`rm` temp-dir test harness | `test/project.test.ts:30-43` | integration tests for `init` |
| `HostTarget` double (no-QEMU runtime) | `test/_support.ts:84-115` | fast-tier tests |

The single most valuable freebie: **a scaffolded workflow can be compiled with the real
compiler before it's written to disk** — `compile(parseWorkflow(yaml))` throws on any
structural error (VERIFIED, both already imported in `src/cli.ts:13`). That buys
templates most of codegen's type-safety guarantee for ~5 lines and catches template
drift the day the spec changes.

---

## 1. `work doctor` — environment & host verification

### Why, and where the numbers come from (VERIFIED)
The engine has exactly one execution target — gondolin (`src/targets/factory.ts`) — behind
an **optional** dependency (`package.json:44-47`). So "does this machine work?" decomposes
into a knowable list. Today those failures surface *late and vague*, only when a job reaches
`provision()` (`src/targets/gondolin.ts:120-127`). `doctor` moves them up front.

QEMU details, read from the installed `@earendil-works/gondolin@0.12.0` (VERIFIED):
- **QEMU is genuinely required by default, even on Apple Silicon.** The default `vmm` is
  `"qemu"`; a `krun` runner exists but is only selected via `sandbox.vmm:"krun"` /
  `GONDOLIN_VMM=krun`, and `GondolinTarget.provision()` passes no `vmm`
  (`src/targets/gondolin.ts:100-119`). The "just check qemu" instinct is correct.
- **Which binary:** `qemu-system-aarch64` on arm64 hosts, `qemu-system-x86_64` on x64.
- **QEMU is launched by bare binary name via `PATH`** (no `which`), so a missing binary
  surfaces as a child `ENOENT` → the generic "failed to provision" error. Exactly the late
  failure doctor should pre-empt.
- **Acceleration:** Linux probes `/dev/kvm` (R/W) → `kvm` else `tcg`; macOS assumes `hvf`
  unconditionally; cross-arch → `tcg`. Doctor should *mirror* this so its verdict matches
  what gondolin will actually do — and treat acceleration as **warn-only** (TCG still runs,
  just slow; gondolin itself only warns).

### The checks (PROPOSED)
Group into **Host** (capability) and **Project** (context):

| # | Check | Probe | pass/warn/fail | Remediation |
|---|---|---|---|---|
| 1 | Node ≥ 23.6 | `process.versions.node` (same parse as the shim) | `<23.6` → fail | upgrade Node (reuse shim wording) |
| 2 | gondolin SDK importable | `await import(...)` — the **same** probe as `loadGondolin()` | throws → fail | `npm install @earendil-works/gondolin` |
| 3 | QEMU binary present | spawn `<qemu-system-…> --version`, arch-picked | ENOENT → fail; unparseable → warn | `brew install qemu` / `apt install qemu-system` / `dnf install qemu-system-*` |
| 4 | HW acceleration | Linux `fs.accessSync("/dev/kvm")`; macOS assume HVF | available → pass; else → **warn** (never fail) | Linux: kvm module / `kvm` group; macOS: HVF needs real HW |
| 5 | Guest image cached | `g.hasGuestAssets()` / `g.getAssetDirectory()` | cached → pass; absent → warn | "first run downloads ~200 MB (needs network)" |
| 6 | Config valid (if present) | `resolveConfigPath` → `loadConfig` | absent → pass; bad → fail | echo the `loadConfig` `UserFacingError` verbatim |
| 7 | `.workflows/` present | `existsSync(join(cwd, WORKFLOWS_DIR))` | present → pass; absent → warn | "create `.workflows/` to use `work run <name>`" |

Checks 1–3 are hard prerequisites; 4–5 soft; 6–7 project-context.

### Output, exit codes, `--fix` (PROPOSED)
- ✓/✗/⊘ checklist (brew/flutter style). Reuse the existing TUI glyphs/ANSI from
  `src/tui/render.ts:31-33,88-92` — **but note the `CODE` palette is module-private**
  (`render.ts:27-37`); promote it to a shared export rather than re-deriving (avoids drift).
- `--json` emits `{ ok, checks: [{ id, status, detail, remediation }] }`; auto-plain when
  `!isTTY` or `--json`.
- **Exit 0 if no hard failures (warnings allowed); exit 1 on any failure.** Deliberately
  *not* flutter's "exit 0 even on failure" — we want doctor usable as a CI gate. Stay off
  exit 2 (reserved for usage errors by `fail()`).
- **Recommend AGAINST `--fix`/auto-install in v1.** Remediations cross package managers
  (brew/apt/dnf) and privilege boundaries (`/dev/kvm` group, kernel modules, sudo); a
  diagnostic that mutates the host can't be trusted as a read-only health check in CI, and
  it clashes with the project's "never do surprising things, verify for real" value. **Print
  the exact command; don't run it.** If anything, a later scoped `--install-sdk` (the one
  safe, non-privileged `npm install` action) — not a blanket `--fix`.

### Testability (PROPOSED, NEEDS-BUILDING)
Every probe touches the host, so inject them. A `DoctorProbes` bag + a pure
`runChecks(probes): Check[]`:
```ts
interface DoctorProbes {
  nodeVersion(): string;                 // process.versions.node
  importGondolin(): Promise<unknown>;    // dynamic import
  spawnVersion(bin: string): Promise<{ ok: boolean; stdout: string }>;
  pathAccess(p: string, mode: number): boolean;  // /dev/kvm
  hasGuestAssets(): boolean;
  platform: NodeJS.Platform; arch: string;
  readConfig(path: string): Promise<PiWorkflowsConfig>;
  exists(path: string): boolean;
}
```
`defaultProbe()` binds the real impls; tests pass a fake. This mirrors the existing
`makeTarget` injection (`src/targets/factory.ts:30-32`) and gondolin's own `deps`/`__test`
seams. Then "arm64 macOS, qemu present, no assets → 1 warn / 0 fail" runs with zero infra.

The clean refactor: a `src/doctor/checks.ts` owning the check *list*, with `GondolinTarget`
importing the individual probe functions *from* it (inverting today's "everything in
gondolin.ts") — so the two code paths can't drift in their messaging.

---

## 2. `work init` & the config hierarchy / merge model

### Where the global config lives (PROPOSED)
The user's sketch is `~/.work/work.json`. Recommend **XDG-first**, resolved:
1. `$XDG_CONFIG_HOME/work/work.json`
2. `~/.config/work/work.json` (XDG default)
3. `~/.work/work.json` — **read-only fallback** if it already exists (don't strand early
   adopters who followed the sketch)

`work init --global` *writes* to `~/.config/work/work.json`. Rationale: `~/.config` is the
de-facto CLI convention on **both** macOS and Linux (git, gh, ripgrep, starship…), one code
path, relocatable via `$XDG_CONFIG_HOME`; `~/.work/` pollutes `$HOME` and isn't redirectable.
Keep a clean split: **config under `~/.config/work/`, mutable state/db under `~/.work/`** (the
web-UI research already muses `~/.work/db`, `docs/web-ui-research.md:340,427`).

Global is the natural home for **providers + models** (machine-wide creds as `$ENV` refs);
project configs then mostly just pick/override `defaultModel` or add a project-local alias.

### The merge model — and the one trap (VERIFIED problem, PROPOSED fix)
**The trap:** `parseConfig` does cross-reference validation *within a single object* — a
model whose `provider` isn't in *that same file's* `providers` throws
(`src/config/index.ts:72-74`), and `defaultModel` is checked against *that file's* models
(`:82-87`). So you **cannot validate-then-merge**: a perfectly valid project layer (whose
provider lives in global) would be rejected. **Validation must move to post-merge.**

Precedence (lowest → highest, later wins):
1. **Global** `~/.config/work/work.json` — base catalog
2. **Project** `<cwd>/work.json` (`DEFAULT_CONFIG_PATH`) — overrides global
3. **`$WORK_CONFIG`** — names the project layer's file (still merges over global)
4. **`--config <file>`** — highest config-*file* tier (`--config > env > default`)
5. **Process env `$VAR`** — *not a layer*; only fills `apiKey` values at resolve time via
   `expandEnv` (`src/config/index.ts:119`). Orthogonal to structural merge.

Granularity: **deep-merge the `providers`/`models` maps; on a key collision the higher
layer's entry wins *wholesale* (replace the object, don't field-merge)** — predictable beats
clever. `defaultModel` is last-writer-wins, validated against the **merged** models map. An
omitted/empty map inherits the lower layer (this is what lets a project config shrink to just
`{ "defaultModel": "kimi" }` once global has the creds).

Recommend `--config`/global compose by **merge (augment)** by default, with `--no-global`
for a hermetic CI config.

### Code changes (PROPOSED, NEEDS-BUILDING)
In `src/config/index.ts`, split parse into lenient-structural + post-merge cross-ref:
```ts
export function parsePartialConfig(raw): PiWorkflowsConfig   // field types only, NO cross-refs
export function mergeConfig(base, over): PiWorkflowsConfig {
  return {
    providers: { ...base.providers, ...over.providers },
    models:    { ...base.models,    ...over.models },
    defaultModel: over.defaultModel ?? base.defaultModel,
  };
}
export function validateConfig(c): PiWorkflowsConfig          // the cross-ref checks, ONCE, post-merge
export async function loadConfig(paths: string[]): Promise<PiWorkflowsConfig> {
  let merged = { providers: {}, models: {} };
  for (const p of paths) { if (!existsSync(p)) continue;       // global is optional
    merged = mergeConfig(merged, parsePartialConfig(JSON.parse(await readFile(p, "utf-8")))); }
  return validateConfig(merged);
}
```
`loadConfig(path)` → `loadConfig(paths[])`. Keep `parseConfig` as
`validateConfig(parsePartialConfig(raw))` for back-compat. `resolveConfigPath` →
`resolveConfigLayers(cliPath?): string[]` returning the ordered list (global first). Behavior
shift to note: a global file alone now makes `config` defined (previously `undefined`), so
agent egress/key-injection activates from global — *intended*, since global is the creds home.

### Files `--project` writes (PROPOSED)
```
.workflows/hello-world.yaml             # always (mirrors test/e2e/hello-world-gondolin)
work.json                # always — the project layer (NO real secrets, $ENV refs only)
.claude/skills/work-workflows/SKILL.md  # only with --include-skill — a skill for the user's OWN
.agents/skills/work-workflows/SKILL.md  #   Claude Code / Amp (NOT a workflow agent). See §3.
```
Config filename is `work.json` **at the project root** (= `DEFAULT_CONFIG_PATH`,
found with zero flags) — *not* inside `.workflows/`. Minimal valid starter uses
`"apiKey": "$FIREWORKS_API_KEY"` (matches `work.example.json`).

### Idempotency & safety (PROPOSED)
- **Never clobber by default** — skip-and-report existing files (`writeFile {flag:"wx"}`,
  treat `EEXIST` as skip).
- `--force` overwrites the scaffold's own files, **but never overwrites a `config.json` whose
  `apiKey` is a literal (non-`$ENV`) secret without a second confirm** — clobbering real creds
  is the one truly destructive outcome.
- `.workflows/` already exists → create only the missing pieces, don't error.
- Exit 0 on "created" *and* "already existed" (idempotent success); non-zero only for real
  errors. ("already exists" is not a usage error → not exit 2.)

---

## 3. `work create` / scaffolding — templates vs codegen

### The packaging constraint that decides it (VERIFIED)
The published package ships only `files: ["bin","dist","README.md"]` (`package.json:13-17`);
`src/` does not ship, and the runtime is a single esbuild bundle `dist/cli.js`
(`scripts/build.mjs:19-27`). A naive `__dirname/../templates/*.yaml` read **will not work in
the published package**. Two survival routes: **(1) embed assets as TS string constants**
(esbuild bundles them for free, zero build/`files` changes), or **(2) copy loose files into
`dist/`** via `scripts/build.mjs` (the `schema.sql` pattern). **Recommend (1)** — the templates
are <40-line text files; inlining sidesteps the whole "file not found in published package"
bug class (which has bitten this repo before).

### Strategy: split by file type (PROPOSED)
| File | Strategy | Why |
|---|---|---|
| `*.yaml` (workflows, agent.yaml) | **Templates** (embedded TS strings, `{{placeholder}}`) | the teaching **header comments** *are* the value; `yaml.stringify` drops them |
| `instructions.md` / `task.md` / `SKILL.md` | **Templates** | pure prose |
| `work.json` | **Codegen** (`JSON.stringify(obj, null, 2)`) | JSON is comment-free and strictly parsed (`parseConfig`); codegen is exact-by-construction |

The seed corpus proves the point: every `test/e2e/*/workflow.yaml` leads with a `# description:`
/ `# usage:` header and inline annotations (`if: always() # runs even if…`) — that's the
product, and no serializer reproduces it. **Guardrail:** run generated YAML back through
`parseWorkflow` before writing and refuse to emit an invalid file (~5 lines, catches drift).

### The catalogue — each starter lifted from a tested e2e seed (PROPOSED)
`hello-world` (default), `needs`, `matrix-build`, `fan-out-fan-in`, `conditional`,
`with-inputs`, `input-validation`, `pipeline`, `run-script` (note: **multi-file** — emits a
sidecar `script.sh`), `ci` (realistic Node CI), and the big one **`agent-action`** — scaffolds
`.workflows/<name>.yaml` **plus** a full agent package
`.workflows/agents/<name>/{agent.yaml,instructions.md,task.md}` at the engine-fixed path
(`src/agent/uses-handler.ts:60-66`). `instructions.md` **must** be non-empty or `loadAgent`
throws (`src/agent/index.ts:112-113`) — a template guarantees this; pair it with a
`config.json` codegen since an agent step is useless without a model.

### Naming, collisions, slugs (VERIFIED constraints)
`work create deploy` → `.workflows/deploy.yaml` with `name: deploy`. Two *independent* failure
modes to guard: **filename** collision (refuse-or-`--force`, don't clobber real work) **and**
**`name:` uniqueness** — duplicate names make `run` throw "ambiguous"
(`src/project.ts:88-89`), so scan existing files' `name:` (reuse the `findWorkflowByName` loop,
`src/project.ts:71-82`). Use **one shared `slug()`** honoring the `agent/<name>` charset
`^[a-z0-9][a-z0-9-]*$` (`src/agent/index.ts:82`) so a generated `uses:` ref is always valid.

### `--include-skill` is a *developer-tooling* artifact — NOT the engine's agent machinery (VERIFIED)
**Do not conflate two unrelated "skills."** There are two completely separate layers, and an
earlier draft of this doc mixed them up:

1. **Workflow-agent package** (engine layer) — the `uses: agent/<name>` package under
   `.workflows/agents/<name>/`, run *inside gondolin* by the engine's `loadAgent`. Its own
   `skills/` subdir *is* reserved/unwired (`src/agent/index.ts:17`, `:96-127`) — but that's a
   fact about the **`agent-action` template above**, and is irrelevant to `--include-skill`.

2. **Developer coding-agent skill** (the human's editor) — what `--include-skill` actually
   writes: a skill for the **user's own Claude Code / Amp**, so *their* assistant learns to
   author and drive the `work` CLI. This is just files on disk in the developer's project. **No
   engine machinery, no `loadAgent`, nothing reserved — it's fully buildable today.** The flag
   name `--include-skill` is correct and truthful (the earlier "rename to `--include-agent`"
   suggestion was a product of the conflation and is *wrong* — "agent" already means the
   workflow agent here, so `--include-agent` would be the confusing name).

**The skill format is shared across both target editors (VERIFIED via Claude Code + Amp docs):**
a directory holding a `SKILL.md` (YAML frontmatter — `name`, `description`; the `description`
drives model auto-discovery — then a markdown body), optionally bundling supporting files
(e.g. a `schema.md` the body links to; reference bundled scripts via `${CLAUDE_SKILL_DIR}`). A
single `SKILL.md` works in **both** Claude Code and Amp.

Install locations (project scope, the default):
- **Claude Code:** `.claude/skills/<name>/SKILL.md` (personal: `~/.claude/skills/<name>/`).
- **Amp:** first-class `.agents/skills/<name>/SKILL.md`; **Amp also reads `.claude/skills/`**
  (legacy-compatible). Personal: `~/.config/agents/skills/`.

So `--include-skill` should write `.claude/skills/work-workflows/SKILL.md` (covers Claude Code
*and* Amp via Amp's legacy read) and, for Amp-first-class correctness, also drop the same file
at `.agents/skills/work-workflows/SKILL.md` — or pick the target via `--skill-target
claude|amp|both` (default `both`; cheap since it's one shared file). Optionally append a 2-line
pointer to a project `AGENTS.md` (Amp's always-on context: "this repo uses the `work` CLI — see
the `work-workflows` skill") so the agent is nudged even before a skill-description match.

A good starter `SKILL.md` body teaches the real surface: the `.workflows/<file>.yaml` layout
and by-`name:` resolution (`src/project.ts`), the spec shape (`name`/`jobs`/`steps`, `run` XOR
`uses`, `needs`, `strategy.matrix`, typed `inputs`), and how to invoke (`work run <name>`,
`work <file>`, `work graph <name>`). It's prose teaching real constraints → a **template**, not
codegen. The `description:` is the load-bearing field — write it so the user's agent
auto-triggers on "write/run a workflow" / "the `work` CLI".

> Honest scope note for the init output: state that `--include-skill` installs a skill into the
> developer's **Claude Code / Amp** environment (their editor's assistant), which is unrelated
> to the workflow's own in-gondolin agent steps. Two different "agents"; don't let the output
> imply otherwise.

---

## 4. CLI UX & argument parsing

### The structural change (VERIFIED limitation → PROPOSED fix)
Today `parseArgs` is one flat flag loop + a post-loop positional sniff
(`src/cli.ts:47-130`), with flag-applicability enforced *negatively* after the fact
(`:121-123`). That works for `run`/`graph` (they share run-flags) but won't scale to
`init`/`create`/`doctor`, whose flag sets are disjoint (`--global`, `--from-template`,
`--json`, `--fix`). **Dispatch first, then per-command parse:**
```ts
switch (argv[0]) {
  case "init":   return runInit(argv.slice(1));
  case "create": return runCreate(argv.slice(1));
  case "doctor": return runDoctor(argv.slice(1));
  default:       return runWorkflow(parseArgs(argv));  // run/graph/bare-file UNCHANGED
}
```
A ~15-line dependency-free `parseFlags(args, {bool, value})` helper gives each command its own
isolated loop while preserving the existing `fail("unknown flag: …")` UX.

### Proposed grammar
```
work init   [--project | --global] [--include-skill] [--from-template <name>] [--force] [--dry-run] [--yes]
work create <name> [--template <name>] [--force] [--dry-run]
work doctor [--json] [--fix]
```
`--project` is the default for `init`. **Flag `--global` as needing a defined artifact** — there
is no global-config concept today; either define it (§2 does) or drop it from v1.

### Interactive vs flags-only (PROPOSED)
Stay **flags-only as the contract** (smart defaults + `--yes`); add a **tiny hand-rolled
`node:readline/promises` prompt on `init` only, and only when interactive** — gated by the
*exact* signals the repo already trusts: `process.stdin.isTTY && process.stdout.isTTY &&
!detectCI()` (`src/tui/presenter.ts:35-52`). A prompt must **never** appear when `!isTTY` (the
classic pipeline-hang trap). No new dependency.

### Conventions to adopt
- `--dry-run` (print what would be written, touch nothing, exit 0; to stdout).
- `--force`/`-f` (overwrite); without it, an existing target is a **clean `UserFacingError`**,
  not a `fail()` — route state conflicts through `UserFacingError` (→ exit 1 via the existing
  `main().catch`), reserve `fail()`/exit-2 for *argument* errors.
- `--yes`/`-y` (suppress the prompt).
- Idempotent re-runs ("already initialized — nothing to do", exit 0).
- **"Next steps" epilogue** — the biggest UX win: after `create deploy`, print
  `run it: work run deploy` / `inspect: work graph deploy`, using `PI_WF_PROG` so it matches how
  the user invoked the tool. The `run <name>` form is *guaranteed* to resolve because `create`
  writes a matching `name:` into `.workflows/`.

### Two small fixes worth doing while in here (VERIFIED)
- `fail()` hardcodes the literal `work:` prefix (`src/cli.ts:155`) even when invoked as
  `work` — unlike `printUsage()`, which uses `PI_WF_PROG` (`:135`). One-line fix.
- `NO_COLOR`/`FORCE_COLOR` are handled **nowhere** (grep: zero refs) — worth adding centrally
  when the palette is promoted out of `render.ts`.

### First-run / zero-arg (PROPOSED)
Keep `exit 2` for the non-interactive/zero-arg machine contract, but for an interactive TTY
nudge instead of dumping grammar: no `.workflows/` → "get started: `work init` / diagnose:
`work doctor`"; `.workflows/` present → list the available workflow names (enumerable via the
`findWorkflowByName` scan) as a menu.

---

## 5. Testing strategy (VERIFIED harness, PROPOSED plan)

Harness: **`node:test`** via the type-stripping loader (`package.json:31`), assertions are
`node:assert/strict`, `describe`/`it`. **No Jest/Vitest, no snapshot library** — "snapshot"
means inline `assert.equal(actual, literal)`. The fast-vs-slow split is *by what a file
imports*, not a flag: fast tier uses the `HostTarget` double via `useSharedRuntime({})`
(`test/_support.ts:84-115`); the real-VM tier passes `{ realTargets: true }`
(`test/examples.test.ts:17`). **Caveat:** there is **no process-level e2e skip gate** today —
real-VM tests are unconditional (CI provisions QEMU). A laptop-skip (`{ skip: !process.env.WORK_E2E }`)
is net-new if wanted.

**Unit** (`test/doctor.test.ts`, `test/scaffold.test.ts`): pure `mergeConfig` precedence;
`scaffoldFiles({...})` → exact YAML/JSON (inline literals); doctor checks with **injected fake
probes** (node old, qemu absent, config missing); `slug()` edges.

**Integration** (`test/init.test.ts`, real `mkdtemp`, no VM, harness copied from
`test/project.test.ts:30-43`): run `init`, assert exact file tree + contents; idempotency /
`--force` (assert `assert.rejects(..., e => e instanceof UserFacingError)`); **compile the
generated scaffold** (`compile(parseWorkflow(yaml))` — the free validity proof, also assert
`plan.warnings === undefined` since a clean scaffold sets `runs-on: gondolin` explicitly,
`test/compiler.test.ts:81-84`); merge real global+project configs from a temp HOME; doctor
against a temp HOME with/without config.

**E2E** (opt-in QEMU): scaffold → **actually run** the generated hello-world through
`useSharedRuntime({ realTargets: true })` (mirror `runExample`, `test/examples.test.ts:68-81`)
— the cleanest trick is to have `init` scaffold into `test/e2e/<name>/` so the existing
examples loop picks it up for free; and doctor with the **real** probe bag asserting it reports
node+qemu correctly.

**Seams that must exist for any of this:** probe injection (doctor), injectable `cwd`/`home` +
a `write` function split from a **pure `scaffoldFiles(): Map<path,contents>`** generator (init),
pure slug/merge functions. The discipline already exists in the codebase (pure `parseConfig`
vs thin `loadConfig`) — mirror it.

---

## 6. Prior art — patterns to adopt / avoid

**Adopt:** glyph checklist + inline remediation (flutter/brew); **verify-not-fix**, fix as a
separate explicit verb (rustup `check` vs `update`); `--yes`/`-y` universal escape (npm,
gh `--confirm`); template `--template <name>` flag (create-vite/create-next-app); **ship
templates inside the package**, never fetch at runtime (create-vite bakes them in;
create-next-app's `--example` GitHub fetch is the anti-pattern); "next steps" epilogue
(create-next-app "Success!…"); detect-and-reuse idempotency (cargo `init` reuses existing
sources). The `cargo new` (creates dir) vs `cargo init` (in-place) split is the exact model for
our `--global` vs `--project`. For the template catalogue, copy **`actions/starter-workflows`**
structure: group by intent (`ci/`, `agent/`, `automation/`) with a sibling
`.properties.json` (name/description/categories/icon) so a future interactive picker can rank
templates.

**Avoid:** naming a dependency-bootstrap "init" — ⚠️ `terraform init` *fetches providers*, it
doesn't generate files; our `init` generates files, so keep the verb meaning "scaffold" (use a
different verb if we ever add a fetch step). **Don't exit 0 on a failed required check**
(flutter's mistake — makes doctor useless as a gate). Don't let doctor be vanity output
(brew's "just ignore these" reputation) — every ✗ must be real and actionable. **Don't
auto-mutate the host silently.** **Don't silently overwrite** `.workflows/` or config. Don't
require npm's `-- --flag` separator (we're our own launcher — pass flags directly).

---

## 7. Recommended v1 slice (smallest useful, in dependency order)

1. **`work doctor`** (read-only) — highest leverage, no new product surface, pure-ish with a
   probe seam. Reuses the gondolin import probe + Node floor; turns today's late/vague VM
   failure into an up-front checklist. Ship `--json`, exit 0/1, **no `--fix`**.
2. **`work create <name>`** — templates-as-embedded-TS for YAML, validated through
   `parseWorkflow` before write, shared `slug()`, next-steps epilogue. Composes with the
   existing by-name runner for free. Start with `hello-world` + `agent-action`.
3. **`work init --project`** — `.workflows/` + hello-world + starter `config.json`. Builds on
   the `create` generators.
4. **Config layering + `work init --global`** — the biggest change (move validation post-merge;
   `loadConfig(paths[])`; `resolveConfigLayers`). Do this *last* and deliberately, because the
   `parseConfig` validation-order trap (§2) is easy to get subtly wrong.

Cross-cutting prerequisite for all four: the **dispatch-first `main()`** + `parseFlags` helper
(§4), and promoting the color palette out of `render.ts`.

### Honest "needs-building" ledger
Nothing here exists yet: no `init`/`create`/`doctor` command, no global config, no merge, no
scaffolder, no probe injection, no `parseFlags`, no exported palette, no `NO_COLOR` handling,
no e2e skip gate. What *does* exist — and carries most of the weight — is the list in §0.
`--global` needs the artifact §2 defines. Note the two distinct "skills": the engine's own
workflow-agent `skills/` subdir is reserved/unwired in `loadAgent` (a fact about the
`agent-action` template), whereas `--include-skill` writes a developer Claude Code / Amp skill
— files on disk, fully buildable today, unrelated to the engine (§3).
Verify any of this against `demo.sh`, not just the suite, before trusting gondolin-dependent
behavior.
