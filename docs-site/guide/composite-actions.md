# Composite actions

A **composite action** is an [action](./actions) whose body is a list of `steps:` —
each a `run:` command, a `uses: work/agent`, or a `uses:` of another action. It's
the step-level sibling of a [reusable workflow](./reusable-workflows): a named,
reusable bundle of steps with a typed interface. It's also the canonical way to
**package an agent** — wrap [`work/agent`](./agent-steps) with file-backed prompts
and a declared output.

## Shape

`runs.using: composite` with a `steps:` list. Inputs are referenced as
<code v-pre>${{ inputs.x }}</code>, and one step's outputs flow to the next as
<code v-pre>${{ steps.id.outputs.y }}</code>. Each declared output takes a `value:`
expression that maps a step output out of the action:

```yaml
# .workflows/actions/review/action.yaml
name: review
inputs:
  target: { type: string, default: /workspace }
outputs:
  summary:
    value: ${{ steps.run.outputs.output }}     # map a step output → an action output
runs:
  using: composite
  steps:
    - id: prep
      run: git diff > /tmp/diff.txt            # a shell step
    - id: run
      uses: work/agent                         # the agent primitive, wrapped
      with:
        prompt: Review /tmp/diff.txt for regressions affecting ${{ inputs.target }}.
```

Call it like any action — `uses: action/review` — and read its mapped outputs as
`steps.<id>.outputs.summary`.

## Packaging an agent

This is the recommended home for a reusable agent: a composite action whose prompt
lives in a file beside it, wrapping `work/agent`.

```yaml
# .workflows/actions/summarize/action.yaml
name: summarize
outputs:
  summary:
    value: ${{ steps.run.outputs.output }}
runs:
  using: composite
  steps:
    - id: run
      uses: work/agent
      with:
        promptFile: .workflows/actions/summarize/prompt.md
```

`work create <name> --template agent-action` scaffolds exactly this shape (the
workflow, the composite action, and a starter model config).

## How it runs

The whole action runs as the caller's **single** durable step, in the job's
micro-VM. A composite step's `with:` is resolved at **run time**, so an inner step
can take a previous step's output as an input — the same step-to-step data flow
GitHub composite actions support. Inner `run:` steps capture `$WORK_OUTPUT`; inner
`uses:` steps dispatch to their handler (`work/agent`, a nested action). Like every
`uses:` step, the job gets mediated egress.

::: tip Runnable example
[`test/e2e/composite-action`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/composite-action)
is a composite action that shapes an input in a `run:` step and then calls
`work/agent`. [`test/e2e/agent-project`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/agent-project)
packages its review agent as the composite `summarize` action above.
:::
