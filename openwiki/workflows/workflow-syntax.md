# Workflow Syntax

A workflow is a YAML file: a set of **jobs**, each a list of ordered **steps**. The syntax will feel familiar if you know GitHub Actions.

## Structure

```yaml
name: build-and-report

env:
  STAGE: nightly                 # workflow-wide env (jobs/steps can override)

on:
  webhook:                       # webhook trigger (auth in work.json)
    event: push
  schedule:
    - cron: "0 2 * * *"          # cron trigger (UTC, GHA-mirrored syntax)
  workflow_call:                 # callable by other workflows

inputs:
  region:
    type: string
    required: true
    pattern: "^us-"
  count:
    type: number
    default: 10

jobs:
  build:
    runs-on: work:base
    steps:
      - name: install
        run: npm install
      - id: meta
        name: record version
        run: echo "version=$(node -p 'require("./package.json").version')" >> "$WORK_OUTPUT"

  report:
    needs: [build]
    runs-on: work:base
    if: ${{ success() }}
    steps:
      - name: show
        env:
          V: ${{ needs.build.outputs.version }}
        run: echo "built version $V"
    outputs:
      version: ${{ steps.meta.outputs.version }}
```

## Building Blocks

| Feature | How |
|---|---|
| **Jobs & steps** | `jobs:` → named jobs, each with ordered `steps:`. A step is a `run:` command or a `uses:` agent/action. |
| **`runs-on`** | The micro-VM guest image: `work:base` (capable default — git/jq/curl/node), `gondolin` (stock guest), or any custom `work:<image>`. Every job runs in a micro-VM. |
| **`needs`** | `needs: [build]` — a job waits for its dependencies. Independent jobs run **in parallel**. |
| **`env`** | Declared at workflow, job, or step level; inner scopes override outer. |
| **Inputs** | `inputs:` declares typed params (`string`/`number`/`boolean`, with `required`/`default`/`options`/`pattern`). Pass at run time with `--inputs`, read via `${{ inputs.name }`. Types are strict — no coercion (a string `"36"` is rejected for a `number`). An optional input with no default gets a type-appropriate empty sentinel (`0`/`false`/`""`). |
| **Outputs** | A step writes `key=value` to `$WORK_OUTPUT`; a job re-exposes them via `outputs:`; downstream reads `${{ needs.<job>.outputs.<key> }}`. |
| **Matrix** | `strategy.matrix:` fans a job out into one run per combination, with `include`/`exclude`; read the cell via `${{ matrix.<axis> }}`. |
| **Conditionals** | `if:` (or `when:`) on a step or job — a false result skips it. Supports `inputs.*`, `matrix.*`, `needs.*`, `steps.*` (`.result`/`.outputs`/`.outcome`/`.exitCode`), `event.*` (incl. array indexing), `==`/`!=`/`&&`/`||`/`!`, and `success()`/`failure()`/`always()`/`cancelled()`. `secrets.*` is deliberately excluded from conditions to prevent leakage via skip patterns. |

## Expressions

`${{ ... }}` expressions are resolved in two phases (see [Architecture](../architecture/architecture.md)):

- **Compile-time** (baked into plan): `inputs.*`, `matrix.*`, `event.*`
- **Runtime** (resolved during execution): `needs.*`, `steps.*`, `secrets.*`

Unknown roots always error — never silently pass. Prototype-member names (`toString`, `constructor`, `__proto__`, …) read as missing rather than slipping through — input, `needs`, and `steps` lookups all use `Object.hasOwn`, so a key colliding with an `Object.prototype` member is treated as undeclared, not resolved to the inherited function. The expression parser and condition evaluator are hand-written (tokenizer + recursive-descent), no `eval`, no dependencies.

A downstream job **cannot** reference a matrix job's outputs or result by its base id — `needs.<matrixJob>.outputs.*` and `needs.<matrixJob>.result` are rejected at compile time (`assertNoMatrixBaseRefs` in `compile.ts`). A matrix job fans out into one leg per cell, so its outputs are ambiguous when keyed by the base id (the runtime keys the `needs` context by leg id, never the base). Reference a specific leg instead, or make the job non-matrix. This mirrors the same rule the reusable-workflow path applies to `workflow_call.outputs`.

### `$WORK_OUTPUT`

A step writes outputs by appending `key=value` lines to the file at `$WORK_OUTPUT` (GitHub Actions `$GITHUB_OUTPUT` semantics). Multi-line values use heredoc syntax:

```bash
echo "summary<<EOF" >> "$WORK_OUTPUT"
echo "multi-line content" >> "$WORK_OUTPUT"
echo "EOF" >> "$WORK_OUTPUT"
```

## Matrix Fan-Out

```yaml
jobs:
  test:
    runs-on: work:base
    strategy:
      matrix:
        os: [linux, macos]
        node: [20, 22]
        exclude:
          - os: macos
            node: 20
        include:
          - os: linux
            node: 24
    steps:
      - run: echo "testing on ${{ matrix.os }} with node ${{ matrix.node }}"
```

`expandMatrix()` (`src/compiler/matrix.ts`) computes the Cartesian product, then applies `exclude` (removes any cell matching all key/values of an exclude entry) and `include` (extends matching cells with extra keys without overwriting an axis value, or appends a standalone cell when it matches nothing). `exclude` runs before `include`. An axis-less matrix (only `include`) starts empty and is defined entirely by its `include` entries. Each cell becomes a separate `PlannedJob` with a concrete leg id (`<base>::<cell>`, path-safe).

## Reusable Workflows

A job can call another workflow with `uses: workflow/<name>` or `uses: ./path.yaml`:

```yaml
jobs:
  ci:
    uses: workflow/checks       # resolves .workflows/checks.yaml by name
    with:
      strict: true
```

The callee is **inlined at compile time** — resolved, recursively compiled, and spliced into the flat plan. This is compile-time inlining over a nested runtime (see `docs/reusable-workflows.md` for the rationale and deliberate divergences from GitHub Actions).

- Single-job callee → adopts the call's id (collapse).
- Multi-job callee → namespaced `<call>__<subjob>` ids.
- Depth cap: 10 levels. Cycle detection prevents infinite recursion.

A `workflow_call.outputs` value must be a **whole** `${{ jobs.<id>.outputs.<key> }}` span — a literal-wrapped value like `https://${{ jobs.host.outputs.h }}` is rejected at compile time (`reusable.ts`), because the exposed output can only carry the producer's raw value and the surrounding literal would be silently dropped.

## Triggers (`on:`)

The `on:` block is validated at parse time but acted on by separate subsystems:

| Trigger | Syntax | Handled by |
|---|---|---|
| **Webhook** | `on: webhook: { event: push }` | Web server's webhook receiver (`src/web/server.ts`) |
| **Schedule** | `on: schedule: [{ cron: "0 2 * * *" }]` | Scheduler (`src/scheduler/`) |
| **Workflow call** | `on: workflow_call:` | Compiler's reusable inlining (`src/compiler/reusable.ts`) |

Cron expressions use `croner` and evaluate in **UTC** for GitHub-Actions parity. See [Serving, Triggers & Observability](../operations/serve-and-triggers.md).

## Machine Sizing

Jobs can request specific VM resources via `machine:`:

```yaml
jobs:
  heavy:
    runs-on: work:base
    machine: large        # named: small / medium (default) / large / xlarge
```

Or inline: `machine: { cpus: 8, memory: 16G }`. The default is `medium` (8G RAM — sized for oxc parser's ~6 GiB ArrayBuffer reservation). See `src/compiler/machines.ts`.

## The `.workflows/` Project Layout

For a real project, keep workflows together in `.workflows/`:

```
my-project/
├── package.json
├── src/…
└── .workflows/
    ├── verify.yaml             # a workflow (name: verify)
    └── actions/
        └── review/             # a local action
            ├── action.yaml
            └── prompt.md
```

When a workflow lives in `.workflows/`, the **project root** (parent) is checked out into each job's workspace. A standalone `workflow.yaml` outside `.workflows/` uses its own folder as the checkout instead. `.git/` and `node_modules/` are never staged — jobs install their own deps.

Run by name: `work --workspace my-project run verify`

## Key Source References

| Area | Key files |
|---|---|
| Spec types | `src/spec/types.ts` |
| Parser / validation | `src/spec/parse.ts` |
| Compilation | `src/compiler/compile.ts` |
| Expression interpolation | `src/compiler/expr.ts` |
| Condition evaluation | `src/compiler/condition.ts` |
| Matrix expansion | `src/compiler/matrix.ts` |
| Input resolution | `src/compiler/inputs.ts` |
| Reusable inlining | `src/compiler/reusable.ts` |
| Machine sizing | `src/compiler/machines.ts` |
| Runs-on parsing | `src/compiler/runs-on.ts` |
| Output capture | `src/runtime/output.ts` |
| Full syntax reference | `docs-site/reference/workflow-syntax.md` |
