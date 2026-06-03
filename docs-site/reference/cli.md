# CLI reference

The package installs three equivalent commands — `work`, `workflow`, and
`pi-workflows` — all pointing at the same engine. These docs use `work`.

## Synopsis

```bash
# run a workflow file directly
work <workflow.yaml> [--inputs '<json>'] [--config <file>] [--workdir <dir>] [--quiet]

# run a project pipeline by name (resolves .workflows/*.yaml whose `name:` matches)
work [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--workdir <dir>] [--quiet]

# print the job DAG instead of running it
work graph <workflow.yaml|name> [--format mermaid|dot|json|ascii] [--steps]

# check the host can run sandboxed jobs
work doctor [--json]
```

## Commands

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
| `--config <file>` | run | Model/provider config file. Default: `./pi-workflows.config.json`, or `$PI_WORKFLOWS_CONFIG`. |
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

For commands that may need a model (agent steps), the config file is resolved in
this order:

1. `--config <file>`, if given.
2. `$PI_WORKFLOWS_CONFIG`, if set.
3. `./pi-workflows.config.json`, if it exists.

An absent config is fine until an agent step actually needs a model. See the
[Configuration reference](./configuration).
