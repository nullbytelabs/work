# Actions & the `work/agent` primitive

Step-level building blocks let you reach for an AI agent with **no package
ceremony**, bundle your own **bespoke logic** as a reusable step, and pull in
shipped helpers:

- **`work/agent`** — a built-in agent primitive. Prompt it entirely through
  `with:`; no manifest, no special files, no templating.
- **`action/<name>`** — a user-space action you own: **JavaScript** (an `index.mjs`
  run in the sandbox) or **composite** (a step bundle that can itself
  `uses: work/agent`). It's the **step-level sibling** of
  [reusable workflows](./reusable-workflows).
- **`work/checkout`, `work/install-node`** — built-in actions shipped with the engine.

The `uses:` forms across the project:

| `uses:` on a… | resolves to | docs |
|---|---|---|
| **step** | `work/agent` — the built-in agent primitive | **this page** |
| **step** | `action/<name>` — your JavaScript or composite action | **this page** |
| **step** | `work/checkout`, `work/install-node` — built-in actions | **this page** |
| **job** | `workflow/<name>` — an entire workflow | [Reusable workflows](./reusable-workflows) |

## `work/agent` — the dumb primitive

When you just want "run an agent here with this prompt," reach for `work/agent`.
The `with:` map *is* the request:

```yaml
jobs:
  review:
    runs-on: gondolin
    steps:
      - id: a
        uses: work/agent
        with:
          prompt: You are a code reviewer. Review the diff under /workspace and summarize the risks.
          model: kimi          # a model alias from work.json (optional)
```

The agent's **final message** becomes the step's single `output`:

```yaml
- run: echo "risks -> ${{ steps.a.outputs.output }}"
```

`work/agent` runs a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent **in-guest** — mediated egress, host-side key injection (your key never
enters the guest). It needs a model; see
[Configure a model](./agent-steps#_1-configure-a-model).

### The prompt

There's one prompt input — no separate system prompt. It can be inline (`prompt:`)
or read from a file in your checkout (`promptFile:`), so versioned, reviewable
prompts don't have to live at the call site:

| `with:` key | → | |
|---|---|---|
| `prompt` | the prompt (carries any role/persona too) | inline string |
| `promptFile` | …same, read from the checkout | workspace-relative path |
| `model` | a model alias from `work.json` | falls back to `defaultModel` |

A **prompt source is required** (`prompt` or `promptFile`); the rest is optional.

```yaml
- uses: work/agent
  with:
    promptFile: prompts/review.md     # checked-in, reviewable
```

Need a standing persona without repeating it at every call site? `work/agent` runs
Pi's own discovery rooted at the checkout, so a committed `.pi/` persona or an
`AGENTS.md` in the repo is picked up ambiently — "just use the skills/persona I
already have in this repo" works with no re-housing.

::: tip Where rich prompts belong
Inline prompts are fine for one-offs. The versioned, testable home for a real
prompt is a file (`promptFile:`) — or a **JavaScript action** that wraps
`work/agent` with its own inputs and output parsing (below).
:::

## JavaScript actions — keep the bespoke logic

An **action** is a project-owned package under `.workflows/actions/<name>/`. A
JavaScript action runs arbitrary Node in the sandbox — the home for logic the
engine never needs to know about: shape inputs, call out, parse a result into
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
    runs-on: gondolin
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

## Composite actions — step bundles

A **composite** action is a list of `steps:` — each a `run:` command or a `uses:`
(of `work/agent` or another action). It's the step-level sibling of a reusable
workflow: a named, reusable bundle, and the canonical way to package a real agent.
Inputs are referenced as <code v-pre>${{ inputs.x }}</code> and one step's outputs
flow to the next as <code v-pre>${{ steps.id.outputs.y }}</code>; declared outputs
take a `value:` expression:

```yaml
# .workflows/actions/review/action.yaml
name: review
inputs:
  target: { type: string, default: /workspace }
outputs:
  summary:
    value: ${{ steps.run.outputs.output }}     # map a step output to an action output
runs:
  using: composite
  steps:
    - id: prep
      run: git diff > /tmp/diff.txt
    - id: run
      uses: work/agent                          # the primitive, wrapped
      with:
        prompt: Review /tmp/diff.txt for regressions affecting ${{ inputs.target }}.
```

The whole action runs as the caller's **single** step, in the job's micro-VM. A
composite step's `with:` is resolved at run time, so it can take a previous step's
output as an input — the same data flow GitHub composite actions support.

## Built-in actions

The engine ships a couple of actions under the reserved `work/` scheme:

| `uses:` | What it does | Key `with:` |
|---|---|---|
| `work/checkout` | `git clone` a public repo into the workspace (installs git in-guest). | `repo` (required; `owner/name` or a URL), `ref`, `path`, `depth` |
| `work/install-node` | Install a specific Node version, shadowing the guest's for later steps. | `version` (required, e.g. `24.9.0`) |

```yaml
steps:
  - uses: work/checkout
    with: { repo: octocat/Hello-World, path: src }
  - uses: work/install-node
    with: { version: 24.9.0 }
  - run: node --version          # the installed version
```

A job containing one of these is granted mediated egress automatically (most jobs
are deny-by-default). `work/install-node` uses musl Node builds; **arm64 guests
need a version that publishes an arm64-musl build (v24+)** — x64 supports all.

## How it runs

Everything runs **in the job's micro-VM** — never on your host. A JS action is
staged into the sandbox, its deps installed if any, then `node <main>` runs with
`INPUT_*` set and `$WORK_OUTPUT` captured. A composite action runs its steps
in-guest as one checkpoint. Both get the same deny-by-default mediated egress as
every other step.

::: info Not yet
**Remote** sourcing (`owner/repo@ref`) and a `./path` reference form are planned;
today actions resolve by the `action/<name>` scheme from `.workflows/actions/`.
:::

::: tip Runnable examples
[`test/e2e/work-agent`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/work-agent)
(the `work/agent` primitive),
[`test/e2e/js-action`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/js-action)
(the `greet` JS action), and
[`test/e2e/composite-action`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/composite-action)
(a composite action wrapping `work/agent`).
:::
