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
work [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--no-global] [--workdir <dir>] [--resume <id>] [--quiet]

# list run history (filter by status)
work [--workspace <dir>] runs [--status queued|running|success|failure|interrupted]

# continue an interrupted run, or re-run a past one fresh (by id, from `work runs`)
work [--workspace <dir>] resume <id>
work [--workspace <dir>] rerun <id>

# print the job DAG instead of running it
work graph <workflow.yaml|name> [--format mermaid|dot|json|ascii] [--steps]

# open the local web console over a workspace's .workflows/
work [--workspace <dir>] --web [--port <n>]

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
`work.json`:

```bash
work init                      # .workflows/hello-world.yaml + work.json
work init --include-skill      # also a Claude Code / Amp skill (see below)
work init --from-template agent-action   # start from the agent template instead
```

`init` is **idempotent and safe**: existing files are skipped and reported (never
overwritten), the config is never clobbered, and a re-run that changes nothing is a
clean "already initialized" exit `0`.

`--global` instead writes a **machine-wide** config to `~/.config/work/work.json`
(XDG) — the home for your providers/models, merged underneath every project's config
at run time. See [Configuration discovery](#configuration-discovery).

| Option | Effect |
|---|---|
| `--project` | Scaffold the current project (the default). |
| `--global` | Write the machine-wide `~/.config/work/work.json` instead. |
| `--include-skill` | Also write a developer skill (`SKILL.md`) teaching your **own** coding agent (Claude Code / Amp) to drive the `work` CLI. This is unrelated to in-workflow agent steps. |
| `--from-template <name>` | Starter template: `hello-world` (default) or `agent-action`. |
| `--force` | Overwrite the scaffold's own files (never the config). |
| `--dry-run` | Print what would be written and exit without touching disk. |

### `work create`

```bash
work create <name> [--template hello-world|agent-action] [--force] [--dry-run]
```

Scaffolds a **single new workflow** named `<name>` into `.workflows/<name>.yaml`.
The `agent-action` template additionally writes a composite action under
`.workflows/actions/<name>/` (wrapping the built-in `work/agent`) and a starter
config.

```bash
work create deploy                         # .workflows/deploy.yaml
work create review --template agent-action # workflow + composite action + config
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

Runs a project workflow **by its `name:`** — the engine finds the
`.workflows/*.yaml` in the workspace whose `name:` matches `<name>`. `--workspace`
sets the project root (default: current directory).

```bash
work --workspace my-project run report
```

A project run is **durable**: it's recorded in run history and journaled as it
goes, so a run that's interrupted — stopped mid-flight before it finishes — can be
**resumed** rather than lost. (A standalone `work <file>` run, outside a
`.workflows/` project, is ephemeral.) Pass `--resume <id>` to continue a prior run
instead of starting a new one — `work resume <id>` below is the shorthand.

### `work runs`

```bash
work [--workspace <dir>] runs [--status queued|running|success|failure|interrupted]
```

Lists the workspace's run history, newest first — the durable record of every
project run. The CLI and the web console write the **same** store, so this lists
runs from either. `--status` filters; for example, the runs that didn't finish:

```bash
work runs
work runs --status interrupted
```

Each row shows the run id, workflow, status, and when it started. A run shown as
**interrupted** is resumable, and the listing prints the exact `resume` command.

### `work resume` / `work rerun`

```bash
work [--workspace <dir>] resume <id>   # continue an interrupted run
work [--workspace <dir>] rerun <id>    # re-run a past run fresh, same inputs
```

Both recover a past run **by id** (copy it from `work runs`) — the workflow and
inputs come from history, so you don't retype them:

- **`resume`** continues the *same* run: jobs that already finished are reused,
  not re-executed, and the run picks up from where it stopped. This is how an
  interrupted run is driven to completion. Equivalent to `work run <name> --resume <id>`.
- **`rerun`** starts a *fresh* run with the same inputs (a new run id), re-executing
  everything — handy for a flaky job or re-triggering a report.

`--inputs` overrides the stored inputs for either.

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
work graph report.yaml --format ascii --steps
work --workspace my-project graph report --format mermaid
```

### `work --web`

```bash
work [--workspace <dir>] --web [--port <n>]
```

Boots the **local web console** over the workspace's `.workflows/` instead of
running a single workflow, and keeps the process alive until you stop it
(`Ctrl-C`). It prints the URL it bound:

```bash
work --workspace . --web
# pi-workflows web UI: http://127.0.0.1:4280/
```

From the browser you can run workflows from an auto-generated input form, watch
runs stream live, browse durable history (and re-run), and manage
[webhook triggers](../guide/web-ui#webhook-triggers). The server binds **loopback
only** (`127.0.0.1`), validates the `Host` header, and requires a CSRF token on
every mutating request. Run history lives under `<workspace>/.workflows/db/`. See
the [Web console guide](../guide/web-ui) for the full tour.

| Option | Effect |
|---|---|
| `--workspace <dir>` | Project root whose `.workflows/` the console serves (default: current directory). |
| `--port <n>` | Port to bind (default `4280`; an integer `1`–`65535`). |

`--web` takes no positional arguments, and `--port` only applies alongside `--web`.

### `work doctor`

```bash
work doctor [--json]
```

Checks that this machine can run `gondolin` workflows. It is **read-only by
design** — it reports what's wrong and prints the exact remediation command, but
never mutates your host (there is no `--fix`). That keeps it safe to drop into a
setup script or a preflight check.

It runs these checks:

| Check | What it verifies |
|---|---|
| **Node ≥ 23.6** | The engine's minimum Node version. |
| **gondolin SDK importable** | The micro-VM SDK is installed and loadable. |
| **QEMU installed** | QEMU is on `PATH`. |
| **Hardware acceleration** | HVF (macOS) or KVM (Linux) is available. |
| **Guest image cached** | Whether the ~200 MB guest image is already downloaded. |
| **Config valid** | `work.json` (if present) parses and is well-formed. |
| **`.workflows/` present** | Whether a project `.workflows/` directory exists. |

Pass `--json` for machine-readable output.

**Exit codes:** `0` — no hard failures (warnings are allowed); `1` — at least one
failed check; `2` — a usage error (e.g. an unknown flag).

## Flags

| Flag | Applies to | Effect |
|---|---|---|
| `--workspace <dir>` | `run`, `graph`, `--web` | Project root for resolving a workflow by name / serving the web console (default: current directory). |
| `--web` | (standalone) | Open the local web console over the workspace's `.workflows/` instead of running a workflow. |
| `--port <n>` | `--web` | Port the web console binds (default `4280`; `1`–`65535`). |
| `--inputs '<json>'` | run, `resume`, `rerun` | Values for the workflow's declared `inputs:`, as a JSON object — e.g. `'{"name":"ada"}'`. For `resume`/`rerun`, overrides the inputs stored in history. |
| `--config <file>` | run | Project-layer model/provider config file. Default: `./work.json`, or `$WORK_CONFIG`. |
| `--no-global` | run | Skip the machine-wide global config layer, for a hermetic, reproducible run. |
| `--workdir <dir>` | run | Where job workspaces are staged (default: a temp dir). |
| `--resume <id>` | run | Continue an interrupted run instead of starting a new one (same run id; finished jobs are reused). Project workflows only. |
| `--status <s>` | `runs` | Filter the run history by status (`queued`, `running`, `success`, `failure`, `interrupted`). |
| `--quiet` | run | Suppress the live board / per-job output. |
| `--format <fmt>` | `graph` | DAG output format: `mermaid`, `dot`, `json`, `ascii`. |
| `--steps` | `graph` | Expand each job into its ordered steps. |
| `--json` | `doctor` | Emit machine-readable check results. |
| `-h`, `--help` | any | Print usage and exit. |

## Output and exit status

When running a workflow, the presenter adapts to the environment:

- **Interactive TTY** — a live, dependency-aware status board.
- **A pipe or non-interactive runner** — buffered per-job output blocks.
- **`--quiet`** — no board or per-job output.

A run exits **`0`** on success and **non-zero** if a job fails or the run is
interrupted — so it drops into a script or scheduler cleanly. An interrupted
project run prints the `--resume` command to continue it.

## Configuration discovery

For commands that may need a model (agent steps), config is loaded in **two
layers** — a machine-wide global file, then one project layer that overrides it:

1. **Global** (lowest precedence): `~/.config/work/work.json` (XDG —
   `$XDG_CONFIG_HOME/work/work.json` if set; `~/.work/work.json` is read as a
   fallback). Skipped entirely with `--no-global`. Created by `work init --global`.
2. **Project** (overrides global), chosen by: `--config <file>` >
   `$WORK_CONFIG` > `./work.json` if it exists.

The layers are deep-merged (`providers`/`models` union, the project layer winning
on a key collision; `defaultModel` last-writer-wins), and validated **after**
merging — so a project layer can name a model whose provider lives in the global
file. An absent config is fine until an agent step actually needs a model. See the
[Configuration reference](./configuration).
