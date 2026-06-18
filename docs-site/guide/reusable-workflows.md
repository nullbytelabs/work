# Reusable workflows

A workflow can call **another whole workflow** as a job, so a shared `lint` or
`build` sequence lives in one file and `staging`, `ci`, and `release` reference it
instead of copy-pasting. It's the same idea as `needs:` wiring jobs together, one
level up: now you wire *workflows* together.

This is the **job-level `uses:`** surface. Don't confuse it with the
[step-level `uses:`](./agent-steps) that runs an AI agent or an action:

| `uses:` on a… | pulls in… | for |
|---|---|---|
| **step** | an AI agent or action | [Agent steps](./agent-steps) (`uses: work/agent`) / [Actions](./actions) (`uses: action/<name>`) |
| **job** | an entire workflow | **this page** (`uses: workflow/<name>`) |

The level tells you which kind you're looking at.

## A worked example

`staging` composes two smaller workflows — `lint` and `build` — then a normal
`report` job consumes the build's output:

```yaml
# .workflows/staging.yaml
name: staging
jobs:
  lint:
    uses: workflow/lint            # call the whole `lint` workflow

  build:
    needs: [lint]
    uses: workflow/build           # …then the whole `build` workflow

  report:
    needs: [build]
    runs-on: work:base
    steps:
      - run: echo "shipping version=${{ needs.build.outputs.version }}"
```

```yaml
# .workflows/lint.yaml — a callee with no inputs/outputs
name: lint
on: workflow_call                  # opt in to being called
jobs:
  check:
    runs-on: work:base
    steps:
      - run: echo "lint: 0 problems"
```

```yaml
# .workflows/build.yaml — a callee that publishes an output
name: build
on:
  workflow_call:
    outputs:
      version: ${{ jobs.compile.outputs.version }}   # the surface exposed to a caller
jobs:
  compile:
    runs-on: work:base
    steps:
      - id: meta
        run: echo "version=1.0.0" >> "$WORK_OUTPUT"
    outputs:
      version: ${{ steps.meta.outputs.version }}
```

Run it like any workflow: `work run staging`. The two callees are inlined into a
single flat DAG over one checkout, so `work graph staging` renders the whole thing
end to end and the run behaves exactly as if you'd written it as one file.

## Calling a workflow

A caller job sets `uses:` and has **no `steps:` of its own**; it delegates the
entire called workflow.

```yaml
jobs:
  build:
    needs: [lint]                  # caller-side ordering, like any job
    uses: workflow/build           # the reference
    with:                          # inputs to the callee
      target: staging
```

Two reference forms:

| Form | Resolves to |
|---|---|
| `workflow/<name>` *(recommended)* | the `.workflows/*.yaml` whose `name:` matches — mirrors `work run <name>` |
| `./build.yaml`, `../x/y.yaml` | a file **relative to the calling workflow's directory** |

A `uses:` job accepts `with`, `needs`, `if`/`when`, and `strategy.matrix` (which
fans the *whole call* out, one invocation per cell). It does **not** take `steps`,
`runs-on`/`machine`, `env`, or `outputs` — sizing belongs to the callee's own
jobs, env stays per-workflow, and outputs come *from* the callee.

## Making a workflow callable

A workflow is callable only if it opts in with `on: workflow_call`: being
reusable is a deliberate, reviewable property, just like [`on: webhook`](../reference/workflow-syntax#triggers).

```yaml
on: workflow_call                  # string shorthand — callable, no outputs exposed
```

Inputs reuse the workflow's existing [`inputs:`](./writing-workflows#inputs)
block — the caller's `with:` is validated against it (types, `required`,
`options`, `pattern`) with no new machinery. To expose **outputs**, use the
mapping form and curate exactly what leaves the workflow:

```yaml
on:
  workflow_call:
    outputs:
      version: ${{ jobs.compile.outputs.version }}   # map a job output to a workflow output
```

Nothing leaves a reusable workflow unless you map it here.

## Reading a callee's outputs

The caller reads them through `needs`, exactly like a normal job's outputs. The
call's id (`build`) acts as the node that carries them:

```yaml
report:
  needs: [build]
  steps:
    - run: echo "${{ needs.build.outputs.version }}"
```

## Passing inputs, including runtime values

A caller's `with:` fills the callee's declared `inputs:`. The value can be a
compile-time one (`inputs`, `matrix`, `event`) **or** a runtime one — a
producer job's output via `needs.*`:

```yaml
deploy:
  needs: [build]
  uses: workflow/deploy
  with:
    env: ${{ inputs.target }}                     # compile-time input
    version: ${{ needs.build.outputs.version }}   # runtime value — resolves at run
```

The callee declares both inputs and references only <code v-pre>${{ inputs.env }}</code> /
<code v-pre>${{ inputs.version }}</code> — it never reaches into a caller's jobs, so it reads
cleanly and runs standalone (an unprovided input falls back to its default).

Under the hood a runtime value is **deferred**: the compiler leaves the
<code v-pre>${{ needs.* }}</code> expression intact, substitutes it into the callee's
<code v-pre>${{ inputs.version }}</code>, and it resolves at run time once the referenced
dependency has produced its output — so that dependency must be in the call's `needs:`.

Two rules keep it honest:

- a `needs.<job>` you reference in `with:` must be in that call's own `needs:`
  (otherwise the value can't resolve when the call runs);
- `steps.*` isn't allowed in `with:`, since a reusable call has no steps of its own.

The one thing that still *must* be compile-time is a value that drives the
**callee's own** `matrix` or `if:` (the callee is compiled before any job runs).

::: tip Same as GitHub Actions
This matches GitHub's reusable workflows: a caller's `with:` may reference
`needs.*`, and the value resolves at run time. The caller-job shape,
`on: workflow_call`, and explicit outputs line up too.
:::

## How it runs

Callees are **inlined by substitution** at compile time: the call is replaced by
the callee's actual jobs. A callee with a single job collapses onto the call's id
(`uses: workflow/checks` calling a one-job `checks.yaml` becomes one real job
`checks`); a multi-job callee is spliced in with namespaced ids (`<call>__<job>`)
so they never collide. A downstream `needs: [<call>]` attaches to the callee's
real leaf job(s), and `needs.<call>.outputs.*` resolves against the job that
produces it; there are no synthetic placeholder nodes. The runtime, the TUI board,
and `work graph` all operate on that one flattened DAG, with durability and
parallelism intact, so reusable workflows need no special handling at run time.

All inlined jobs share the caller's checkout (they're one logical pipeline), and
nesting is capped at **10 levels**; a cycle (`a` → `b` → `a`) or an over-deep
chain is a compile error naming the chain.

::: info Not yet
Reusable workflows run via the **CLI** (`work run`, `work graph`). The
[web console](./web-ui) returns a clear "not yet" error for a `uses:` job.
Cross-repo references (a remote `workflow@repo`) are reserved but not implemented.
:::

::: tip Runnable example
See [`test/e2e/reusable-basic`](https://github.com/nullbytelabs/work/tree/main/test/e2e/reusable-basic)
for the full `staging` / `lint` / `build` trio used above.
:::
