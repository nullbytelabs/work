# Writing a workflow

A workflow is a YAML file describing a set of **jobs**, each a list of ordered
**steps**. The surface is small. This page walks through every building block; for
the exhaustive field list, see the
[Workflow syntax reference](../reference/workflow-syntax).

Here's a workflow that uses most of the surface at once:

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

## Jobs and steps

`jobs:` is a map of named jobs. Each job has ordered `steps:`. A step is either:

- a **`run:`** command — a shell command or multi-line script, or
- a **`uses:`** step — an [AI agent](./agent-steps).

A step takes a `run` **or** a `uses`, never both.

```yaml
jobs:
  build:
    runs-on: gondolin
    steps:
      - name: install        # optional human-readable label
        run: npm install
      - run: npm test        # name defaults to the command
```

## `runs-on`

`runs-on` selects where a job executes. Today there's exactly one target —
`gondolin`, a micro-VM — which is also the default. State it explicitly per job
for clarity:

```yaml
jobs:
  build:
    runs-on: gondolin
    steps:
      - run: npm test
```

::: info Per-job only
`runs-on` belongs on an individual job, not at the workflow level. The engine
warns if you omit it (and applies `gondolin`); it errors if you put it at the
top level or directly under `jobs:`.
:::

## `needs` — ordering and parallelism

`needs` declares the dependencies between jobs. A job waits for everything it
needs to succeed; independent jobs run **in parallel**.

```yaml
jobs:
  lint:
    runs-on: gondolin
    steps: [{ run: npm run lint }]
  test:
    runs-on: gondolin
    steps: [{ run: npm test }]
  ship:
    needs: [lint, test]    # waits for both; lint and test run concurrently
    runs-on: gondolin
    steps: [{ run: echo "shipping" }]
```

This `needs` graph is what drives the scheduler — and what `work graph` renders.

## `env`

Environment variables can be declared at three levels — **workflow**, **job**, and
**step**. Inner scopes override outer ones. Values are always strings.

```yaml
env:
  STAGE: workflow           # all jobs/steps see STAGE=workflow
jobs:
  build:
    runs-on: gondolin
    env:
      STAGE: job            # overrides the workflow value for this job
    steps:
      - env:
          STAGE: step        # overrides again, just for this step
        run: echo "$STAGE"   # prints: step
```

## Inputs

`inputs:` declares typed parameters, passed at run time and read via the
`inputs.<name>` expression context. Each input has a `type` (`string`, `number`, or
`boolean`) and may set `required`, `default`, `description`, `options` (an
allow-list), and `pattern` (a regex the value must match).

```yaml
name: greet
inputs:
  name:
    type: string
    required: true
  excited:
    type: boolean
    default: false
jobs:
  hello:
    runs-on: gondolin
    steps:
      - run: echo "hello ${{ inputs.name }}"
```

Provide values at run time as a JSON object:

```bash
work greet.yaml --inputs '{"name":"ada","excited":true}'
```

::: tip Shorthand
`name:` (a null value) is shorthand for an optional string input. A scalar —
`age: 36` — is shorthand for a typed input with that default. See the
[reference](../reference/workflow-syntax#inputs) for the full shape and validation
rules.
:::

## Outputs

A step exposes data by writing `key=value` lines to the file at `$PI_OUTPUT`. A
job re-exposes selected step outputs via its own `outputs:` block. Downstream jobs
read them through `needs`:

```yaml
jobs:
  build:
    runs-on: gondolin
    steps:
      - id: meta
        run: echo "version=1.4.2" >> "$PI_OUTPUT"
    outputs:
      version: ${{ steps.meta.outputs.version }}
  report:
    needs: [build]
    runs-on: gondolin
    steps:
      - run: echo "built ${{ needs.build.outputs.version }}"
```

Within the same job, a later step can read an earlier step's output directly via
the `steps.<id>.outputs.<key>` context. Across jobs, go through
`needs.<job>.outputs.<key>`.

## Matrix

`strategy.matrix:` fans a job out into one independent leg per combination of axis
values (the cartesian product). Read the current cell with the `matrix.<axis>`
context. `include` appends or extends cells; `exclude` prunes them.

```yaml
jobs:
  test:
    runs-on: gondolin
    strategy:
      matrix:
        node: [20, 22, 24]
        os: [linux, mac]
        exclude:
          - { node: 20, os: mac }                  # skip this cell
        include:
          - { node: 24, os: linux, experimental: true }  # tag a cell
    steps:
      - run: echo "node=${{ matrix.node }} os=${{ matrix.os }}"
```

Each leg is its own job — so a downstream `needs: [test]` waits for **every** leg.
All legs run in parallel, up to the engine's worker concurrency.

## Conditionals

`if:` (or its synonym `when:`) guards a step or a job. A false result skips it.
Conditions can reference `inputs.*`, `matrix.*`, `needs.*`, and `steps.*`, combine
them with `==`, `!=`, `&&`, `||`, `!`, and use the status functions `success()`,
`failure()`, `always()`, and `cancelled()`.

```yaml
jobs:
  deploy:
    runs-on: gondolin
    if: ${{ inputs.env == "prod" }}
    steps:
      - run: echo "deploying to prod"
      - if: ${{ failure() }}
        run: echo "a previous step failed"
```

Use `if` or `when`, but not both on the same step/job.

::: tip Worked examples
Every block above has a runnable example under
[`test/e2e/`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e) —
matrix builds, fan-out/fan-in, conditional steps, typed inputs, and more.
:::
