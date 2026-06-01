# pi-workflows

[![CI](https://github.com/nullbytelabs/pi-workflows/actions/workflows/ci.yml/badge.svg)](https://github.com/nullbytelabs/pi-workflows/actions/workflows/ci.yml)

Run **GitHub-Actions-style workflows on your own machine**, with each job isolated in a secure micro-VM and durable, crash-resumable execution. Steps are shell commands — or **AI agent steps** that hand work to a real coding agent running inside the sandbox.

```yaml
# .workflows/ci.yaml
name: ci
jobs:
  build:
    runs-on: gondolin          # each job runs in its own micro-VM
    steps:
      - run: npm install
      - run: npm test
  review:
    needs: [build]
    runs-on: gondolin
    steps:
      - uses: agent/review     # an AI agent reviews the checkout
```

```bash
./pi-workflows --workspace . run ci
```

---

## Requirements

- **Node.js ≥ 23.6** — runs the engine's TypeScript directly, with no build step.
- **QEMU** — every job runs in the `gondolin` micro-VM (there is no host-execution mode), so QEMU is required. macOS works out of the box; Linux needs KVM. Install with `brew install qemu` (macOS) or `apt-get install qemu-system-x86 qemu-utils` (Linux).
- macOS or Linux.

> The first sandboxed run downloads a ~200 MB guest image (cached afterward). The guest ships `sh`, `bash`, `node`, `npm`, and `python3`, so your steps run without any host toolchain.

## Install

```bash
git clone https://github.com/nullbytelabs/pi-workflows
cd pi-workflows
npm install
./pi-workflows --help
```

`./pi-workflows` is a thin launcher that runs the engine on Node's native TypeScript — there's nothing to build.

## Quickstart

Run a single workflow file:

```bash
./pi-workflows ./test/e2e/hello-world-gondolin/workflow.yaml
```

On a terminal you get a live, dependency-aware status board; in CI or a pipe it prints buffered per-job output and exits non-zero on failure.

The [`test/e2e/`](test/e2e/) folder is a gallery of runnable examples (matrix builds, fan-out/fan-in, conditionals, typed inputs, an agent project, …) — each is a real workflow you can run directly.

---

## Writing a workflow

A workflow is a YAML file: a set of **jobs**, each a list of ordered **steps**. It mirrors GitHub Actions, so most of it will look familiar.

```yaml
name: build-and-report

env:
  STAGE: ci                      # workflow-wide env (jobs/steps can override)

jobs:
  build:
    runs-on: gondolin            # where the job runs (default: gondolin)
    steps:
      - name: install
        run: npm install
      - id: meta                 # give a step an id to expose outputs
        name: record version
        run: echo "version=$(node -p 'require("./package.json").version')" >> "$PI_OUTPUT"

  report:
    needs: [build]               # runs after build succeeds
    runs-on: gondolin
    steps:
      - name: show
        env:
          V: ${{ needs.build.outputs.version }}
        run: echo "built version $V"
    outputs:
      version: ${{ steps.meta.outputs.version }}
```

The building blocks:

| Feature | How |
|---|---|
| **Jobs & steps** | `jobs:` → named jobs, each with ordered `steps:`. A step is a `run:` command or a `uses:` agent. |
| **`runs-on`** | `gondolin` — every job runs in a micro-VM (the only target, and the default; state it explicitly per job). |
| **`needs`** | `needs: [build]` — a job waits for its dependencies. Independent jobs run **in parallel**. |
| **`env`** | declared at workflow, job, or step level; inner scopes override outer. |
| **Inputs** | `inputs:` declares typed params (`string`/`number`/`boolean`, with `required`/`default`/`options`/`pattern`). Pass at run time with `--inputs '{"name":"josh"}'`, read via `${{ inputs.name }}`. |
| **Outputs** | a step writes `key=value` to `$PI_OUTPUT`; a job re-exposes them via `outputs:`; downstream reads `${{ needs.<job>.outputs.<key> }}` or `${{ steps.<id>.outputs.<key> }}`. |
| **Matrix** | `strategy.matrix:` fans a job out into one run per combination, with `include`/`exclude`; read the cell via `${{ matrix.<axis> }}`. |
| **Conditionals** | `if:` (or `when:`) on a step or job — a false result skips it. Supports `inputs.*`, `matrix.*`, `needs.*`, `steps.*`, `==`/`!=`/`&&`/`||`/`!`, and `success()`/`failure()`/`always()`/`cancelled()`. |

See [`test/e2e/`](test/e2e/) for a worked example of each.

---

## The `.workflows/` project layout

For a real project, keep your pipelines and agents in a `.workflows/` directory — the same idea as `.github/workflows/`:

```
my-project/
├── package.json
├── src/…
└── .workflows/
    ├── ci.yaml                 # a pipeline (name: ci)
    └── agents/
        └── review/             # a local agent package
            ├── agent.yaml
            ├── instructions.md
            └── task.md
```

Run a pipeline **by its `name:`**:

```bash
./pi-workflows --workspace my-project run ci
```

When a workflow lives in `.workflows/`, the **project root** (the parent) is what gets checked out into each job's workspace — so `package.json`, your source, `npm install`, etc. are all there. Each job gets its own fresh copy (`.git/` and `node_modules/` are never staged, so jobs install their own deps). A standalone `workflow.yaml` outside `.workflows/` uses its own folder as the checkout instead.

---

## Agent steps (AI)

An agent step runs a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent **inside the job's micro-VM**, with its full toolset rooted at the checkout — so it can read and edit the project's files directly. The model is reached only through the sandbox's mediated egress, and your API key is injected host-side and never enters the guest.

**1. Configure a model** in `pi-workflows.config.json` (loaded automatically from the working directory; or pass `--config`, or set `$PI_WORKFLOWS_CONFIG`):

```json
{
  "providers": {
    "fireworks": {
      "baseUrl": "https://api.fireworks.ai/inference/v1",
      "apiKey": "$FIREWORKS_API_KEY"
    }
  },
  "models": {
    "kimi": {
      "provider": "fireworks",
      "model": "accounts/fireworks/models/kimi-k2p6",
      "maxTokens": 2048
    }
  },
  "defaultModel": "kimi"
}
```

`apiKey` supports `$VAR` / `${VAR}` expansion, so secrets stay in your environment. See [`pi-workflows.config.example.json`](pi-workflows.config.example.json).

**2. Define an agent** as a package under `.workflows/agents/<name>/`:

- `agent.yaml` — manifest: `name`, `description`, declared `inputs`/`outputs`.
- `instructions.md` — the system prompt (the agent's standing role).
- `task.md` — the task prompt, with optional `{{ input }}` placeholders bound from the step's `with:`.

**3. Use it** in a workflow:

```yaml
jobs:
  review:
    runs-on: gondolin
    steps:
      - id: summary
        uses: agent/review
      - run: echo "review -> ${{ steps.summary.outputs.summary }}"
```

The agent's final message becomes the step's declared output (e.g. `steps.summary.outputs.summary`). [`test/e2e/agent-project/`](test/e2e/agent-project/) is a complete, runnable example — a `ci.yaml` pipeline (install deps → typecheck → smoke test) and a separate `review.yaml` where an agent reviews the source.

---

## CLI reference

```bash
# run a workflow file directly
./pi-workflows <workflow.yaml> [--inputs '<json>'] [--config <file>] [--workdir <dir>] [--quiet]

# run a project pipeline by name (resolves .workflows/*.yaml whose `name:` matches)
./pi-workflows [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--quiet]

# print the job DAG instead of running it
./pi-workflows graph <workflow.yaml|name> [--format mermaid|dot|json|ascii] [--steps]
```

| Flag | Effect |
|---|---|
| `--workspace <dir>` | project root for `run <name>` / `graph <name>` (default: current dir) |
| `--inputs '<json>'` | values for the workflow's declared `inputs:` |
| `--config <file>` | model/provider config (default: `./pi-workflows.config.json`, or `$PI_WORKFLOWS_CONFIG`) |
| `--workdir <dir>` | where job workspaces are staged (default: a temp dir) |
| `--quiet` | suppress the live board / per-job output |
| `--steps` | (graph) expand each job into its ordered steps |

---

## How it works

Under the hood, a workflow compiles to a graph of durable tasks: each **job** is an [Absurd](https://www.npmjs.com/package/absurd-sdk) task and each **step** is a checkpoint, journaled to an in-process Postgres ([PGLite](https://www.npmjs.com/package/@electric-sql/pglite)) — no external services. The `needs` DAG drives parallel scheduling; every job runs in a [Gondolin](https://www.npmjs.com/package/@earendil-works/gondolin) micro-VM, and agent steps invoke Pi inside that sandbox.

The deep dives live in [`docs/`](docs/): [`phase-1.md`](docs/phase-1.md) (what's built + internals), [`absurd-durable-workflows.md`](docs/absurd-durable-workflows.md), [`gondolin-secure-execution.md`](docs/gondolin-secure-execution.md), [`pi-in-gondolin.md`](docs/pi-in-gondolin.md), and [`agent-uses-interface.md`](docs/agent-uses-interface.md).

**Not yet:** `on:` triggers, multi-turn agents, cross-run `--resume`, matrix `max-parallel`/`fail-fast`, and the `github` expression context.

## Development

```bash
npm test          # unit + e2e (boots real micro-VMs; needs QEMU)
npm run lint      # eslint
npm run typecheck # tsc --noEmit
```
