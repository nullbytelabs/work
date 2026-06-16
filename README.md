# work

[![CI](https://github.com/nullbytelabs/work/actions/workflows/ci.yml/badge.svg)](https://github.com/nullbytelabs/work/actions/workflows/ci.yml)

📖 **[Read the documentation →](https://nullbytelabs.github.io/work/)**

Run **any workflow on your own machine**, with each job isolated in a secure micro-VM and durable, crash-resumable execution. Steps are shell commands — or **AI agent steps** that strap a real agent to the work, running inside the sandbox.

It's a general workflow engine: anything you'd otherwise wire together with a shell script and a scheduler — build-and-test, data processing, a nightly report, a deploy, scrape-then-summarize — with structure, isolation, durability, and an agent on any step that needs judgment.

```yaml
# .workflows/report.yaml
name: report
jobs:
  collect:
    runs-on: gondolin          # each job runs in its own micro-VM
    steps:
      - run: node scripts/aggregate.js > data.json
  summarize:
    needs: [collect]
    runs-on: gondolin
    steps:
      - uses: work/agent       # an AI agent reads data.json and writes the summary
        with:
          prompt: Read data.json and write a short summary.
```

```bash
work --workspace . run report
```

---

## Requirements

- **Node.js ≥ 23.6** — runs the engine's TypeScript directly, with no build step.
- **QEMU** — every job runs in the `gondolin` micro-VM (there is no host-execution mode), so QEMU is required. macOS works out of the box; Linux needs KVM. Install with `brew install qemu` (macOS) or `apt-get install qemu-system-x86 qemu-utils` (Linux).
- macOS or Linux.

> The first sandboxed run downloads a ~200 MB guest image (cached afterward). The guest ships `sh`, `bash`, `node`, `npm`, and `python3`, so your steps run without any host toolchain.

## Install

Via npm — no clone, no build step:

```bash
# run it once, nothing installed (fetches on first use)
npx @nullbytelabs/work --help

# or put the `work` command on your PATH for good
npm i -g @nullbytelabs/work
work --help
```

This gives you `work` (and the alias `workflow`). Both still need **Node ≥ 23.6 and QEMU** — see [Requirements](#requirements).

<details>
<summary>From source (development)</summary>

```bash
git clone https://github.com/nullbytelabs/work
cd work
npm install
./bin/work.mjs --help   # runs src/cli.ts directly (no dist/), no build step
```

</details>

## Quickstart

Write a workflow and run it:

```bash
cat > hello.yaml <<'EOF'
name: hello
jobs:
  greet:
    runs-on: gondolin
    steps:
      - run: echo "hello from the sandbox"
EOF

work hello.yaml
```

On a terminal you get a live, dependency-aware status board; in a pipe or non-interactive runner it prints buffered per-job output and exits non-zero on failure.

The [`test/e2e/`](test/e2e/) folder is a gallery of runnable examples (matrix builds, fan-out/fan-in, conditionals, typed inputs, an agent project, …) — clone the repo to run them directly.

---

## Writing a workflow

A workflow is a YAML file: a set of **jobs**, each a list of ordered **steps**. The surface is small.

```yaml
name: build-and-report

env:
  STAGE: nightly                 # workflow-wide env (jobs/steps can override)

jobs:
  build:
    runs-on: gondolin            # where the job runs (default: gondolin)
    steps:
      - name: install
        run: npm install
      - id: meta                 # give a step an id to expose outputs
        name: record version
        run: echo "version=$(node -p 'require("./package.json").version')" >> "$WORK_OUTPUT"

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
| **Inputs** | `inputs:` declares typed params (`string`/`number`/`boolean`, with `required`/`default`/`options`/`pattern`). Pass at run time with `--inputs '{"name":"ada"}'`, read via `${{ inputs.name }}`. |
| **Outputs** | a step writes `key=value` to `$WORK_OUTPUT`; a job re-exposes them via `outputs:`; downstream reads `${{ needs.<job>.outputs.<key> }}` or `${{ steps.<id>.outputs.<key> }}`. |
| **Matrix** | `strategy.matrix:` fans a job out into one run per combination, with `include`/`exclude`; read the cell via `${{ matrix.<axis> }}`. |
| **Conditionals** | `if:` (or `when:`) on a step or job — a false result skips it. Supports `inputs.*`, `matrix.*`, `needs.*`, `steps.*`, `==`/`!=`/`&&`/`||`/`!`, and `success()`/`failure()`/`always()`/`cancelled()`. |

See [`test/e2e/`](test/e2e/) for a worked example of each.

---

## The `.workflows/` project layout

For a real project, keep your workflows and agents together in a `.workflows/` directory at the project root:

```
my-project/
├── package.json
├── src/…
└── .workflows/
    ├── verify.yaml             # a workflow (name: verify)
    └── actions/
        └── review/             # a local action (composite or JS)
            ├── action.yaml
            └── prompt.md       # e.g. a composite action wrapping work/agent
```

Run a workflow **by its `name:`**:

```bash
work --workspace my-project run verify
```

When a workflow lives in `.workflows/`, the **project root** (the parent) is what gets checked out into each job's workspace — so `package.json`, your source, `npm install`, etc. are all there. Each job gets its own fresh copy (`.git/` and `node_modules/` are never staged, so jobs install their own deps). A standalone `workflow.yaml` outside `.workflows/` uses its own folder as the checkout instead.

---

## Agent steps (AI)

An agent step runs a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent **inside the job's micro-VM**, with its full toolset rooted at the checkout — so it can read and edit the project's files directly. The model is reached only through the sandbox's mediated egress, and your API key is injected host-side and never enters the guest.

**1. Configure a model** in `work.json` (loaded automatically from the working directory; or pass `--config`, or set `$WORK_CONFIG`):

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

`apiKey` supports `$VAR` / `${VAR}` expansion, so secrets stay in your environment. See [`work.example.json`](work.example.json).

**2. Use the `work/agent` primitive** — prompt it entirely through `with:`. Its final message becomes the step output `output`:

```yaml
jobs:
  review:
    runs-on: gondolin
    steps:
      - id: summary
        uses: work/agent
        with:
          prompt: You are a code reviewer. Review main.ts and summarize it in one sentence.
      - run: echo "review -> ${{ steps.summary.outputs.output }}"
```

The prompt can also be file-backed (`promptFile:`); there's no separate system-prompt input. **To package a named, reusable agent**, wrap `work/agent` in a composite action under `.workflows/actions/<name>/` (`uses: action/<name>`) — see the [actions guide](https://nullbytelabs.github.io/work/guide/actions). [`test/e2e/agent-project/`](test/e2e/agent-project/) is a complete, runnable example — a verification workflow and a `review.yaml` where a composite action reviews the source.

---

## CLI reference

```bash
# run a workflow file directly
work <workflow.yaml> [--inputs '<json>'] [--config <file>] [--datasources <a,b>] [--workdir <dir>] [--resume <id>] [--quiet]

# run a project workflow by name (resolves .workflows/*.yaml whose `name:` matches)
work [--workspace <dir>] run <name> [--inputs '<json>'] [--config <file>] [--datasources <a,b>] [--resume <id>] [--quiet]

# print the job DAG instead of running it
work graph <workflow.yaml|name> [--format mermaid|dot|json|ascii] [--steps]

# boot the long-lived local host: web console + webhook receiver + scheduler
work serve [--workspace <dir>] [--port <n>]
```

| Flag | Effect |
|---|---|
| `--workspace <dir>` | project root for `run <name>` / `graph <name>` (default: current dir) |
| `--inputs '<json>'` | values for the workflow's declared `inputs:` |
| `--config <file>` | model/provider config (default: `./work.json`, or `$WORK_CONFIG`) |
| `--datasources <a,b>` | datasource keys this run's jobs may reach (header-injected egress; see config) |
| `--workdir <dir>` | where job workspaces are staged (default: a temp dir) |
| `--resume <id>` | resume a prior interrupted run (a persisted `.workflows/` project run) |
| `--quiet` | suppress the live board / per-job output |
| `--steps` | (graph) expand each job into its ordered steps |
| `--port <n>` | (serve) HTTP port for the local host (default: 4280) |

---

## The serve host, triggers, and observability

Beyond one-shot CLI runs, `work serve` boots a long-lived **local host** for a project (loopback only): a browser console to launch and watch workflows live, an authenticated **webhook receiver** (`on: webhook`), and a **scheduler** for `on: schedule` cron triggers — one process, the same engine. See [the serve host guide](https://nullbytelabs.github.io/work/guide/web-ui).

Any run can also emit **OpenTelemetry** traces and metrics over OTLP — off by default, enabled with one `observability` block in `work.json` (or plain `OTEL_*` env vars). Point it at any collector to see runs as standard distributed traces with per-model token usage. See [Observability](https://nullbytelabs.github.io/work/guide/observability).

---

## How it works

Under the hood, a workflow compiles to a graph of durable tasks: each **job** is an [Absurd](https://www.npmjs.com/package/absurd-sdk) task and each **step** is a checkpoint, journaled to an in-process Postgres ([PGLite](https://www.npmjs.com/package/@electric-sql/pglite)) — no external services. The `needs` DAG drives parallel scheduling; every job runs in a [Gondolin](https://www.npmjs.com/package/@earendil-works/gondolin) micro-VM, and agent steps invoke Pi inside that sandbox.

The deep dives live in [`docs/`](docs/): [`absurd-durable-workflows.md`](docs/absurd-durable-workflows.md) (durability model), [`gondolin-secure-execution.md`](docs/gondolin-secure-execution.md), [`pi-in-gondolin.md`](docs/pi-in-gondolin.md), and [`agent-primitive-and-actions.md`](docs/agent-primitive-and-actions.md).

## Development

```bash
npm test          # unit + e2e (boots real micro-VMs; needs QEMU)
npm run lint      # eslint
npm run typecheck # tsc --noEmit
```
