# Introduction

**pi-workflows** runs GitHub-Actions-style workflows on your own machine. Each job
is isolated in a secure micro-VM, execution is durable and crash-resumable, and a
step can be a plain shell command — or an **AI agent step** that hands work to a
real coding agent running inside the sandbox.

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
work --workspace . run ci
```

## Why pi-workflows?

CI pipelines are useful well before you push to a forge — but running them locally
usually means either trusting arbitrary steps against your host, or standing up
heavy infrastructure. pi-workflows takes a different stance:

- **Local-first.** No control plane, no external services, no account. The engine
  is a single CLI; durable state lives in an in-process Postgres.
- **Isolated by default.** Every job runs in its own [Gondolin](https://www.npmjs.com/package/@earendil-works/gondolin)
  micro-VM. There is no host-execution mode — steps never run directly on your
  machine, and network access is mediated.
- **Durable.** A workflow compiles to a graph of durable tasks; each step is a
  journaled checkpoint, so the engine knows exactly what already ran.
- **Agent-native.** An AI coding agent can be a first-class step, working inside
  the same sandbox as the rest of the job with its full toolset rooted at the
  checkout.

## How it maps to GitHub Actions

If you've written a GitHub Actions workflow, you already know most of this. A
workflow is a YAML file describing **jobs**, each a list of ordered **steps**.

| Concept | pi-workflows | GitHub Actions |
|---|---|---|
| Pipeline file | `.workflows/ci.yaml` | `.github/workflows/ci.yaml` |
| Where a job runs | `runs-on: gondolin` (a micro-VM) | `runs-on: ubuntu-latest` (a hosted runner) |
| Job dependencies | `needs: [build]` | `needs: [build]` |
| Reusable unit | `uses: agent/review` (an AI agent) | `uses: actions/checkout@v4` (an action) |
| Run a pipeline | `work run ci` | push / dispatch on the forge |

The differences that matter most: jobs run in **local micro-VMs** rather than
hosted runners, and the reusable `uses:` unit is an **AI agent package** rather
than a marketplace action.

## What's here and what's next

pi-workflows is young. The core engine — jobs, steps, the `needs` DAG, env,
typed inputs, outputs, matrix, conditionals, and agent steps — is built and runs
end to end. Some GitHub Actions features are deliberately **not yet** implemented:

- `on:` triggers (the key is parsed but not acted on)
- multi-turn agents and cross-run `--resume`
- matrix `max-parallel` / `fail-fast`
- the `github` expression context

::: tip Where to go next
New here? Start with [Requirements](./requirements), then [Installation](./installation)
and the [Quickstart](./quickstart). Ready to write real pipelines? Jump to
[Writing a workflow](./writing-workflows).
:::
