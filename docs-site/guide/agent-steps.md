# Agent steps (AI)

An agent step runs a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding agent **inside the job's micro-VM**, with its full toolset rooted at the
checkout — so it can read and edit the project's files directly. The model is
reached only through the sandbox's mediated egress, and your API key is injected
host-side and **never enters the guest**.

An agent is a **step-level** `uses:` unit of pi-workflows — a reusable AI step
you define in your own project and drop into any workflow. (The **job-level**
`uses:`, which calls a whole workflow, is [Reusable workflows](./reusable-workflows).)

::: tip Just need a prompt, not a package?
This page covers the `agent/<name>` **package** format (a manifest + prompt files).
For a one-step agent prompted inline, reach for the built-in
[`work/agent`](./actions) primitive — and for bespoke logic in your own
JavaScript, a [user-space action](./actions). Both are lighter-weight siblings of
the package format.
:::

## 1. Configure a model

Agent steps need a model. Declare providers and named models in
`work.json` (loaded automatically from the working directory; or
pass `--config`, or set `$WORK_CONFIG`):

```json
{
  "providers": {
    "fireworks": {
      "baseUrl": "https://api.fireworks.ai/inference/v1",
      "apiKey": "$FIREWORKS_API_KEY"
    }
  },
  "models": {
    "kimi": {
      "provider": "fireworks",
      "model": "accounts/fireworks/models/kimi-k2p6",
      "maxTokens": 2048
    }
  },
  "defaultModel": "kimi"
}
```

`apiKey` supports `$VAR` / `${VAR}` expansion, so secrets stay in your environment
rather than in the file. Any OpenAI-compatible provider works. See the full
[Configuration reference](../reference/configuration).

::: warning Keep keys out of the file
Prefer `"apiKey": "$FIREWORKS_API_KEY"` over pasting a literal key. A committed key
is a leaked key.
:::

::: tip Scaffold the config
`work init` writes a starter `work.json` like this, and
`work init --global` puts one at `~/.config/work/work.json` to share across
projects. Fill in a real `$FIREWORKS_API_KEY` (or your provider's key).
:::

## 2. Define an agent

::: tip Scaffold the whole thing
`work create <name> --template agent-action` generates the workflow, the
`.workflows/agents/<name>/` package below, and a starter config in one step — then
you just edit the prompts.
:::

An agent is a package under `.workflows/agents/<name>/` with three files:

```
.workflows/agents/review/
├── agent.yaml          # manifest: name, description, inputs, outputs
├── instructions.md     # the system prompt (the agent's standing role)
└── task.md             # the task prompt, with optional {{ input }} placeholders
```

**`agent.yaml`** — the manifest. It declares the agent's name, a description, and
its `inputs`/`outputs`:

```yaml
name: summarize
description: Read the project's source and summarize it in one sentence.
outputs:
  summary:
    description: The one-sentence summary (the agent's final message).
```

**`instructions.md`** — the system prompt, the agent's standing role.

**`task.md`** — the task prompt. It may contain <code v-pre>{{ placeholder }}</code>
markers that are bound from the step's `with:` inputs:

```markdown
Read `main.ts` in your working directory and summarize what it does in one sentence.
```

## 3. Use it in a workflow

Reference the agent with `uses: agent/<name>`. The agent's **final message** becomes
the step's declared output:

```yaml
jobs:
  review:
    runs-on: gondolin
    outputs:
      review: ${{ steps.summary.outputs.summary }}
    steps:
      - id: summary
        name: review the source with an agent
        uses: agent/summarize
      - name: show review
        run: echo "review -> ${{ steps.summary.outputs.summary }}"
```

Pass inputs to an agent via `with:`, the same way you'd pass inputs to any `uses:`
step — each value binds to the matching <code v-pre>{{ placeholder }}</code> in `task.md`.

## How it runs

The agent runs **in-guest**: Pi is invoked inside the same micro-VM as the rest of
the job, working directly against the job's checkout. The host resolves the model
endpoint, allowlists it through the sandbox's egress, and injects the API key —
which is why the key reaches the model without ever being visible inside the guest.

::: info How a run works
Each agent step is a focused, self-contained run: the agent gets its
`instructions.md`, its `task.md` (with any `with:` inputs bound), and its declared
outputs — then it works in the sandbox and returns its final message as the step's
output.
:::

::: tip Complete example
[`test/e2e/agent-project/`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/agent-project)
is a full, runnable example — a verification workflow (install → typecheck → smoke
test) and a separate `review.yaml` where an agent reviews the source.
:::
