# Actions

An **action** is a reusable **step** you own — the step-level sibling of a
[reusable workflow](./reusable-workflows). It lives in your project under
`.workflows/actions/<name>/` and you call it with `uses: action/<name>`. There are
two kinds:

- **JavaScript** — an `index.mjs` run in the sandbox (this page).
- **[Composite](./composite-actions)** — a bundle of `steps:` (which can `run:`,
  call `work/agent`, or call another action).

Plus the engine ships a few **[built-in actions](./builtin-actions)** under the
`work/` scheme, and the agent primitive [`work/agent`](./agent-steps) is a step too.
The `uses:` forms at a glance:

| `uses:` on a… | resolves to | docs |
|---|---|---|
| **step** | `action/<name>` — your JavaScript or composite action | **this page** / [Composite](./composite-actions) |
| **step** | `work/agent` — the built-in agent primitive | [Agent steps](./agent-steps) |
| **step** | `work/checkout`, `work/install-node` — built-in actions | [Built-in actions](./builtin-actions) |
| **job** | `workflow/<name>` — an entire workflow | [Reusable workflows](./reusable-workflows) |

## JavaScript actions

A JavaScript action runs arbitrary Node in the sandbox — the home for bespoke logic
the engine never needs to know about: shape inputs, call out, parse a result into
structured fields.

```
.workflows/actions/greet/
├── action.yaml      # manifest: typed inputs/outputs + the entry script
└── index.mjs        # arbitrary JS — your logic
```

**`action.yaml`** — the manifest. `inputs:` reuse the workflow
[`inputs:`](./writing-workflows#inputs) grammar (types, `default`, `required`,
`options`, `pattern`), validated against the step's `with:`:

```yaml
name: greet
inputs:
  name:
    type: string
    default: world
outputs:
  greeting:
    description: the greeting line
runs:
  using: node          # a JavaScript action
  main: index.mjs       # the entry script (default: index.mjs)
```

**`index.mjs`** — your code. It reads typed inputs from `INPUT_<NAME>` env vars and
writes declared outputs to the `$WORK_OUTPUT` file — the **same ABI** a `run:` step
uses, lifted straight from GitHub Actions so it's already familiar:

```js
import { appendFileSync } from "node:fs";

const name = process.env.INPUT_NAME ?? "world";
appendFileSync(process.env.WORK_OUTPUT, `greeting=hello, ${name}\n`);
```

**Use it in a workflow** with `uses: action/<name>` and pass inputs via `with:`:

```yaml
jobs:
  greet:
    runs-on: work:base
    steps:
      - id: g
        uses: action/greet
        with:
          name: workflows
      - run: echo "${{ steps.g.outputs.greeting }}"   # → hello, workflows
```

Only the action's **declared** outputs are surfaced as `steps.<id>.outputs.*` — the
manifest stays the contract.

### Dependencies

If the action directory has a `package.json`, its dependencies are `npm install`ed
**in-guest** before the script runs (native modules build for the guest), so an
action can pull in libraries:

```
.workflows/actions/scrape/
├── action.yaml
├── index.mjs
└── package.json     # → npm install in the sandbox
```

## How a JS action runs

It runs **in the job's micro-VM** — never on your host. The engine stages the action
directory into the sandbox, installs its deps if any, then runs `node <main>` with
`INPUT_*` set and `$WORK_OUTPUT` captured, and reads the declared outputs back. Like
every `uses:` step it gets mediated egress (a plain `run:`-only job is
deny-by-default).

::: info Not yet
**Remote** sourcing (`owner/repo@ref`) and a `./path` reference form are planned;
today actions resolve by the `action/<name>` scheme from `.workflows/actions/`.
:::

::: tip Next
- Bundle steps (and wrap `work/agent`) with [Composite actions](./composite-actions).
- Use the shipped [Built-in actions](./builtin-actions) (`work/checkout`, `work/install-node`).
- Runnable example: [`test/e2e/js-action`](https://github.com/nullbytelabs/work/tree/main/test/e2e/js-action) (the `greet` action above).
:::
