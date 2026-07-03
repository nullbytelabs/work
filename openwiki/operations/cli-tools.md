# CLI Tools — Doctor, Graph, Scaffold, Init, TUI

Beyond the run/resume/retry path, `work` ships several supporting CLI tools: a preflight checker, a DAG exporter, project/resource generators, and a terminal UI. All are read-only or write only into your project directory.

## `work doctor` — Preflight Checks

`work doctor [--json]` verifies this machine can run gondolin workflows. Read-only by design — it reports what's wrong and prints the exact remediation command, but **never mutates the host** (there is no `--fix`; passing it is an explicit error). Exit codes: `0` = no hard failures (warnings allowed), `1` = at least one failed check, `2` = usage error.

The checks deliberately mirror what `GondolinTarget.provision()` will actually do at run time (QEMU by default, the arch-picked binary, the cached guest image) so doctor's verdict matches the engine's behaviour. Source: `src/doctor/checks.ts`, `src/doctor/index.ts`.

| # | Check | What it verifies | Fail / Warn |
|---|---|---|---|
| 1 | `node` | Node ≥ 23.6 (type-stripping + gondolin floor) | fail |
| 2 | `gondolin` | `@earendil-works/gondolin` SDK dynamically importable | fail |
| 3 | `qemu` | `qemu-system-<arch> --version` runs (arch: arm64→aarch64, x64→x86_64) | fail if missing, warn if unrecognized |
| 4 | `accel` | Linux: `/dev/kvm` RW access. macOS: HVF (always pass). Other: warn | warn only (TCG fallback works, slower) |
| 5 | `guest-image` | Guest image cached (probes the gondolin SDK) | warn (first run downloads ~200 MB) |
| 6 | `config` | `work.json` (or `$WORK_CONFIG`) loads + validates, if present | fail if present-but-broken; absent = pass |
| 7 | `workflows-dir` | `.workflows/` directory exists in cwd | warn if absent |

`--json` emits `{ version, ok, status, checks: [{ id, title, status, detail?, remediation? }] }` for tooling. Every host-touching operation (Node version, dynamic import, spawning QEMU, fs access, config load) is injected through a `DoctorProbes` interface, so `runChecks` is deterministic and unit-testable with a fake bag.

## `work graph` — DAG Export

`work graph <file|name> [--format mermaid|dot|json|ascii] [--steps]` renders the compiled `needs` DAG for inspection, **before** any runtime. Useful for confirming a workflow's shape matches intent. Default format: `mermaid`. Source: `src/graph/emit.ts`.

| Format | Output |
|---|---|
| **mermaid** | Mermaid `flowchart TD`. Jobs get synthetic ids to avoid Mermaid id grammar clashes. `--steps`: each job becomes a `subgraph` with chained step nodes (`uses` = stadium, `run` = rectangle). |
| **dot** | Graphviz `digraph`. `--steps`: each job is a `cluster_*` containing chained step nodes; cross-cluster edges via `compound=true`. `uses` steps get `fillcolor="#eaf2ff"`. |
| **json** | Structured `{ name, jobOrder, jobs: { id: { runsOn, steps, needs, level, stepList? } } }`. Includes computed topological `level` per job. `--steps` adds `stepList: [{ name, kind, uses?, id? }]`. |
| **ascii** | Plain-text terminal glance: jobs grouped by topological level, annotated with upstream `needs`. `--steps`: ordered steps listed under each job. Safe to pipe/paste. |

`--steps` expands each job from a single node to its ordered step list (ordinal, label, kind, `uses` target). All emitters are pure functions of the compiled `ExecutionPlan` — no I/O, no runtime. The `levelize` helper (`src/tui/levels.ts`) computes dependency depth for the ascii and json formats.

## `work create <noun> <name>` — Generators

`work create` scaffolds resources into your project. The grammar is uniform: `create <noun> <name>` where `<noun>` is `workflow`, `image`, or `webhook`. Source: `src/scaffold/`.

| Noun | Generates |
|---|---|
| `workflow` | `.workflows/<name>.yaml`. With `--template agent-action`, also a composite action under `.workflows/actions/<name>/` + a starter `work.json`. |
| `image` | `.workflows/images/<name>/build-config.json` — an arch-agnostic Gondolin build-config skeleton. Select with `runs-on: work:<name>`. |
| `webhook` | Merges a `webhooks.<name>` entry into `work.json` and prints the `on: webhook:` block to paste into an existing workflow. Requires `--workflow <existing>`. |

### `create workflow` flags

- `--template <hello-world|agent-action>` (default: `hello-world`)
- `--webhook` — opt the workflow into webhook triggering
- `--source <id>` — select an auth preset (also implies `--webhook`): `alertmanager`, `grafana`, `github`, `generic`
- `--force` / `-f` — overwrite existing file
- `--dry-run` — show what would be written, touch nothing

### `create webhook` flags

- `--workflow <existing>` (required) — the workflow name to wire
- `--source <id>` — auth preset (default: `generic`); `--force`, `--dry-run`

### Webhook source presets

| Preset | Auth | Signature header | Note |
|---|---|---|---|
| `alertmanager` | bearer | (default: `Authorization`) | Alertmanager doesn't sign payloads |
| `grafana` | hmac-sha256 | `X-Grafana-Alerting-Signature` | Bare-hex HMAC |
| `github` | hmac-sha256 | `X-Hub-Signature-256` | `sha256=<hex>` format |
| `generic` | bearer | (default: `Authorization`) | Any bearer-token sender |

The hook's secret is read from the env var `<HOOK>_SECRET` (uppercased, non-alphanumeric → `_`), emitted as a `$VAR` ref you export. See [Serving, Triggers & Observability](serve-and-triggers.md) for the receiver side.

### Safety contracts

Generated workflow YAML is validated through the real `parseWorkflow` / `compile` pipeline **before** writing (`assertValidWorkflow`, `src/scaffold/index.ts`) — a template that drifts from the spec surfaces as a loud internal error, not a broken file. Two collision guards: workflow filename uniqueness and declared `name:` uniqueness. `work.json` is never overwritten by the scaffold writer (it may hold real credentials); the config-merge writer is the deliberate exception, upserting exactly one keyed entry. **Note**: the config-merge writer reads JSONC but rewrites canonical JSON via `JSON.stringify`, so any `//` comments in the existing `work.json` are dropped on merge.

Templates are embedded as TS string constants in `src/scaffold/templates.ts` (not runtime file reads) — because the published package is an esbuild bundle that ships no template files. The `{{name}}` placeholder token deliberately has no spaces, to avoid collision with Pi's `{{ input }}` expression placeholders.

## `work init` — Project Scaffolding

`work init [--project | --global] [--include-skill] [--from-template hello-world|agent-action] [--force] [--dry-run]`

Writes a starter workflow into `.workflows/` plus (for the `agent-action` template) a project `work.json`. Idempotent: existing files are skipped-and-reported, never clobbered; re-running is "nothing to do" and exits 0. Source: `src/init/index.ts`.

- `--global` — writes a machine-wide config to XDG (`~/.config/work/work.json`), the home for `providers` / `models` merged under every project config at run time. See [Configuration](config.md).
- `--include-skill` — writes a `SKILL.md` to both `.claude/skills/work-workflows/` and `.agents/skills/work-workflows/`, teaching your *own* coding agent (Claude Code / Amp) to author and drive the `work` CLI. Unrelated to the engine's in-gondolin agent steps.
- `--from-template` / `-t` — `hello-world` (default) or `agent-action`.
- `--force` / `--dry-run`.

## Terminal UI (`src/tui/`)

The run presenter is selected automatically from the terminal context. Source: `src/tui/presenter.ts`.

| Presenter | When | Behavior |
|---|---|---|
| `NullPresenter` | `--quiet` | No output (`hooks = undefined`). |
| `BufferedPresenter` | Non-TTY or CI (default for pipes/CI) | Buffers each job's lines, flushes atomically on job completion so parallel jobs stay contiguous. In CI, wraps each block in `::group::` / `::endgroup::` for collapsible GitHub/Buildkite sections. |
| `LayeredPresenter` | Interactive TTY, not CI | Live DAG-aware status board: in-place-redrawn status list keyed by job, DAG shown as indentation (topological levels). Header shows state chips (`▶N ✓N ✗N ⊘N ◌N` for running/success/failure/skipped/pending) + wall time. A finished job's detailed log is "committed" to native scrollback above the live region. 80ms refresh, 10-frame braille spinner, cursor hidden/shown. ANSI-aware truncation (`truncVisible`) prevents wrapping that would corrupt cursor math. Pending jobs show "blocked on <unmet needs>" or "ready". |

### Selection logic

```
1. --quiet              → NullPresenter
2. WORK_TUI=1   → force LayeredPresenter
3. WORK_TUI=0   → force BufferedPresenter
4. isTTY && !isCI       → LayeredPresenter
5. else                 → BufferedPresenter
```

`WORK_TUI` is an explicit override for testing or forcing a mode. CI detection (`detectCI`) checks `CI`, `CONTINUOUS_INTEGRATION`, `GITHUB_ACTIONS`, `BUILDKITE`, `GITLAB_CI`, `CIRCLECI`.

### Color policy

Color follows the de-facto conventions (`src/tui/palette.ts`, `shouldColor`): `FORCE_COLOR` > `NO_COLOR` > `isTTY`. `NO_COLOR` (any non-empty value) disables; `FORCE_COLOR` (any non-empty non-`"0"` value) forces on — `FORCE_COLOR=0` does **not** force on.

## Key Source References

| Area | Key files |
|---|---|
| Doctor | `src/doctor/index.ts`, `src/doctor/checks.ts` |
| Graph | `src/graph/index.ts`, `src/graph/emit.ts` |
| Scaffold | `src/scaffold/index.ts`, `src/scaffold/webhook.ts`, `src/scaffold/image.ts`, `src/scaffold/templates.ts` |
| Init | `src/init/index.ts` |
| TUI | `src/tui/presenter.ts`, `src/tui/render.ts`, `src/tui/store.ts`, `src/tui/levels.ts`, `src/tui/palette.ts` |
| Design record | `docs/init-doctor-scaffolding-research.md`, `docs/tui-iteration-2.md` |
