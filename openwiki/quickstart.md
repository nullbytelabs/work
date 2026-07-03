# Work — OpenWiki Quickstart

**`work`** (`@nullbytelabs/work`) is a local, secure workflow engine. You write YAML workflows (GitHub-Actions-style syntax — jobs → steps, a `needs` DAG), and every job runs isolated in a **Gondolin micro-VM** (real QEMU virtualization, not containers). Execution is **durable** — crash-resumable via an embedded Postgres journal. Any step can optionally hand off to an **AI agent** (a real Pi coding agent) that runs *inside the sandbox* alongside the work.

It's a general workflow engine: anything you'd otherwise wire together with a shell script and a scheduler — build-and-test, data processing, a nightly report, a deploy, scrape-then-summarize — with structure, isolation, durability, and an agent on any step that needs judgment.

## What This Is

- **YAML workflow engine** with jobs, steps, `needs` DAG, matrix fan-out, conditionals, typed inputs/outputs, reusable workflows.
- **Sandboxed execution** — every job runs in a Gondolin micro-VM. There is no host-execution mode. QEMU is required.
- **Durable runs** — each step is a checkpoint journaled to an in-process Postgres (PGLite). Interrupted runs resume; failed jobs can be retried individually.
- **AI agent steps** — `uses: work/agent` runs a Pi coding agent inside the job's micro-VM, rooted at the checkout, with its full toolset. Your API key is injected host-side and never enters the guest.
- **Local web host** — `work serve` boots a browser console, webhook receiver, and cron scheduler in one process (loopback only).
- **OpenTelemetry** — runs emit standard OTLP traces and metrics when enabled.

## Requirements

- **Node.js ≥ 23.6** (native TypeScript type-stripping — no build step in dev)
- **QEMU** — every job runs in a micro-VM. macOS works out of the box; Linux needs KVM. Install with `brew install qemu` (macOS) or `apt-get install qemu-system-x86 qemu-utils` (Linux).
- macOS or Linux.

> The first sandboxed run downloads a ~200 MB guest image (cached afterward). The guest ships `sh`, `bash`, `node`, `npm`, and `python3`.

## Install

```bash
# run once, nothing installed (fetches on first use)
npx @nullbytelabs/work --help

# or install globally
npm i -g @nullbytelabs/work
work --help
```

From source (development):

```bash
git clone https://github.com/nullbytelabs/work
cd work
npm install
./bin/work.mjs --help   # runs src/cli.ts directly — no build step
```

## Quickstart

```bash
cat > hello.yaml <<'EOF'
name: hello
jobs:
  greet:
    runs-on: work:base
    steps:
      - run: echo "hello from the sandbox"
EOF

work hello.yaml
```

On an interactive terminal you get a live DAG-aware status board. In a pipe or CI runner it prints buffered per-job output and exits non-zero on failure.

The [`test/e2e/`](../test/e2e/) folder is a gallery of runnable examples — matrix builds, fan-out/fan-in, conditionals, typed inputs, agent projects, custom images.

## CLI Surface

```bash
work <workflow.yaml> [--inputs '<json>'] [--config <file>] [--resume <id>] [--quiet]
work [--workspace <dir>] run <name> [--inputs '<json>'] [--resume <id>] [--quiet]
work graph <file|name> [--format mermaid|dot|json|ascii] [--steps]
work resume <id>          # continue an interrupted run
work rerun <id>           # fresh run with same inputs
work retry <id>           # re-run only failed jobs
work runs [--status <s>] [--full]  # list run history (--full prints the full UUID)
work logs <id>            # replay a past run's log frames
work serve [--port <n>]   # web console + webhooks + scheduler
work init [--global] [--include-skill]  # scaffold a project (or a global config)
work create <noun> <name> # create workflow/image/webhook
work doctor [--json]      # preflight checks
work version              # print the version
```

Key flags: `--workspace` (project root), `--inputs` (typed params as JSON object), `--config` (model config, default `./work.json`; or `$WORK_CONFIG`), `--no-global` (skip the global config layer), `--workdir` (job staging dir), `--quiet`.

**Run commands** accept the short 8-char ID prefix from `work runs` output (ambiguous prefix → error with suggestions). A bare `<workflow.yaml>` path runs ephemerally (no persistent store, no resume). A `.workflows/` project persists to `.workflows/db` — enabling `resume`, `retry`, `runs`, and `logs`. On an interrupted run, the CLI suggests `--resume`; on failure, it suggests `retry`. Exit code: `0` on success, `1` on failure or interruption.

## Configuration

Agent steps need a model configured in `work.json` (loaded from the working directory, or `--config`, or `$WORK_CONFIG`):

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
      "maxTokens": 32768
    }
  },
  "defaultModel": "kimi"
}
```

`apiKey` supports `$VAR` / `${VAR}` expansion — secrets stay in your environment. See [`work.example.json`](../work.example.json).

`work.json` is **JSONC** (line/block comments and trailing commas allowed) and loaded in **layers**: an optional global file (`$XDG_CONFIG_HOME/work/work.json`, then `~/.config/work/`, then `~/.work/` as a read-only fallback) merged under the project file, with `--config` / `$WORK_CONFIG` overriding the project path and `--no-global` dropping the global layer. `providers`/`models`/`webhooks`/`secrets` merge by key; `defaultModel` and `observability` are last-writer-wins. Cross-references (model→provider, `defaultModel`→models, webhook workflow non-empty) are validated once after the merge. See [Configuration](operations/config.md) for the full config shape (`secrets`, `webhooks`, `observability` sub-toggles) and the two env-expansion modes.

## Documentation Sections

| Section | What it covers |
|---|---|
| [Architecture](architecture/architecture.md) | The compile pipeline, layered design, the shared run path, how subsystems connect |
| [Workflow Syntax](workflows/workflow-syntax.md) | Jobs, steps, needs DAG, inputs/outputs, matrix, conditionals, expressions, reusable workflows |
| [Agent Steps & Actions](agent/agent-steps.md) | The `work/agent` primitive, in-guest Pi execution, host-side key injection, the action system |
| [Durable Execution & Targets](runtime/durable-execution.md) | AbsurdRuntime, checkpointing, resume/retry, PGLite, GondolinTarget, custom images |
| [Serving, Triggers & Observability](operations/serve-and-triggers.md) | Web console, webhook/schedule triggers, run history, OpenTelemetry |
| [Configuration](operations/config.md) | `work.json` shape, layered config, JSONC, `$VAR` expansion, secrets/webhooks/observability |
| [CLI Tools](operations/cli-tools.md) | `work doctor` preflight checks, `work graph` DAG export, `work create`/`work init` scaffolding, TUI presenters |
| [Development & Testing](development/development.md) | Commands, test tiers, structural reports, building/publishing, conventions, dogfooded CI |

## Key Design Principles

1. **Sandbox-only execution** — every job runs in a micro-VM. No host-execution mode exists. Security is not optional.
2. **Durable by default** — every step is a checkpoint. Interruption → resume; failure → retry (only failed jobs).
3. **One run path** — CLI and web UI share `startRun()` in `src/run.ts`. No duplicated execution logic.
4. **Filesystem-pure compiler** — all I/O is injected. The compiler does no file reads.
5. **Agent-agnostic runtime core** — `uses:` handlers are composed in at the `run.ts` layer; the durable core imports zero agent/config code.
6. **Two-phase expression resolution** — compile-time bindings (`inputs`, `matrix`, `event`) are baked into the plan; runtime bindings (`needs`, `steps`, `secrets`) are deferred. Secrets never land in the durable journal.

## Source Layout

```
src/
  cli.ts          entrypoint: resolve → read → parse → compile → run
  run.ts          the single shared run path (CLI + web both call startRun)
  project.ts      .workflows/ layout resolution
  errors.ts       UserFacingError — clean errors without stack traces
  spec/           parse + validate YAML into a typed WorkflowSpec
  compiler/       WorkflowSpec → ExecutionPlan (the durable DAG)
  runtime/        ExecutionPlan → WorkflowResult (Absurd durable executor)
  targets/        where steps run (GondolinTarget — the micro-VM)
  agent/          work/agent primitive, in-guest Pi runner, egress/key injection
  actions/        user-space actions (JS + composite), builtin checkout/install-node
  config/         work.json — providers, models, secrets, webhooks, observability
  web/            work serve — HTTP API + SSE + inline web console
  scheduler/      cron schedule triggers (pure tick function)
  persistence/    run history, event replay, schedules, webhook deliveries (PGLite)
  observability/  OTLP traces + metrics (RunHooks consumer)
  tui/            terminal UI presenters (live board / buffered / silent)
  scaffold/       work create — workflow/image/webhook generators
  init/           work init — project scaffolding
  images/         work:* custom VM image management (build-configs, lazy builds)
  graph/          work graph — DAG export (mermaid/dot/json/ascii)
  doctor/         work doctor — preflight environment checks
```

## External Documentation

- **[Documentation site](https://nullbytelabs.github.io/work/)** — the canonical user-facing docs (VitePress, in `docs-site/`)
- **[Design records](../docs/README.md)** — the *why* behind the architecture (threat models, trade-offs, alternatives weighed), in `docs/`
- **[AGENTS.md](../AGENTS.md)** — comprehensive agent guidance for working in this repository
