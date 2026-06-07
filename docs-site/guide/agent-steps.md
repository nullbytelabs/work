# Agent steps (AI)

An agent step runs a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding agent **inside the job's micro-VM**, with its full toolset rooted at the
checkout — so it can read and edit the project's files directly. The model is
reached only through the sandbox's mediated egress, and your API key is injected
host-side and **never enters the guest**.

The agent is a built-in **step primitive**, `uses: work/agent`, prompted entirely
through `with:` — no package format, no special files. To give an agent a name, a
typed interface, and a versioned home, wrap it in an [action](./actions) (the
step-level reuse unit). The **job-level** `uses:`, which calls a whole workflow, is
[Reusable workflows](./reusable-workflows).

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

## 2. Run an agent with `work/agent`

`work/agent` is the dumb primitive: the `with:` map *is* the request. Give it a
`prompt` (and optionally `instructions`); its **final message** becomes the step
output `output`:

```yaml
jobs:
  review:
    runs-on: gondolin
    outputs:
      review: ${{ steps.a.outputs.output }}
    steps:
      - id: a
        uses: work/agent
        with:
          instructions: You are a code reviewer. Flag regressions; never edit files.
          prompt: Review the diff under /workspace and summarize the risks.
          model: kimi               # a model alias from work.json (optional)
      - run: echo "review -> ${{ steps.a.outputs.output }}"
```

Prompts can be inline (`instructions:`/`prompt:`) or read from files in the
checkout (`instructionsFile:`/`promptFile:`). Omitting `instructions` lets Pi's own
discovery (a committed `.pi/` persona, `AGENTS.md`) supply the role. The full
`work/agent` surface is on the [Actions](./actions#work-agent-the-dumb-primitive) page.

## 3. Package an agent as an action

When you want a named, reusable agent with a typed interface — the equivalent of a
GitHub Action — wrap `work/agent` in a **composite action**. The action owns its
prompts (as files), declares inputs/outputs, and lives at
`.workflows/actions/<name>/`; the workflow just calls `uses: action/<name>`:

```yaml
# .workflows/actions/review/action.yaml
name: review
outputs:
  summary:
    value: ${{ steps.run.outputs.output }}
runs:
  using: composite
  steps:
    - id: run
      uses: work/agent
      with:
        instructionsFile: .workflows/actions/review/instructions.md
        promptFile: .workflows/actions/review/task.md
```

`work create <name> --template agent-action` scaffolds exactly this. See
[Actions](./actions) for JavaScript and composite actions in full.

## How it runs

The agent runs **in-guest**: Pi is invoked inside the same micro-VM as the rest of
the job, working directly against the job's checkout. The host resolves the model
endpoint, allowlists it through the sandbox's egress, and injects the API key —
which is why the key reaches the model without ever being visible inside the guest.

::: tip Complete example
[`test/e2e/agent-project/`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/agent-project)
is a full, runnable example — a verification workflow (install → typecheck → smoke
test) and a separate `review.yaml` where a composite `review` action wraps
`work/agent` to review the source.
:::
