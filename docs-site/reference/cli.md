# CLI reference

The package installs a single command, `work`. These docs use it throughout.

## Synopsis

```bash
# scaffold a project (a starter workflow + config), or a machine-wide config
work init [--project | --global] [--include-skill] [--from-template hello-world|agent-action] [--force] [--dry-run]

# scaffold a single new workflow (optionally webhook-triggered)
work create workflow <name> [--template hello-world|agent-action] [--webhook [--source <id>]] [--datasources a,b] [--force] [--dry-run]

# scaffold a datasource entry (merged into work.json) or a custom job image
work create datasource <name> [--preset <id>] [--url <baseUrl>] [--force] [--dry-run]
work create image <name> [--force] [--dry-run]

# pair a webhook with an existing workflow (merges webhooks.<name> into work.json)
work create webhook <name> --workflow <existing> [--source <id>] [--datasources a,b] [--force] [--dry-run]

# run a workflow file directly
work <workflow.yaml> [--inputs '<json>'] [--config <file>] [--datasources <a,b>] [--no-global] [--workdir <dir>] [--quiet]

# run a project pipeline by name (resolves .workflows/*.yaml whose `name:` matches)
work [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--datasources <a,b>] [--no-global] [--workdir <dir>] [--resume <id>] [--quiet]

# list run history (filter by status)
work [--workspace <dir>] runs [--status queued|running|success|failure|interrupted]

# continue an interrupted run, re-run a past one fresh, or re-run just its failed
# jobs (by id, from `work runs`)
work [--workspace <dir>] resume <id>
work [--workspace <dir>] rerun <id>
work [--workspace <dir>] retry <id>

# print the job DAG instead of running it
work graph <workflow.yaml|name> [--format mermaid|dot|json|ascii] [--steps]

# boot the long-lived host (HTTP API + console + webhook receiver + scheduler)
work [--workspace <dir>] serve [--port <n>]

# check the host can run sandboxed jobs
work doctor [--json]

# print the installed version
work version
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
(XDG): the home for your providers/models, merged underneath every project's config
at run time. See [Configuration discovery](#configuration-discovery).

| Option | Effect |
|---|---|
| `--project` | Scaffold the current project (the default). |
| `--global` | Write the machine-wide `~/.config/work/work.json` instead. |
| `--include-skill` | Also write a developer skill (`SKILL.md`) teaching your **own** coding agent (Claude Code / Amp) to drive the `work` CLI. This is unrelated to in-workflow agent steps. |
| `--from-template <name>` | Starter template: `hello-world` (default) or `agent-action`. |
| `--force` | Overwrite the scaffold's own files (never the config). |
| `--dry-run` | Print what would be written and exit without touching disk. |

### `work create workflow`

```bash
work create workflow <name> [--template hello-world|agent-action] [--webhook [--source <id>]] [--datasources a,b] [--force] [--dry-run]
```

Scaffolds a **single new workflow** named `<name>` into `.workflows/<name>.yaml`.
The `agent-action` template additionally writes a composite action under
`.workflows/actions/<name>/` (wrapping the built-in `work/agent`) and a starter
config.

```bash
work create workflow deploy                         # .workflows/deploy.yaml
work create workflow review --template agent-action # workflow + composite action + config
```

The generated YAML is validated through the real compiler **before** it's written,
and `create` refuses to clobber an existing workflow file (or reuse a `name:`
already declared elsewhere) unless you pass `--force`. On success it prints the
exact next steps (`work run <name>`, `work graph <name>`).

#### Webhook-triggered (greenfield)

Pass `--webhook` to generate a workflow that's webhook-triggered from the start.
The generated YAML carries an `on: webhook` block, and the matching
[`webhooks.<name>`](./configuration#webhooks) entry is merged into `work.json` in
the same pass. `--source` and `--datasources` both imply `--webhook`.

```bash
work create workflow triage --webhook --source alertmanager --datasources prometheus,loki
```

writes the workflow with:

```yaml
name: triage
on:
  webhook:
    secret: triage
    source: alertmanager
```

and merges the config half:

```json
"webhooks": { "triage": { "workflow": "triage", "auth": "bearer", "secret": "$TRIAGE_SECRET" } }
```

The secret is always emitted as a `$VAR` env-ref (`$TRIAGE_SECRET`), never a
literal. Run `export TRIAGE_SECRET=...` to set it. `--source` picks the sender preset
that supplies the auth scheme (and signature header where the sender signs
deliveries); see [`work create webhook`](#work-create-webhook) for the preset
table. `--datasources` selects which datasource credentials the triggered run may use (it does not gate egress, which is open).

| Option | Effect |
|---|---|
| `--template <name>` | `hello-world` (default) or `agent-action`. |
| `--webhook` | Also generate the `on: webhook` block and merge the `webhooks.<name>` config. |
| `--source <id>` | Sender preset for the webhook auth (`alertmanager`, `grafana`, `github`, `generic`). Implies `--webhook`. |
| `--datasources <a,b>` | Datasource keys the webhook-triggered run may use. Implies `--webhook`. |
| `--force` | Overwrite an existing workflow file of the same name (never the config). |
| `--dry-run` | Print what would be written and exit without touching disk. |

### `work create datasource`

```bash
work create datasource <name> [--preset <id>] [--url <baseUrl>] [--force] [--dry-run]
```

Scaffolds a [`datasources.<name>`](./configuration#datasources) entry, **merged
into** the project's `work.json` (the rest of the file is preserved). A datasource
is a named external HTTP service a plain `run:` step can reach with a
header-injected token it never actually sees: the secret is swapped in host-side,
scoped to the datasource's host, so it never enters the guest. (For a credential a
CLI must hold to sign, use [`secrets`](./configuration#secrets) instead.)

The generated entry is a safe skeleton, not a live connection:

```json
{
  "datasources": {
    "grafana": {
      "baseUrl": "https://grafana.example.com/api",
      "token": "$GRAFANA_TOKEN",
      "tokenEnv": "GRAFANA_TOKEN"
    }
  }
}
```

- `token` is always a `$VAR` env-ref, never a literal secret. Set the real value
  with `export GRAFANA_TOKEN=...`, never in workflow `env:`.
- `tokenEnv` is emitted explicitly (derived as `<NAME>_TOKEN`) so you can see which
  variable to export.
- **Presets** supply only the *shape* of a product's base URL — edit `baseUrl` to
  your real host. If `<name>` matches a preset id it's inferred; otherwise pass
  `--preset` (or get the `generic` skeleton). Shipped presets: `kubernetes`,
  `prometheus`, `grafana`, `loki`, `tempo`, `mimir`, `alertmanager`, `generic`.
- For a host public DNS can't name (a loopback/kind service, an SSH tunnel, a
  Tailscale peer), add `"resolve": "<ip>"` to the entry. The generator never
  emits it because it's deployment-specific, and pinning also lifts the sandbox's
  private-range block for that IP.

```bash
work create datasource grafana             # infers the grafana preset
work create datasource metrics --preset prometheus
work create datasource api --url https://internal.example.com/v1
```

| Option | Effect |
|---|---|
| `--preset <id>` | Use a known preset's base-URL shape (inferred from `<name>` if omitted). |
| `--url <baseUrl>` | Override the preset's placeholder `baseUrl`. |
| `--force` | Overwrite an existing `datasources.<name>` entry. |
| `--dry-run` | Print the merged entry and exit without touching disk. |

### `work create image`

```bash
work create image <name> [--force] [--dry-run]
```

Scaffolds a custom job image: an arch-agnostic [Gondolin
build-config](../guide/custom-images) at
`.workflows/images/<name>/build-config.json`, which a job then selects with
`runs-on: work:<name>`. The `<name>` is slugged, so `work create image "My Image"`
writes `.workflows/images/my-image/`.

The generated config is the proven `work:base` shape — Alpine with a lean,
bootable package floor (`bash`, `ca-certificates`, `curl`, `git`, `jq`, …) — and
is deliberately **arch-agnostic**: it has no `arch` field, because the engine
injects the host arch right before `gondolin build` (a committed config that pins
an arch fails to build on a different host). Extend it by listing more apk
packages in `alpine.rootfsPackages`, or by adding `postBuild.commands` for
anything not in apk (`npm i -g …`, fetching a pinned tarball). The image builds
lazily the first time a job references it; a user image overrides a bundled
built-in of the same name. See [Custom images](../guide/custom-images).

| Option | Effect |
|---|---|
| `--force` | Overwrite an existing `build-config.json` with a fresh skeleton. |
| `--dry-run` | Print what would be written and exit without touching disk. |

### `work create webhook`

```bash
work create webhook <name> --workflow <existing> [--source <id>] [--datasources a,b] [--force] [--dry-run]
```

Pairs a webhook with an **already existing** workflow. It merges only the
[`webhooks.<name>`](./configuration#webhooks) config half into `work.json` (the
rest of the file is preserved) and **prints the `on: webhook` snippet to paste
in**; it never edits the workflow YAML. Use this to retrofit a workflow created
without `--webhook`; for a fresh workflow, generate both halves at once with
[`work create workflow --webhook`](#work-create-workflow).

```bash
work create webhook alerts --workflow triage --source grafana
```

merges the config half for the existing `triage` workflow and prints the block to
add to `.workflows/triage.yaml`:

```yaml
on:
  webhook:
    secret: alerts
    source: grafana
```

The hook is served by `work serve` at `POST /hooks/<name>`; a smoke-test
endpoint lives at `POST /api/webhooks/<name>/test`. The `secret` is always emitted
as a `$VAR` env-ref (`$ALERTS_SECRET`), never a literal. Run `export ALERTS_SECRET=...`
to set it. `--datasources` selects which datasource credentials the triggered run may use (it does not gate egress, which is open).

`--source` selects the sender preset, which fixes the auth scheme (and the
signature header for senders that sign their deliveries):

| `--source` | `auth` | `signatureHeader` |
|---|---|---|
| `alertmanager` | `bearer` | — |
| `grafana` | `hmac-sha256` | `X-Grafana-Alerting-Signature` |
| `github` | `hmac-sha256` | `X-Hub-Signature-256` (default) |
| `generic` | `bearer` | — |

| Option | Effect |
|---|---|
| `--workflow <existing>` | **Required.** The existing workflow `name:` this hook triggers. |
| `--source <id>` | Sender preset for the webhook auth (`alertmanager`, `grafana`, `github`, `generic`). |
| `--datasources <a,b>` | Datasource keys the webhook-triggered run may use. |
| `--force` | Overwrite an existing `webhooks.<name>` entry. |
| `--dry-run` | Print the merged entry and `on:` snippet, and exit without touching disk. |

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

Runs a project workflow **by its `name:`**: the engine finds the
`.workflows/*.yaml` in the workspace whose `name:` matches `<name>`. `--workspace`
sets the project root (default: current directory).

```bash
work --workspace my-project run report
```

A project run is **durable**: it's recorded in run history and journaled as it
goes, so a run that's interrupted (stopped mid-flight before it finishes) can be
**resumed** rather than lost. (A standalone `work <file>` run, outside a
`.workflows/` project, is ephemeral.) Pass `--resume <id>` to continue a prior run
instead of starting a new one; `work resume <id>` below is the shorthand.

### `work runs`

```bash
work [--workspace <dir>] runs [--status queued|running|success|failure|interrupted]
```

Lists the workspace's run history, newest first: the durable record of every
project run. It reads the **same** durable store [`work serve`](#work-serve) uses,
so it lists runs started either way. It's a *serve-is-down* tool, though: the store
is single-owner, so don't run it against a workspace a `serve` is currently holding.
Read live history through that host's console / `GET /api/runs` instead. `--status`
filters; for example, the runs that didn't finish:

```bash
work runs
work runs --status interrupted
```

Each row shows the run id, workflow, status, and when it started. A run shown as
**interrupted** is resumable, and the listing prints the exact `resume` command.

### `work resume` / `work rerun` / `work retry`

```bash
work [--workspace <dir>] resume <id>   # continue an interrupted run
work [--workspace <dir>] rerun <id>    # re-run a past run fresh, same inputs
work [--workspace <dir>] retry <id>    # re-run only a failed run's failed jobs
```

All three recover a past run **by id** (copy the short id from `work runs` — a
unique prefix is fine); the workflow and inputs come from history, so you don't
retype them:

- **`resume`** continues the *same* run: jobs that already finished are reused,
  not re-executed, and the run picks up from where it stopped. This is how an
  interrupted run is driven to completion. Equivalent to `work run <name> --resume <id>`.
- **`rerun`** starts a *fresh* run with the same inputs (a new run id), re-executing
  everything — handy for re-triggering a report from scratch.
- **`retry`** re-runs only the **failed** jobs of a prior `failure` run, under the
  *same* id: the jobs that already passed are reused (picking up where they left
  off), and just the failed ones run again. This is the “re-run failed jobs” tactic
  from GitHub Actions — the quick way to tell a flaky failure from a real one
  without redoing the work that already succeeded. It errors if the run had no
  failed jobs (use `rerun` to re-run a green run), and downstream jobs that were
  skipped by the failure are re-evaluated by the re-walk.

`--inputs` overrides the stored inputs for any of them.

### `work graph`

```bash
work graph <workflow.yaml|name> [--format <fmt>] [--steps]
```

Compiles the workflow and emits its job DAG **instead of running it** — useful for
review and for embedding in docs. The target is a **file path** when it looks like
one (a `.yaml`/`.yml` extension or a `/`); otherwise it's resolved **by name**:
the `.workflows/*.yaml` in the workspace whose `name:` matches, exactly like
[`work run`](#work-run). So `work graph ci` works from a project root with no extra
flags; `--workspace` sets the project root (default: current directory).

| Option | Effect |
|---|---|
| `--format <fmt>` | Output format: `mermaid` (default), `dot`, `json`, or `ascii`. |
| `--steps` | Expand each job into its ordered steps. |

```bash
work graph ci                                 # by name, from the current project
work graph report.yaml --format ascii --steps # by file path
work --workspace my-project graph report --format mermaid
```

### `work serve`

```bash
work [--workspace <dir>] serve [--port <n>]
```

Boots the long-lived **local host** over the workspace's `.workflows/` instead of
running a single workflow, and keeps the process alive until you stop it
(`Ctrl-C`). One process serves four surfaces: the HTTP API, the browser console,
the [webhook receiver](../guide/web-ui#webhook-triggers), and the
[scheduler](../guide/web-ui#scheduled-triggers) that fires `on: schedule`
triggers. It prints what it bound:

```bash
work serve
# work serve: http://127.0.0.1:4280/
#   workspace: /path/to/project
#   history:   /path/to/project/.workflows/db
#   auth token: 1f3a…
# Press Ctrl-C to stop.
```

From the browser you can run workflows from an auto-generated input form, watch
runs stream live, browse durable history (and re-run), manage webhook triggers,
and see the schedules the host is driving. The server binds **loopback only**
(`127.0.0.1`), validates the `Host` header, and requires a CSRF token on every
mutating request. History, deliveries, and schedule state live under
`<workspace>/.workflows/db/`. See the [serve host guide](../guide/web-ui) for the
full tour.

| Option | Effect |
|---|---|
| `--workspace <dir>` | Project root whose `.workflows/` the host serves (default: current directory). |
| `--port <n>` | Port to bind (default `4280`; an integer `1`–`65535`). |

`serve` takes no positional arguments, and `--port` only applies to `serve`. Run
**one** `serve` per workspace — it's the sole owner of that workspace's durable
store (see [the guide](../guide/web-ui)).

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

Pass `--json` for machine-readable output. The output leads with the installed
version (a `version` field under `--json`) — handy to include when filing an issue.

**Exit codes:** `0` — no hard failures (warnings are allowed); `1` — at least one
failed check; `2` — a usage error (e.g. an unknown flag).

### `work version`

```bash
work version       # also: work --version, work -v
```

Prints the installed version and exits. The output is the bare version string
(e.g. `0.3.4`), so it reads cleanly in a script:

```bash
v=$(work version)
```

## Flags

| Flag | Applies to | Effect |
|---|---|---|
| `--workspace <dir>` | `run`, `graph`, `serve` | Project root for resolving a workflow by name / serving the host (default: current directory). |
| `--port <n>` | `serve` | Port the host binds (default `4280`; `1`–`65535`). |
| `--inputs '<json>'` | `run`, file, `resume`, `rerun`, `retry` | Values for the workflow's declared `inputs:`, as a JSON object — e.g. `'{"name":"ada"}'`. For `resume`/`rerun`/`retry`, overrides the inputs stored in history. |
| `--config <file>` | `run`, file | Project-layer model/provider config file. Default: `./work.json`, or `$WORK_CONFIG`. |
| `--datasources <a,b>` | `run`, file | [Datasources](./configuration#datasources) whose credentials this run's jobs may use (comma-separated; the CLI counterpart of a webhook's `datasources` scope). Deny-by-default: none injected when omitted. Selects credentials, not reachability — egress is open. |
| `--no-global` | `run`, file | Skip the machine-wide global config layer, for a hermetic, reproducible run. |
| `--workdir <dir>` | `run`, file | Where job workspaces are staged (default: a temp dir). |
| `--resume <id>` | `run` | Continue an interrupted run instead of starting a new one (same run id; finished jobs are reused). Project workflows only. |
| `--status <s>` | `runs` | Filter the run history by status (`queued`, `running`, `success`, `failure`, `interrupted`). |
| `--quiet` | `run`, file | Suppress the live board / per-job output. |
| `--format <fmt>` | `graph` | DAG output format: `mermaid`, `dot`, `json`, `ascii`. |
| `--steps` | `graph` | Expand each job into its ordered steps. |
| `--json` | `doctor` | Emit machine-readable check results. |
| `-h`, `--help` | any | Print usage and exit. |
| `-v`, `--version` | (standalone) | Print the installed version and exit. |

## Output and exit status

When running a workflow, the presenter adapts to the environment:

- **Interactive TTY** — a live, dependency-aware status board.
- **A pipe or non-interactive runner** — buffered per-job output blocks.
- **`--quiet`** — no board or per-job output.

A run exits **`0`** on success and **non-zero** if a job fails or the run is
interrupted, so it drops into a script or scheduler cleanly. An interrupted
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
