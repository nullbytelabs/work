# Actions & the `work/agent` primitive

Two step-level building blocks let you reach for an AI agent with **no package
ceremony**, and bundle your own **bespoke logic** as a reusable step:

- **`work/agent`** — a built-in agent primitive. Prompt it entirely through
  `with:`; no manifest, no special files, no templating.
- **`action/<name>`** — a user-space **JavaScript action**: a small project-owned
  package whose `index.mjs` runs in the sandbox with a GitHub-Actions-style ABI.
  It's the **step-level sibling** of [reusable workflows](./reusable-workflows).

Both are `uses:` **steps**, alongside the [`agent/<name>`](./agent-steps) package
format. The four `uses:` forms across the project:

| `uses:` on a… | resolves to | docs |
|---|---|---|
| **step** | `work/agent` — the built-in agent primitive | **this page** |
| **step** | `action/<name>` — your JavaScript action | **this page** |
| **step** | `agent/<name>` — an agent **package** (manifest + prompt files) | [Agent steps](./agent-steps) |
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
          instructions: You are a code reviewer. Flag regressions; never edit files.
          prompt: Review the diff under /workspace and summarize the risks.
          model: kimi          # a model alias from work.json (optional)
```

The agent's **final message** becomes the step's single `output`:

```yaml
- run: echo "risks -> ${{ steps.a.outputs.output }}"
```

`work/agent` runs a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent **in-guest**, exactly like an `agent/<name>` step — same mediated egress,
same host-side key injection (your key never enters the guest). It needs a model;
see [Configure a model](./agent-steps#_1-configure-a-model).

### Prompt sources

Each prompt can be inline, or read from a file in your checkout — so versioned,
reviewable prompts don't have to live at the call site:

| `with:` key | → | |
|---|---|---|
| `instructions` | system prompt (the agent's standing role) | inline string |
| `instructionsFile` | …same, read from the checkout | workspace-relative path |
| `prompt` | the task prompt | inline string |
| `promptFile` | …same, read from the checkout | workspace-relative path |
| `model` | a model alias from `work.json` | falls back to `defaultModel` |

A **prompt source is required** (`prompt` or `promptFile`); everything else is
optional.

```yaml
- uses: work/agent
  with:
    instructionsFile: prompts/reviewer.md     # checked-in, reviewable
    promptFile: prompts/review-task.md
```

### Omitting `instructions`: use what your `.pi/` already enables

`work/agent` runs Pi's own discovery rooted at the checkout. If you **omit**
`instructions`, no system prompt is forced — so a committed `.pi/` persona or an
`AGENTS.md` in the repo stands on its own:

```yaml
- uses: work/agent
  with:
    prompt: Triage the failing tests and propose the smallest fix.
```

"Just use the skills/persona I already have in this repo" works ambiently — no
re-housing required.

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

## How it runs

Both forms run **in the job's micro-VM** — never on your host. For a JS action,
the engine stages the action directory into the sandbox, installs its deps if any,
runs `node <main>` with the `INPUT_*` env set and `$WORK_OUTPUT` pointed at a
capture file, then reads the declared outputs back. It's the same
stage → install → exec → read path that runs an in-guest agent — so an action gets
the same deny-by-default mediated egress as every other step.

::: info Not yet
This iteration ships **JavaScript** actions (`runs.using: node`). **Composite**
actions (a `runs.using: composite` step bundle that can itself `uses: work/agent`)
and **remote** sourcing (`owner/repo@ref`) are planned next. Actions resolve by the
`action/<name>` scheme today; a `./path` form is reserved.
:::

::: tip Runnable examples
[`test/e2e/work-agent`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/work-agent)
uses the `work/agent` primitive;
[`test/e2e/js-action`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/js-action)
is the full `greet` action above.
:::
