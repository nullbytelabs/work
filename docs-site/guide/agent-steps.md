# Agent steps (AI)

An agent step runs a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding agent **inside the job's micro-VM**, with its full toolset rooted at the
checkout — so it can read and edit the project's files directly. The model is
reached only through the sandbox's mediated egress, and your API key is injected
host-side and **never enters the guest**.

An agent is the `uses:` unit of pi-workflows — the rough analog of a marketplace
action in GitHub Actions, except it's an AI agent you define in your own project.

## 1. Configure a model

Agent steps need a model. Declare providers and named models in
`pi-workflows.config.json` (loaded automatically from the working directory; or
pass `--config`, or set `$PI_WORKFLOWS_CONFIG`):

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

## 2. Define an agent

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

**`task.md`** — the task prompt. It may contain `{{ placeholder }}` markers that
are bound from the step's `with:` inputs:

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
step — each value binds to the matching `{{ placeholder }}` in `task.md`.

## How it runs

The agent runs **in-guest**: Pi is invoked inside the same micro-VM as the rest of
the job, working directly against the job's checkout. The host resolves the model
endpoint, allowlists it through the sandbox's egress, and injects the API key —
which is why the key reaches the model without ever being visible inside the guest.

::: info Current scope
Today's agent runner is a single-shot run using `instructions.md` + `task.md` +
declared inputs/outputs. Multi-turn agents are not yet implemented.
:::

::: tip Complete example
[`test/e2e/agent-project/`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/agent-project)
is a full, runnable example — a `ci.yaml` pipeline (install → typecheck → smoke
test) and a separate `review.yaml` where an agent reviews the source.
:::
