# CLI reference

The package installs three equivalent commands — `work`, `workflow`, and
`pi-workflows` — all pointing at the same engine. These docs use `work`.

## Synopsis

```bash
# scaffold a project (a starter workflow + config), or a machine-wide config
work init [--project | --global] [--include-skill] [--from-template hello-world|agent-action] [--force] [--dry-run]

# scaffold a single new workflow
work create <name> [--template hello-world|agent-action] [--force] [--dry-run]

# run a workflow file directly
work <workflow.yaml> [--inputs '<json>'] [--config <file>] [--no-global] [--workdir <dir>] [--quiet]

# run a project pipeline by name (resolves .workflows/*.yaml whose `name:` matches)
work [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--no-global] [--workdir <dir>] [--quiet]

# print the job DAG instead of running it
work graph <workflow.yaml|name> [--format mermaid|dot|json|ascii] [--steps]

# check the host can run sandboxed jobs
work doctor [--json]
```

## Commands

### `work init`

```bash
work init [--project | --global] [--include-skill] [--from-template <name>] [--force] [--dry-run]
```

Scaffolds a project so it's ready to run. With no flags (or `--project`, the
default) it writes a starter workflow into `.workflows/` plus a project
`pi-workflows.config.json`:

```bash
work init                      # .workflows/hello-world.yaml + pi-workflows.config.json
work init --include-skill      # also a Claude Code / Amp skill (see below)
work init --from-template agent-action   # start from the agent template instead
```

`init` is **idempotent and safe**: existing files are skipped and reported (never
overwritten), the config is never clobbered, and a re-run that changes nothing is a
clean "already initialized" exit `0`.

`--global` instead writes a **machine-wide** config to `~/.config/work/config.json`
(XDG) — the home for your providers/models, merged underneath every project's config
at run time. See [Configuration discovery](#configuration-discovery).

| Option | Effect |
|---|---|
| `--project` | Scaffold the current project (the default). |
| `--global` | Write the machine-wide `~/.config/work/config.json` instead. |
| `--include-skill` | Also write a developer skill (`SKILL.md`) teaching your **own** coding agent (Claude Code / Amp) to drive the `work` CLI. This is unrelated to in-workflow agent steps. |
| `--from-template <name>` | Starter template: `hello-world` (default) or `agent-action`. |
| `--force` | Overwrite the scaffold's own files (never the config). |
| `--dry-run` | Print what would be written and exit without touching disk. |

### `work create`

```bash
work create <name> [--template hello-world|agent-action] [--force] [--dry-run]
```

Scaffolds a **single new workflow** named `<name>` into `.workflows/<name>.yaml`.
The `agent-action` template additionally writes a full agent package under
`.workflows/agents/<name>/` and a starter config.

```bash
work create deploy                         # .workflows/deploy.yaml
work create review --template agent-action # workflow + agent package + config
```

The generated YAML is validated through the real compiler **before** it's written,
and `create` refuses to clobber an existing workflow file (or reuse a `name:`
already declared elsewhere) unless you pass `--force`. On success it prints the
exact next steps (`work run <name>`, `work graph <name>`).

| Option | Effect |
|---|---|
| `--template <name>` | `hello-world` (default) or `agent-action`. |
| `--force` | Overwrite an existing workflow file of the same name (never the config). |
| `--dry-run` | Print what would be written and exit without touching disk. |

### Run a file

```bash
work <workflow.yaml> [flags]
```

Runs the workflow at the given path directly. If the file sits inside a
`.workflows/` directory, the **project root** (its parent) is the checkout;
otherwise the file's own folder is. See [Project layout](../guide/project-layout).

### `work run`

```bash
work [--workspace <dir>] run <name> [flags]
```

Runs a project pipeline **by its `name:`** — the engine finds the
`.workflows/*.yaml` in the workspace whose `name:` matches `<name>`. `--workspace`
sets the project root (default: current directory).

```bash
work --workspace my-project run ci
```

### `work graph`

```bash
work graph <workflow.yaml|name> [--format <fmt>] [--steps]
```

Compiles the workflow and emits its job DAG **instead of running it** — useful for
review and for embedding in docs. As with running, pass `--workspace` to resolve a
target by name.

| Option | Effect |
|---|---|
| `--format <fmt>` | Output format: `mermaid` (default), `dot`, `json`, or `ascii`. |
| `--steps` | Expand each job into its ordered steps. |

```bash
work graph ci.yaml --format ascii --steps
work --workspace my-project graph ci --format mermaid
```

### `work doctor`

```bash
work doctor [--json]
```

Checks that this machine can run `gondolin` workflows. It is **read-only by
design** — it reports what's wrong and prints the exact remediation command, but
never mutates your host (there is no `--fix`). That keeps it safe to use as a CI
gate.

It runs these checks:

| Check | What it verifies |
|---|---|
| **Node ≥ 23.6** | The engine's minimum Node version. |
| **gondolin SDK importable** | The micro-VM SDK is installed and loadable. |
| **QEMU installed** | QEMU is on `PATH`. |
| **Hardware acceleration** | HVF (macOS) or KVM (Linux) is available. |
| **Guest image cached** | Whether the ~200 MB guest image is already downloaded. |
| **Config valid** | `pi-workflows.config.json` (if present) parses and is well-formed. |
| **`.workflows/` present** | Whether a project `.workflows/` directory exists. |

Pass `--json` for machine-readable output.

**Exit codes:** `0` — no hard failures (warnings are allowed); `1` — at least one
failed check; `2` — a usage error (e.g. an unknown flag).

## Flags

| Flag | Applies to | Effect |
|---|---|---|
| `--workspace <dir>` | `run`, `graph` | Project root for resolving a workflow by name (default: current directory). |
| `--inputs '<json>'` | run | Values for the workflow's declared `inputs:`, as a JSON object — e.g. `'{"name":"ada"}'`. |
| `--config <file>` | run | Project-layer model/provider config file. Default: `./pi-workflows.config.json`, or `$PI_WORKFLOWS_CONFIG`. |
| `--no-global` | run | Skip the machine-wide global config layer, for a hermetic run (e.g. CI). |
| `--workdir <dir>` | run | Where job workspaces are staged (default: a temp dir). |
| `--quiet` | run | Suppress the live board / per-job output. |
| `--format <fmt>` | `graph` | DAG output format: `mermaid`, `dot`, `json`, `ascii`. |
| `--steps` | `graph` | Expand each job into its ordered steps. |
| `--json` | `doctor` | Emit machine-readable check results. |
| `-h`, `--help` | any | Print usage and exit. |

## Output and exit status

When running a workflow, the presenter adapts to the environment:

- **Interactive TTY** — a live, dependency-aware status board.
- **CI or a pipe** — buffered per-job output blocks.
- **`--quiet`** — no board or per-job output.

A run exits **`0`** on success and **non-zero** if any job fails — so it drops into
an existing pipeline cleanly.

## Configuration discovery

For commands that may need a model (agent steps), config is loaded in **two
layers** — a machine-wide global file, then one project layer that overrides it:

1. **Global** (lowest precedence): `~/.config/work/config.json` (XDG —
   `$XDG_CONFIG_HOME/work/config.json` if set; `~/.work/config.json` is read as a
   fallback). Skipped entirely with `--no-global`. Created by `work init --global`.
2. **Project** (overrides global), chosen by: `--config <file>` >
   `$PI_WORKFLOWS_CONFIG` > `./pi-workflows.config.json` if it exists.

The layers are deep-merged (`providers`/`models` union, the project layer winning
on a key collision; `defaultModel` last-writer-wins), and validated **after**
merging — so a project layer can name a model whose provider lives in the global
file. An absent config is fine until an agent step actually needs a model. See the
[Configuration reference](./configuration).
