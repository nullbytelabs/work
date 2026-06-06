# Reusable workflows

A workflow can call **another whole workflow** as a job — so a shared `lint` or
`build` sequence lives in one file and `staging`, `ci`, and `release` reference it
instead of copy-pasting. It's the same idea as `needs:` wiring jobs together, one
level up: now you wire *workflows* together.

This is the **job-level `uses:`** surface. Don't confuse it with the
[step-level `uses:`](./agent-steps) that runs an AI agent:

| `uses:` on a… | pulls in… | for |
|---|---|---|
| **step** | an AI agent | [Agent steps](./agent-steps) (`uses: agent/<name>`) |
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
    runs-on: gondolin
    steps:
      - run: echo "shipping version=${{ needs.build.outputs.version }}"
```

```yaml
# .workflows/lint.yaml — a callee with no inputs/outputs
name: lint
on: workflow_call                  # opt in to being called
jobs:
  check:
    runs-on: gondolin
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
    runs-on: gondolin
    steps:
      - id: meta
        run: echo "version=1.0.0" >> "$WORK_OUTPUT"
    outputs:
      version: ${{ steps.meta.outputs.version }}
```

Run it like any workflow — `work run staging`. The two callees are inlined into a
single flat DAG over one checkout, so `work graph staging` renders the whole thing
end to end and the run behaves exactly as if you'd written it as one file.

## Calling a workflow

A caller job sets `uses:` and has **no `steps:` of its own** — it delegates the
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

A workflow is callable only if it opts in with `on: workflow_call` — being
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

The caller reads them through `needs`, exactly like a normal job's outputs — the
call's id (`build`) acts as the node that carries them:

```yaml
report:
  needs: [build]
  steps:
    - run: echo "${{ needs.build.outputs.version }}"
```

## `with:` is compile-time only

The one rule that trips people up: a caller's `with:` may reference only
**compile-time** contexts — `inputs`, `matrix`, and `event`. It **cannot**
reference `needs.*` or `steps.*` (a value that only exists once a run is underway):

```yaml
deploy:
  needs: [build]
  uses: workflow/deploy
  with:
    env: ${{ inputs.target }}                       # ✅ compile-time input
    # version: ${{ needs.build.outputs.version }}   # ❌ runtime value — rejected at compile
```

Inputs are bound when the workflow compiles (it's how they drive matrix fan-out,
`if:`, and interpolation), so a runtime value can't fill one. The compiler rejects
it with a clear error rather than silently miscompiling.

Runtime **data** still flows — through `needs`, not `with:`. Because a callee's
entry jobs inherit the caller job's `needs:`, they can read
<code v-pre>${{ needs.build.outputs.version }}</code> at run time like any other job. The split:
pass **config** (which env, which target — known up front) through `with:`; pass
**data** (a built version — produced during the run) through `needs`.

::: tip Same idea as GitHub Actions
This mirrors GitHub's reusable workflows, with one deliberate difference: GitHub
evaluates a caller's `with:` at run time (so it allows `needs.*`), whereas
pi-workflows binds inputs at compile time. Hence the rule above. Everything else —
the caller-job shape, `on: workflow_call`, explicit outputs — lines up.
:::

## How it runs

Callees are **inlined** at compile time: each one's jobs are spliced into the
caller's flat DAG (namespaced so ids never collide), plus a small virtual node per
call that carries the declared outputs and does no work (it boots no VM). The
runtime, durability, parallelism, the TUI board, and `work graph` all operate on
that one flattened DAG — reusable workflows need no special handling at run time.

All inlined jobs share the caller's checkout (they're one logical pipeline), and
nesting is capped at **10 levels**; a cycle (`a` → `b` → `a`) or an over-deep
chain is a compile error naming the chain.

::: info Not yet
Reusable workflows run via the **CLI** (`work run`, `work graph`). The
[web console](./web-ui) returns a clear "not yet" error for a `uses:` job.
Cross-repo references (a remote `workflow@repo`) are reserved but not implemented.
:::

::: tip Runnable example
See [`test/e2e/reusable-basic`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/reusable-basic)
for the full `staging` / `lint` / `build` trio used above.
:::
