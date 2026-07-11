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
    runs-on: work:base            # where the job runs (default: work:base)
    machine: large               # how big the VM is (default: medium)
    steps:
      - name: install
        run: npm install
      - id: meta                 # give a step an id to expose outputs
        name: record version
        run: echo "version=$(node -p 'require("./package.json").version')" >> "$WORK_OUTPUT"
    outputs:
      version: ${{ steps.meta.outputs.version }}   # re-expose the step output at the job level

  report:
    needs: [build]               # runs after build succeeds
    runs-on: work:base
    steps:
      - name: show
        env:
          V: ${{ needs.build.outputs.version }}
        run: echo "built version $V"
```

## Jobs and steps

`jobs:` is a map of named jobs. Each job has ordered `steps:`. A step is either:

- a **`run:`** command (a shell command or multi-line script), or
- a **`uses:`** step — the built-in [`work/agent`](./agent-steps) AI agent, a
  [built-in action](./builtin-actions) (`work/checkout`, `work/install-node`), or
  a user-space [action](./actions) (`action/<name>`).

A step takes a `run` **or** a `uses`, never both.

```yaml
jobs:
  build:
    runs-on: work:base
    steps:
      - name: install        # optional human-readable label
        run: npm install
      - run: npm test        # name defaults to the command
```

A job can also skip `steps:` entirely and **call another workflow** with a
job-level `uses:` — see [Reusable workflows](./reusable-workflows).

## `runs-on`

Every job runs in a Gondolin micro-VM; `runs-on` selects which **guest image**
boots inside it:

- **`work:base`** — our capable base and **the default** if you omit `runs-on`. It
  adds **git** and **jq** on top of the stock guest (which ships `sh`/`bash`,
  `node`/`npm`, `python3`, `curl`, and `ca-certificates`), so a checkout or a `jq`
  filter just works.
- **`work:pi`** — `work:base` with a [Pi coding agent](./agent-steps) baked in. Use
  it for jobs with `uses: work/agent` steps so the agent starts immediately instead
  of installing Pi on each run.
- **`gondolin`** — the stock guest, with no git or jq. Pin it explicitly for a job
  that wants the leanest possible image and doesn't need the extra tools.

```yaml
jobs:
  build:
    runs-on: work:base
    steps:
      - run: git --version && npm test
```

`work:base` (and any custom image) is **built on first use** on each machine, then
reused, so the first run that needs it takes a few minutes; later runs boot
instantly. You can also define your own images with whatever toolchain your jobs
need — see [Custom images](./custom-images).

::: info Per-job only
`runs-on` belongs on an individual job, not at the workflow level. The engine
warns if you omit it (and applies the default `work:base`); it errors if you put it
at the top level or directly under `jobs:`.
:::

## `machine` — sizing the VM

`machine` sets how big a job's micro-VM is: its vCPU count and RAM. Pick a
**named type** from the built-in catalog, or specify dimensions **inline**.
Omitting `machine:` uses `medium`.

```yaml
jobs:
  lint:
    machine: small               # a named type — light job
    steps: [{ run: npm run lint }]
  build:
    machine:                     # custom — the unset dimension inherits medium
      cpus: 8
      memory: 16G
    steps: [{ run: npm run build }]
```

The catalog: `small` (2 vCPU / 2G), `medium` (2 / 8G, the default), `large`
(4 / 12G), `xlarge` (8 / 24G). A custom spec may set `cpus`, `memory`, or both;
whatever you leave out is taken from `medium`. See the
[reference](../reference/workflow-syntax#machine-types) for the full table.

::: info Disk size isn't configurable yet
`machine` sizes CPU and memory only. The guest image can't grow its root
filesystem at boot, so disk size waits on a future custom image.
:::

## `needs` — ordering and parallelism

`needs` declares the dependencies between jobs. A job waits for everything it
needs to succeed; independent jobs run **in parallel**.

```yaml
jobs:
  lint:
    runs-on: work:base
    steps: [{ run: npm run lint }]
  test:
    runs-on: work:base
    steps: [{ run: npm test }]
  ship:
    needs: [lint, test]    # waits for both; lint and test run concurrently
    runs-on: work:base
    steps: [{ run: echo "shipping" }]
```

This `needs` graph is what drives the scheduler, and what `work graph` renders.

## `env`

Environment variables can be declared at three levels: **workflow**, **job**, and
**step**. Inner scopes override outer ones. Values are always strings.

```yaml
env:
  STAGE: workflow           # all jobs/steps see STAGE=workflow
jobs:
  build:
    runs-on: work:base
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
    runs-on: work:base
    steps:
      - run: echo "hello ${{ inputs.name }}"
```

Provide values at run time as a JSON object:

```bash
work greet.yaml --inputs '{"name":"ada","excited":true}'
```

::: tip Shorthand
`name:` (a null value) is shorthand for an optional string input. A scalar
(`age: 36`) is shorthand for a typed input with that default. See the
[reference](../reference/workflow-syntax#inputs) for the full shape and validation
rules.
:::

## Outputs

A step exposes data by writing `key=value` lines to the file at `$WORK_OUTPUT`. A
job re-exposes selected step outputs via its own `outputs:` block. Downstream jobs
read them through `needs`:

```yaml
jobs:
  build:
    runs-on: work:base
    steps:
      - id: meta
        run: echo "version=1.4.2" >> "$WORK_OUTPUT"
    outputs:
      version: ${{ steps.meta.outputs.version }}
  report:
    needs: [build]
    runs-on: work:base
    steps:
      - run: echo "built ${{ needs.build.outputs.version }}"
```

Within the same job, a later step can read an earlier step's output directly via
the `steps.<id>.outputs.<key>` context. Across jobs, go through
`needs.<job>.outputs.<key>`.

### Forwarding a command's output

`$WORK_OUTPUT` is for values you choose to expose. To forward a command's **raw
output** you don't need to capture it by hand. Every step with an `id` already
exposes what the engine captured:

| Accessor | Value |
|---|---|
| <code v-pre>${{ steps.&lt;id&gt;.logs }}</code> | The step's combined stdout+stderr. |
| <code v-pre>${{ steps.&lt;id&gt;.outcome }}</code> | `success`, `failure`, or `skipped`. |
| <code v-pre>${{ steps.&lt;id&gt;.exitCode }}</code> | The command's exit code. |

So a job can hand a tool's full output to a downstream consumer with a plain
one-line step:

```yaml
jobs:
  lint:
    runs-on: work:base
    steps:
      - id: lint
        run: npm run lint            # no capture wrapper
    outputs:
      log: ${{ steps.lint.logs }}    # forward the captured output
```

`.outcome` mirrors GitHub Actions; `.logs` is this engine's addition (GitHub
withholds step stdout from expressions). See the
[step context reference](../reference/workflow-syntax#step-context).

## Matrix

`strategy.matrix:` fans a job out into one independent leg per combination of axis
values (the cartesian product). Read the current cell with the `matrix.<axis>`
context. `include` appends or extends cells; `exclude` prunes them.

```yaml
jobs:
  test:
    runs-on: work:base
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

Each leg is its own job, so a downstream `needs: [test]` waits for **every** leg.
All legs run in parallel, up to the engine's worker concurrency.

## Conditionals

`if:` (or its synonym `when:`) guards a step or a job. A false result skips it.
Conditions can reference `inputs.*`, `matrix.*`, `needs.*`, `steps.*`, and
`event.*`, combine them with `==`, `!=`, `&&`, `||`, `!`, and use the status
functions `success()`, `failure()`, `always()`, and `cancelled()`.

```yaml
jobs:
  deploy:
    runs-on: work:base
    if: ${{ inputs.env == "prod" }}
    steps:
      - run: echo "deploying to prod"
      - if: ${{ failure() }}
        run: echo "a previous step failed"
```

Use `if` or `when`, but not both on the same step/job.

## Tolerating a step failure — `continue-on-error`

By default a step that exits non-zero fails its job and skips the remaining
steps. Mark a step `continue-on-error: true` and a non-zero exit no longer gates
the job; the run continues and the job can still succeed. The step's real
outcome is still recorded (it reads `failure` via <code v-pre>${{ steps.&lt;id&gt;.outcome }}</code>),
and its `$WORK_OUTPUT` and <code v-pre>${{ steps.&lt;id&gt;.logs }}</code> are captured either way, so a
later step or a downstream job can inspect what happened.

```yaml
steps:
  - id: audit
    continue-on-error: true
    run: npm audit              # may exit non-zero; we don't want to fail the job
  - run: echo "audit said: ${{ steps.audit.outcome }}"
```

This is GitHub Actions semantics. It's how the project's own `checks` pipeline
runs each tool without one red tool masking the others — see
[Dogfooding](../examples/dogfooding).

::: tip Worked examples
Every block above has a runnable example under
[`test/e2e/`](https://github.com/nullbytelabs/work/tree/main/test/e2e) —
matrix builds, fan-out/fan-in, conditional steps, typed inputs, and more.
:::
