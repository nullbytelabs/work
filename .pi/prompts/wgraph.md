---
description: Inspect a workflow's compiled DAG without running it
argument-hint: "<name|file> [mermaid|dot|json|ascii]"
---
Show the compiled DAG for `${1:?workflow name or file required}` without running it.

1. Use the `work_graph` tool for structured JSON when I want to reason about the plan
   (jobs, needs edges, steps, machine sizes). Otherwise run
   `./bin/work.mjs graph $1 --format ${2:-ascii} --steps` for a human view.
2. Summarize: the job DAG (needs edges / parallelism), each job's `runs-on` and
   `machine`, and the step list with `run:`/`uses:` per step.
3. Flag anything notable: missing model for `uses: work/agent` steps, a large
   `machine:` that'll be heavy, or jobs that won't parallelize due to `needs`.
This is the cheap pre-flight before a real `work run`.
