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

`work/agent` is the dumb primitive: give it a single `prompt` (the role lives in
the prompt itself), and its **final message** becomes the step output `output`:

```yaml
jobs:
  review:
    runs-on: work:base
    outputs:
      review: ${{ steps.a.outputs.output }}
    steps:
      - id: a
        uses: work/agent
        with:
          prompt: You are a code reviewer. Review the diff under /workspace and summarize the risks.
          model: kimi               # a model alias from work.json (optional)
      - run: echo "review -> ${{ steps.a.outputs.output }}"
```

The prompt can be inline (`prompt:`) or read from a file in the checkout
(`promptFile:`). There's no separate system-prompt input — a standing persona can
come from the prompt, or from Pi's own discovery of a committed `.pi/` persona /
`AGENTS.md`.

## 3. Package an agent as an action

When you want a named, reusable agent with a typed interface — the equivalent of a
GitHub Action — wrap `work/agent` in a **[composite action](./composite-actions)**:
a file-backed prompt and a declared output, called as `uses: action/<name>`.
`work create <name> --template agent-action` scaffolds exactly that. See
[Composite actions](./composite-actions#packaging-an-agent) for the full shape.

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
