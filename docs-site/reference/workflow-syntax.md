# Workflow syntax

The complete field reference for a workflow YAML file. For a guided tour with
examples, read [Writing a workflow](../guide/writing-workflows) first.

## Top level

```yaml
name: ci            # required — the workflow's name
on: …               # optional — parsed but not yet acted on
inputs: …           # optional — typed run-time parameters
env: …              # optional — base env for all jobs/steps
jobs: …             # required — the named jobs
```

| Key | Type | Notes |
|---|---|---|
| `name` | string | **Required.** The workflow's name; also how `work run <name>` resolves it. |
| `on` | any | Trigger declaration. **Parsed but not yet acted on** — triggers aren't implemented. |
| `inputs` | map | Declared run-time inputs (see [Inputs](#inputs)). |
| `env` | map<string,string> | Workflow-level environment, the base layer for every job and step. |
| `jobs` | map | **Required.** The named jobs (see [Jobs](#jobs)). |

## Jobs

`jobs:` is a map of job id → job definition.

```yaml
jobs:
  build:
    runs-on: gondolin
    needs: []
    if: ${{ inputs.run_build }}
    strategy: { matrix: … }
    env: { KEY: value }
    outputs: { version: ${{ steps.meta.outputs.version }} }
    steps: [ … ]
```

| Key | Type | Notes |
|---|---|---|
| `runs-on` | string | Where the job runs. Only `gondolin` is supported, and it's the default. Per-job only — not valid at the workflow level. `runsOn` is also accepted. |
| `needs` | string \| string[] | Job ids that must succeed first. Independent jobs run in parallel. |
| `if` / `when` | string | Conditional guard; a false result skips the job. Use one, not both. See [Conditionals](#conditionals). |
| `strategy.matrix` | map | Fan-out into one leg per cell (see [Matrix](#matrix)). |
| `env` | map<string,string> | Job-level env, layered over workflow env. |
| `outputs` | map<string,string> | Outputs exposed to dependents as `needs.<job>.outputs.<name>`; values are expressions. |
| `steps` | list | **Required.** The ordered steps (see [Steps](#steps)). |

## Steps

A step is either a `run` command or a `uses` agent — never both.

```yaml
steps:
  - name: install         # optional label
    id: step1             # optional — required to reference this step's outputs
    run: npm install      # a shell command/script…
    env: { KEY: value }   # step-level env
    if: ${{ success() }}  # optional guard
  - id: review
    uses: agent/summarize # …or an agent
    with: { topic: parsing }
```

| Key | Type | Notes |
|---|---|---|
| `name` | string | Human-readable label. Defaults to the `run` command if omitted. |
| `id` | string | Stable id. Required to read this step's outputs via `steps.<id>.outputs.*`. |
| `run` | string | Shell command or multi-line script. Mutually exclusive with `uses`. |
| `uses` | string | Agent reference, `agent/<name>`. Mutually exclusive with `run`. See [Agent steps](../guide/agent-steps). |
| `with` | map | Inputs for a `uses` step; bound to `{{ placeholder }}` markers in the agent's `task.md`. |
| `if` / `when` | string | Conditional guard; a false result skips the step. Use one, not both. |
| `env` | map<string,string> | Step-level env, layered over job and workflow env. |

### Step outputs

A `run` step writes outputs by appending `key=value` lines to the file at the
`$PI_OUTPUT` path:

```yaml
- id: meta
  run: echo "version=1.4.2" >> "$PI_OUTPUT"
```

Read them with `${{ steps.meta.outputs.version }}` (same job) or, after the job
re-exposes them via `outputs:`, with `${{ needs.<job>.outputs.version }}`
(downstream jobs).

## Inputs

`inputs:` declares typed parameters provided at run time via `--inputs '<json>'`
and read with `${{ inputs.<name> }}`.

```yaml
inputs:
  name:                 # shorthand: null value → optional string input
  age: 36               # shorthand: scalar → typed input with that default
  env:
    type: string
    required: true
    description: target environment
    options: [dev, staging, prod]
  retries:
    type: number
    default: 3
  id:
    type: string
    pattern: "^[0-9a-f-]{36}$"   # regex the value must match
```

| Field | Type | Notes |
|---|---|---|
| `type` | `string` \| `number` \| `boolean` | The scalar type. |
| `required` | boolean | If true, the run fails when the value is omitted. |
| `default` | string \| number \| boolean | Value used when none is provided. |
| `description` | string | Human-readable description. |
| `options` | array | Allow-list; a value not in this list is rejected. |
| `pattern` | string | Regex the (string) value must match (tested with `test`, so anchor as needed). |

**Shorthand:** `name:` (a null value) declares an optional string input; a bare
scalar (`age: 36`) declares a typed input with that default.

## Matrix

`strategy.matrix:` expands a job into the cartesian product of its axes — one
independent leg per cell.

```yaml
strategy:
  matrix:
    node: [20, 22, 24]      # an axis
    os: [linux, mac]        # another axis
    exclude:
      - { node: 20, os: mac }
    include:
      - { node: 24, os: linux, experimental: true }
```

| Key | Type | Notes |
|---|---|---|
| *axes* | map<string, scalar[]> | Each named key is an axis; legs are the full cartesian product. |
| `include` | list<map> | Appends cells, or extends matching cells with extra values. |
| `exclude` | list<map> | Removes cells matching the given partial. |

Read the current cell with `${{ matrix.<axis> }}`. A downstream `needs` on a matrix
job waits for **every** leg.

::: info Not yet
`max-parallel` and `fail-fast` are not implemented.
:::

## Conditionals

`if:` (or its synonym `when:`) guards a step or a job; a false result skips it.

**Available in expressions:**

- Contexts: `inputs.*`, `matrix.*`, `needs.*`, `steps.*`
- Operators: `==`, `!=`, `&&`, `||`, `!`
- Status functions: `success()`, `failure()`, `always()`, `cancelled()`

```yaml
if: ${{ inputs.env == "prod" && success() }}
```

::: warning
Use `if` **or** `when` on a given step/job, not both. The `github` expression
context is not available.
:::

## Expressions

`${{ … }}` interpolates values into env, `with`, `outputs`, and conditions. The
available contexts are `inputs`, `matrix`, `needs`, and `steps` (as listed above).
There is no `github` context.
