# Introduction

**work** runs YAML-defined workflows on your own machine. Each job is
isolated in a secure micro-VM, execution is durable and crash-resumable, and any
step can be a plain shell command, or an **AI agent step** that hands work to a
real agent running inside the sandbox.

It's a general workflow engine, not a single-purpose tool. If you'd reach for a
shell script plus a scheduler (build-and-test, data processing, a nightly report,
a deploy, scrape-then-summarize), you can express it here instead, with structure,
isolation, durability, and an agent strapped to any step that needs judgment.

```yaml
# .workflows/report.yaml
name: report
jobs:
  summarize:
    runs-on: work:base         # a custom image with git + jq, in its own micro-VM
    steps:
      - run: node scripts/aggregate.js > data.json   # steps in a job share one workspace
      - uses: work/agent       # an AI agent reads data.json and writes the summary
        with:
          prompt: Read data.json and write a short summary.
```

```bash
work --workspace . run report
```

## Why work?

Plenty of work is worth automating right on your own machine — multi-step jobs
you'd otherwise wire together by hand. But running arbitrary steps locally usually
means either trusting them against your host or standing up heavy infrastructure.
work takes a different stance:

- **Local-first.** No control plane, no external services, no account. The engine
  is a single CLI; durable state lives in an in-process Postgres.
- **Isolated by default.** Every job runs in its own [Gondolin](https://www.npmjs.com/package/@earendil-works/gondolin)
  micro-VM. There is no host-execution mode — steps never run directly on your
  machine. Egress is open; the sandbox isolates your host, not the job's network.
- **Durable.** A workflow compiles to a graph of durable tasks; each step is a
  journaled checkpoint, so the engine knows exactly what already ran.
- **Agent-native.** An AI agent can be a first-class step, working inside the same
  sandbox as the rest of the job with its full toolset rooted at the checkout:
  reading, editing, and making decisions in line with everything else.

## The shape of a workflow

A workflow is a single YAML file. The pieces:

| Piece | What it is |
|---|---|
| **Workflow** | the file itself: a `name:` and a set of named jobs. |
| **Job** | an isolated unit of work, run in its own micro-VM (`runs-on: gondolin`), sized with `machine:`. |
| **Step** | a shell command (`run:`) or a `uses:` reference — the built-in [`work/agent`](./agent-steps) AI agent or your own [action](./actions) (`action/<name>`). |
| **`needs`** | dependencies between jobs; independent jobs run in parallel. |
| **Inputs / outputs / matrix / conditionals** | typed parameters, data passing between jobs, fan-out, and guards. |

That's the whole surface, and a job can even be a call to *another* whole
workflow, so you compose pipelines from smaller ones (see
[Reusable workflows](./reusable-workflows)). [Writing a workflow](./writing-workflows)
walks through each piece with examples.

## What you get

Everything in this guide is built and runs end to end:

- **Named jobs** scheduled across a `needs` DAG, each isolated in its own micro-VM,
  with independent jobs running in parallel.
- **Per-job machine sizing**: pick a named type (`small`/`medium`/`large`/`xlarge`)
  or set custom `cpus`/`memory` for the VM.
- **Layered env** at the workflow, job, and step level.
- **Typed inputs** with validation, **outputs** passed between jobs, **matrix**
  fan-out, and runtime **conditionals**.
- **AI agent steps** that run a real agent inside the sandbox, rooted at the
  checkout.
- **Durable execution** journaled to an in-process Postgres, so a run knows exactly
  what already happened.

All of it runs from a single CLI on your machine.

::: tip Where to go next
New here? Start with [Installation](./installation) and the [Quickstart](./quickstart).
Ready to write a real workflow? Jump to [Writing a workflow](./writing-workflows).
:::
