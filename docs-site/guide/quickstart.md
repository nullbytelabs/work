# Quickstart

This page takes you from an empty directory to a workflow running inside a
micro-VM. It assumes you've met the [Requirements](./requirements) and
[installed](./installation) `work`.

## Scaffold or hand-write

The fastest start is to let `work` scaffold a project for you:

```bash
work init                 # writes .workflows/hello-world.yaml + a starter config
work run hello-world      # run the scaffolded workflow by its name
```

`work create <name>` scaffolds an additional workflow any time, and
`work create <name> --template agent-action` scaffolds a full [agent
step](./agent-steps). Both validate the generated YAML before writing and never
clobber existing files.

The rest of this page hand-writes the YAML so you can see the moving parts.

## Your first workflow

A workflow is a YAML file: a set of **jobs**, each a list of ordered **steps**.
Create one:

```bash
cat > hello.yaml <<'EOF'
name: hello
jobs:
  greet:
    runs-on: gondolin
    steps:
      - run: echo "hello from the sandbox"
EOF
```

Run it:

```bash
work hello.yaml
```

The `greet` job boots a micro-VM, runs the `echo` inside it, and reports success.

## What you'll see

The output adapts to where it runs:

- **On an interactive terminal**, you get a live, dependency-aware status board
  that updates as jobs start, stream output, and finish.
- **In a pipe or non-interactive runner**, it prints buffered per-job output and
  exits **non-zero** on failure — so it drops into a script or scheduler cleanly.

Pass [`--quiet`](../reference/cli#flags) to suppress the board entirely.

## Multiple jobs with dependencies

Real workflows have more than one job. Use `needs` to order them; jobs without a
dependency between them run **in parallel**:

```yaml
name: build-and-report
jobs:
  build:
    runs-on: gondolin
    steps:
      - run: echo "building…"
  test:
    runs-on: gondolin
    steps:
      - run: echo "testing…"
  report:
    needs: [build, test]   # waits for both
    runs-on: gondolin
    steps:
      - run: echo "all green — shipping"
```

Here `build` and `test` run at the same time, and `report` waits for both to
succeed.

## Inspect the graph

Before running, you can print the job DAG instead of executing it:

```bash
work graph build-and-report.yaml             # Mermaid (default)
work graph build-and-report.yaml --format ascii
work graph build-and-report.yaml --steps     # expand each job into its steps
```

Formats: `mermaid`, `dot`, `json`, `ascii`. See the [CLI reference](../reference/cli#work-graph).

## Explore the examples

The repo's [`test/e2e/`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e)
folder is a gallery of runnable examples — matrix builds, fan-out/fan-in,
conditionals, typed inputs, an agent project, and more. Clone the repo to run them
directly.

::: tip Next steps
- Learn the full YAML surface in [Writing a workflow](./writing-workflows).
- Organize a real project with the [`.workflows/` layout](./project-layout).
- Add an [AI agent step](./agent-steps).
:::
