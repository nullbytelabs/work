# How it works

You don't need any of this to use pi-workflows — but if you're curious what
happens between `work run <name>` and a finished run, here's the shape of it.

## From YAML to a durable graph

A workflow compiles to a graph of **durable tasks**:

- Each **job** becomes an [Absurd](https://www.npmjs.com/package/absurd-sdk) task.
- Each **step** is a checkpoint within that task.

Those checkpoints are journaled to an **in-process Postgres**
([PGLite](https://www.npmjs.com/package/@electric-sql/pglite)) — no external
database, no services to run. Because every step is recorded, the engine always
knows exactly what already executed.

```
workflow.yaml
   │  parse  → spec
   │  compile → plan (the needs DAG, matrix expanded, conditions resolved)
   ▼
durable task graph  ──run──▶  Gondolin micro-VMs (one per job)
   │
   └─ journaled to PGLite (in-process Postgres)
```

Compilation also **inlines reusable workflows**: a job that calls another workflow
with `uses: workflow/<name>` has the callee's jobs spliced into this same flat
graph, so the scheduler, the durable runtime, and `work graph` treat a composed
pipeline exactly like a hand-written one — no special runtime path. See
[Reusable workflows](../guide/reusable-workflows).

## Scheduling

The `needs` DAG drives **parallel scheduling**: a job becomes runnable the moment
its dependencies have succeeded, and independent jobs run concurrently up to the
engine's worker concurrency. A matrix job expands into one independent leg per
cell, and a downstream `needs` on it waits for every leg.

## Isolation

Every job runs in its own [Gondolin](https://www.npmjs.com/package/@earendil-works/gondolin)
micro-VM. There is no host-execution mode — your steps never run directly on your
machine. Network access is **mediated**: a job only reaches what the engine
allowlists for it. Each VM is sized per job via
[`machine:`](../reference/workflow-syntax#machine-types) — a named type or custom
cpu/memory — defaulting to `medium`.

Each job is checked out fresh, with `.git/` and `node_modules/` excluded, so jobs
are hermetic and install their own dependencies.

## Agent steps

When a step is the built-in [`work/agent`](./agent-steps) primitive — or a
composite [`action/<name>`](./actions) that wraps it — the engine invokes a
[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent
**inside that same micro-VM**, with its toolset rooted at the checkout. The host
allowlists the model endpoint through the sandbox's egress and injects the API key,
so the agent can reach the model while the key never enters the guest. A
`uses: action/<name>` step runs your own [JavaScript action](./actions) the same
way — staged into the guest and run there, never on the host. See
[Agent steps](./agent-steps) and [Actions](./actions) for the authoring side.

## The pieces

| Component | Role |
|---|---|
| [Absurd](https://www.npmjs.com/package/absurd-sdk) | Durable task execution — jobs are tasks, steps are checkpoints. |
| [PGLite](https://www.npmjs.com/package/@electric-sql/pglite) | In-process Postgres the journal is written to. No external DB. |
| [Gondolin](https://www.npmjs.com/package/@earendil-works/gondolin) | The micro-VM every job runs in, with mediated egress. |
| [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | The coding agent behind `uses: work/agent` steps. |

::: tip Deeper dives
The repository's [`docs/`](https://github.com/nullbytelabs/pi-workflows/tree/main/docs)
folder holds internal design and research notes on these subsystems — the durable
execution model, the sandbox, the agent interface, and more.
:::
