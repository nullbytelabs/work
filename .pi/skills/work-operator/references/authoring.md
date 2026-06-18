# Authoring workflows — cheatsheet

Canonical reference: `docs-site/reference/workflow-syntax.md`. Live, runnable
examples: `test/e2e/` (matrix, fan-out/fan-in, conditionals, typed inputs, agent
project, …) — copy from there first. After authoring, always
`work graph <name> --steps` to verify compilation before a real run.

## Skeleton

```yaml
name: my-flow                 # `work run my-flow` resolves by this
on: workflow_call             # reusable; or `webhook` for a trigger; omit for plain
inputs:                       # typed; bound at compile time
  target:
    type: string
    default: main
jobs:
  build:
    runs-on: gondolin         # stock guest (default). `work:base` for git/jq/curl/npm ci
    machine: medium           # small 2G / medium 8G (default) / large 12G / xlarge 24G
    steps:
      - run: npm ci && npm run build
        id: build
    outputs:
      sha: ${{ steps.build.outputs.sha }}
  test:
    needs: [build]            # DAG edge; independent jobs run in parallel
    steps:
      - run: echo "built ${{ needs.build.outputs.sha }}"
```

## Steps: `run:` XOR `uses:`

- **`run:`** — a shell command in the guest.
- **`uses: work/agent`** — a real Pi agent in-guest, full toolset over the checkout.
  `with: { prompt: "…" }` or `with: { promptFile: "path", model: "kimi" }`. Its
  final message becomes the step `output`. Multi-output: declare 2+ outputs and have
  the agent return a JSON object. (Don't reintroduce the removed `agent/<name>`
  package format.)
- **`uses: action/<name>`** — a user-space action under `.workflows/actions/<name>/`
  (JavaScript `runs.using: node` with `INPUT_*`/`$WORK_OUTPUT` ABI, or composite
  `runs.using: composite` step bundle). Built-ins: `work/checkout`, `work/install-node`.
- **`uses: workflow/<name>`** — inline another reusable workflow as a job (how `ci`
  composes `checks`/`test`, and `review` composes the focused reviews).

## Outputs (the part people get wrong)

Don't hand-roll output capture. For an explicit value, append to `$WORK_OUTPUT`:

```yaml
- run: echo "sha=$(git rev-parse HEAD)" >> "$WORK_OUTPUT"   # or key<<EOF … EOF for multiline
  id: rev
```

Every `id`ed step exposes **for free**:
- `${{ steps.<id>.outputs.<key> }}` — explicit outputs
- `${{ steps.<id>.logs }}` — combined stdout+stderr
- `${{ steps.<id>.outcome }}` — success / failure / skipped
- `${{ steps.<id>.exitCode }}`

Cross-job: `${{ needs.<job>.outputs.<key> }}`. Inputs resolve at compile time;
`needs.*`/`steps.*` resolve at runtime.

## Conditions

`if:` / `when:` on a step or job, evaluated with `${{ }}` expressions
(`src/compiler/condition.ts`). `continue-on-error: true` makes a failing step not
gate the job (its `outcome` still propagates) — this is how `checks`/`test` forward
each tool's pass/fail to `review` without failing the run.

## Matrix

`strategy.matrix` fans a job out; see `test/e2e/` matrix examples. Fan-out happens
at compile time (`src/compiler/matrix.ts`).

## Triggers & config

- `on: webhook` + a `webhooks.<name>` block in `work.json` (auth `bearer`, `secret:
  $VAR`) — fired via `work serve`'s receiver.
- Agent steps need a model: `work.json` → `providers`, `models`, `defaultModel`
  (copy `work.example.json`; `apiKey: "$VAR"`). Gitignored — never commit keys.
- `datasources:` in config + `--datasources a,b` grants a job scoped egress to a
  datasource host with a header-injected token (deny-by-default).

## Custom images

`work create image <name>` scaffolds `.workflows/images/<name>/build-config.json`
(arch-agnostic). `work:nested` (used by `test`) = `work:base` + qemu, built lazily
on first use.

## The verify-before-run habit

```bash
work graph my-flow --steps          # see the planned DAG + steps, no VM boot
work graph my-flow --format json    # machine-readable plan (or use the work_graph tool)
work run my-flow                     # the real thing (boots VMs)
```
