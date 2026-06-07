# Workflow syntax

The complete field reference for a workflow YAML file. For a guided tour with
examples, read [Writing a workflow](../guide/writing-workflows) first.

## Top level

```yaml
name: report        # required — the workflow's name
on: …               # optional — triggers (e.g. webhook)
inputs: …           # optional — typed run-time parameters
env: …              # optional — base env for all jobs/steps
jobs: …             # required — the named jobs
```

| Key | Type | Notes |
|---|---|---|
| `name` | string | **Required.** The workflow's name; also how `work run <name>` resolves it. |
| `on` | string \| map | Trigger declaration (see [Triggers](#triggers)): `webhook` (remote POST) and/or `workflow_call` (make this workflow [reusable](#reusable-workflows)). |
| `inputs` | map | Declared run-time inputs (see [Inputs](#inputs)). |
| `env` | `map<string,string>` | Workflow-level environment, the base layer for every job and step. |
| `jobs` | map | **Required.** The named jobs (see [Jobs](#jobs)). |

## Triggers

`on:` declares how a workflow may be invoked besides a direct `work run`. Two
triggers are supported: `webhook` (below) opts in to remote, authenticated `POST`
triggering by the [web console's](../guide/web-ui#webhook-triggers) receiver, and
`workflow_call` opts in to being called by another workflow (see
[Reusable workflows](#reusable-workflows)). Both can appear together.

```yaml
on: webhook                  # string shorthand — opt in, no options
```

```yaml
on:
  webhook:
    secret: alertmanager     # names webhooks.<name> in your config (a reference, never a literal secret)
    source: alertmanager     # free-form hint of the expected sender shape
```

| Form | Meaning |
|---|---|
| `on: webhook` | Opt in with no options. |
| `on: { webhook: true }` / `{ webhook: false }` | Explicit opt-in / opt-out. |
| `on: { webhook: { secret, source } }` | Opt in and name the config hook / sender hint. |

| Field | Type | Notes |
|---|---|---|
| `secret` | string | Names a `webhooks.<name>` config entry holding the hook's auth secret. A **reference**, never a literal secret. |
| `source` | string | Free-form hint of the expected sender (e.g. `alertmanager`, `grafana`). |

`on:` is the opt-in **gate**: a workflow with no `webhook` trigger can never be
started by a `POST`, regardless of config. The trigger is validated but otherwise
inert to the engine — the [webhook receiver](../guide/web-ui#webhook-triggers)
reads it, and the matching `webhooks.<name>` entry in
[config](./configuration#webhooks) supplies the secret and auth scheme. A
webhook-triggered run reads the request body via the [`event` context](#expressions).

## Jobs

`jobs:` is a map of job id → job definition. A job runs **either** its own
`steps:` **or** a `uses:` call to a reusable workflow — never both.

```yaml
jobs:
  build:
    runs-on: gondolin
    machine: large
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
| `machine` | string \| map | Micro-VM sizing. A named type from the catalog, or an inline `{ cpus, memory }`. See [Machine types](#machine-types). Defaults to `medium`. |
| `needs` | string \| string[] | Job ids that must succeed first. Independent jobs run in parallel. |
| `if` / `when` | string | Conditional guard; a false result skips the job. Use one, not both. See [Conditionals](#conditionals). |
| `strategy.matrix` | map | Fan-out into one leg per cell (see [Matrix](#matrix)). |
| `env` | `map<string,string>` | Job-level env, layered over workflow env. |
| `outputs` | `map<string,string>` | Outputs exposed to dependents as `needs.<job>.outputs.<name>`; values are expressions. |
| `steps` | list | The ordered steps (see [Steps](#steps)). Required **unless** the job is a `uses:` call. |
| `uses` | string | Call a [reusable workflow](#reusable-workflows) (`workflow/<name>` or a `./path.yaml`). Mutually exclusive with `steps`. |
| `with` | map | Inputs for a `uses:` job, validated against the callee's `inputs:`. Compile-time values only — see [Reusable workflows](#reusable-workflows). |

## Machine types

Each job runs in its own gondolin micro-VM. `machine:` sizes that VM — its vCPU
count and RAM. Pick a **named type** from the built-in catalog, or specify
dimensions **inline**. Omitting `machine:` uses `medium`.

```yaml
jobs:
  lint:
    machine: small          # a named type
    steps: [ … ]
  build:
    machine:                # custom — the unset dimension inherits from the default
      cpus: 8
      memory: 16G
    steps: [ … ]
```

Built-in catalog:

| Name | vCPU | Memory |
|---|---|---|
| `small` | 2 | 2G |
| `medium` *(default)* | 2 | 8G |
| `large` | 4 | 12G |
| `xlarge` | 8 | 24G |

`memory` is a size: a positive integer with an optional `K`/`M`/`G`/`T` suffix
(e.g. `16G`). A custom spec may set either `cpus` or `memory`; whatever you leave
out is taken from `medium`.

> Disk size is not yet configurable — the gondolin guest image lacks the tooling
> (`resize2fs`) to grow the root filesystem at boot, so jobs use the image's
> default disk. It's planned once a custom guest image ships.

## Steps

A step is either a `run` command or a `uses:` reference — never both. A step
`uses:` resolves to an agent, the built-in `work/agent` primitive, or a
user-space action (see [Step `uses:` forms](#step-uses-forms)).

```yaml
steps:
  - name: install         # optional label
    id: step1             # optional — required to reference this step's outputs
    run: npm install      # a shell command/script…
    env: { KEY: value }   # step-level env
    if: ${{ success() }}  # optional guard
  - id: review
    uses: work/agent      # …or an agent / action
    with: { prompt: "Summarize the diff." }
```

| Key | Type | Notes |
|---|---|---|
| `name` | string | Human-readable label. Defaults to the `run` command if omitted. |
| `id` | string | Stable id. Required to read this step's outputs via `steps.<id>.outputs.*`. |
| `run` | string | Shell command or multi-line script. Mutually exclusive with `uses`. |
| `uses` | string | A step reference: `agent/<name>`, `work/agent`, or `action/<name>`. Mutually exclusive with `run`. See [Step `uses:` forms](#step-uses-forms). |
| `with` | map | Inputs for a `uses` step. Meaning depends on the form — see [Step `uses:` forms](#step-uses-forms). |
| `if` / `when` | string | Conditional guard; a false result skips the step. Use one, not both. |
| `env` | `map<string,string>` | Step-level env, layered over job and workflow env. |

### Step outputs

A `run` step writes outputs by appending `key=value` lines to the file at the
`$WORK_OUTPUT` path:

```yaml
- id: meta
  run: echo "version=1.4.2" >> "$WORK_OUTPUT"
```

Read them inside an expression — `steps.meta.outputs.version` (same job) or, after
the job re-exposes them via `outputs:`, `needs.<job>.outputs.version` (downstream
jobs).

A `uses:` step also produces outputs (an agent's final message, an action's
declared outputs); read them the same way. See below.

### Step `uses:` forms

A step `uses:` is one of the forms below. All run **in-guest** and feed `with:` /
produce `steps.<id>.outputs.*`; the guide is [Actions & `work/agent`](../guide/actions)
and [Agent steps](../guide/agent-steps).

| `uses:` | What it is | `with:` | Outputs |
|---|---|---|---|
| `work/agent` | Built-in agent primitive (no package). | `instructions`/`instructionsFile`, `prompt`/`promptFile` (one required), `model`. | single `output` (final message) |
| `action/<name>` | A user-space action at `.workflows/actions/<name>/` — JavaScript or composite. | inputs validated against the action's `action.yaml` `inputs:`. | the action's declared `outputs:` |
| `work/checkout`, `work/install-node` | Built-in actions shipped with the engine. | per action (e.g. `repo`, `version`). | per action |

#### Action manifest (`action.yaml`)

An action declares typed inputs/outputs and how it runs. **`node`** runs an entry
script; **`composite`** runs a step bundle (each step a `run:` or a `uses:`):

```yaml
name: greet
inputs:                       # the workflow inputs: grammar (type/default/required/options/pattern)
  name: { type: string, default: world }
outputs:
  greeting: { description: the greeting line }
runs:
  using: node                 # node | composite
  main: index.mjs             # node: entry script (default: index.mjs)
```

A `node` action reads inputs from `INPUT_<NAME>` env vars and writes outputs to
`$WORK_OUTPUT` (the same ABI as a `run:` step); if the action dir has a
`package.json`, its deps are `npm install`ed in-guest first. A `composite` action
lists `runs.steps:` and maps each declared output to a `value:` expression
(e.g. <code v-pre>value: ${{ steps.run.outputs.output }}</code>).

## Reusable workflows

A job may call **another whole workflow** instead of defining steps — the
job-level `uses:` surface. For a guided walkthrough, see
[Reusable workflows](../guide/reusable-workflows); this is the field reference.

### Caller job (`uses:`)

```yaml
jobs:
  build:
    needs: [lint]
    uses: workflow/build          # or a relative path: ./build.yaml
    with:
      target: staging             # validated against the callee's inputs:
```

| Reference form | Resolves to |
|---|---|
| `workflow/<name>` | the `.workflows/*.yaml` whose `name:` matches (like `work run <name>`). **Recommended.** |
| `./path.yaml`, `../x/y.yaml` | a file relative to the **calling workflow's** directory. |

Allowed keys on a `uses:` job: `uses` (required), `with`, `needs`, `if`/`when`,
`strategy.matrix` (fans the whole call out per cell). **Not** allowed: `steps`,
`runs-on`/`machine`, `env`, `outputs` — sizing belongs to the callee's jobs, env
is per-workflow, and outputs come from the callee.

::: warning `with:` is compile-time only
A caller's `with:` may reference only **compile-time** contexts — `inputs`,
`matrix`, `event`. Referencing `needs.*` or `steps.*` (a runtime value) is a
compile error. Pass runtime **data** through `needs` instead: a callee's entry
jobs inherit the caller job's `needs:`, so they read `needs.<job>.outputs.*` at
run time like any job.
:::

### Callee opt-in (`on: workflow_call`)

A workflow is callable only if it opts in. Inputs reuse the workflow's existing
[`inputs:`](#inputs) block; outputs are declared by mapping job outputs.

```yaml
on: workflow_call               # shorthand — callable, exposes no outputs
```

```yaml
on:
  workflow_call:
    outputs:
      version: ${{ jobs.compile.outputs.version }}   # curate the exposed surface
```

| Form | Meaning |
|---|---|
| `on: workflow_call` | Opt in; expose no outputs. |
| `on: { workflow_call: { outputs } }` | Opt in and map job outputs to workflow outputs. |

The caller reads a callee's outputs through `needs.<callerJob>.outputs.<name>`,
exactly like a normal job's outputs. Callees are inlined into the caller's flat
DAG at compile time (one checkout, rendered whole by `work graph`); nesting is
capped at 10 levels and cycles are a compile error.

::: info CLI only (for now)
Reusable workflows run via `work run` / `work graph`. The
[web console](../guide/web-ui) rejects a `uses:` job with a clear error, and
cross-repo references are reserved but not implemented.
:::

## Inputs

`inputs:` declares typed parameters provided at run time via `--inputs '<json>'`
and read with the `inputs.<name>` expression context.

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
| *axes* | `map<string, scalar[]>` | Each named key is an axis; legs are the full cartesian product. |
| `include` | `list<map>` | Appends cells, or extends matching cells with extra values. |
| `exclude` | `list<map>` | Removes cells matching the given partial. |

Read the current cell with the `matrix.<axis>` context. A downstream `needs` on a
matrix job waits for **every** leg.

## Conditionals

`if:` (or its synonym `when:`) guards a step or a job; a false result skips it.

**Available in expressions:**

- Contexts: `inputs.*`, `matrix.*`, `needs.*`, `steps.*`, and — for a
  [webhook-triggered](#triggers) run — `event.*`
- Operators: `==`, `!=`, `&&`, `||`, `!`
- Status functions: `success()`, `failure()`, `always()`, `cancelled()`

```yaml
if: ${{ inputs.env == "prod" && success() }}
if: ${{ event.alerts[0].labels.severity == "critical" }}
```

::: warning
Use `if` **or** `when` on a given step/job, not both.
:::

## Expressions

<code v-pre>${{ … }}</code> interpolates values into env, `with`, `outputs`, and
conditions. The available contexts are `inputs`, `matrix`, `needs`, and `steps`
(as listed above) — plus `event` on a [webhook-triggered](#triggers) run.

### `event` (webhook runs)

When a run is started by the [webhook receiver](../guide/web-ui#webhook-triggers),
the parsed POST body is exposed as `event`. It supports **nested paths and array
indexing**, in both interpolation and `if:` conditions:

```yaml
on: webhook
jobs:
  triage:
    if: ${{ event.commonLabels.severity == "critical" }}
    steps:
      - run: echo "first alert: ${{ event.alerts[0].labels.alertname }}"
```

`event` is absent on a normal `work run`; reference it only from a webhook-triggered
workflow.
