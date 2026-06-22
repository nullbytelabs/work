# Review: the engine reviews itself

work's own code review is a `work` workflow: a panel of AI agents, one per subsystem,
each reading the checkout and reporting **verified** findings, merged into one ranked
review. It's [dogfooding](./dogfooding) like `ci` — but agentic and on-demand,
deliberately kept **out** of the deterministic gate so its cost and model-dependence
stay clear of every push.

```bash
work run review           # the four focused reviews + the merge
work run compiler-review  # just one subsystem (2 agent VMs)
```

(Needs a model configured in [`work.json`](../reference/configuration#models); the
`ci` gate doesn't.)

## Four focused reviews

`review` is **pure composition** of four focused, self-contained [reusable
workflows](../guide/reusable-workflows), one per subsystem:

| Focused review | Reads |
|---|---|
| `compiler-review` | `src/compiler/`, `src/spec/` |
| `runtime-review` | `src/runtime/`, `src/targets/` |
| `security-review` | the agent / egress / config surface |
| `web-review` | `src/web/`, `src/persistence/` |

Each is a **scan → collect** pair. `scan` is a single
[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent
(`uses: work/agent`) that reads its subsystem straight from the checkout. `collect` is
an editor agent that **verifies every candidate against the source**: it opens each
cited file, confirms the issue is real with a concrete failure scenario, drops anything
in `.review/accepted.md`, caps the list to four, then emits machine-readable JSON
between scope-labeled sentinels:

```yaml
# .workflows/compiler-review.yaml  (the other three mirror it)
name: compiler-review
on:
  workflow_call:
    outputs:
      review: ${{ jobs.collect.outputs.review }}
jobs:
  scan:
    machine: small
    outputs:
      findings: ${{ steps.r.outputs.output }}
    steps:
      - id: r
        name: review compiler + spec
        uses: work/agent
        with:
          promptFile: .workflows/prompts/review-compiler.md
  collect:
    machine: small
    needs: [scan]
    steps:
      - id: editor
        uses: work/agent
        with:
          prompt: |
            …open each cited file, confirm the issue is real, drop what doesn't
            hold up, suppress anything in .review/accepted.md, cap at 4, emit JSON…
            === compiler + spec (raw reviewer output) ===
            ${{ needs.scan.outputs.findings }}
      - name: show review
        run: |
          printf '%s\n' "===== REVIEW JSON [compiler] BEGIN ====="
          # …$REVIEW… [compiler] END
```

Because each focused review verifies and caps on its own, it stays a small,
narrow-context job, and it runs standalone too (`work run compiler-review`) for a fast,
focused loop.

## Merging the panel

The top-level `review.yaml` wires the four together and adds a **merge editor** that
folds the four pre-verified reviews into one — it does *not* re-verify, only
de-duplicates across subsystems, ranks by severity, and keeps at most six:

```yaml
# .workflows/review.yaml  (excerpt)
on:
  workflow_call:
    outputs:
      review: ${{ jobs.collect.outputs.review }}
jobs:
  security:  { uses: workflow/security-review }
  compiler:  { uses: workflow/compiler-review }
  runtime:   { uses: workflow/runtime-review }
  web:       { uses: workflow/web-review }
  collect:
    needs: [security, compiler, runtime, web]
    steps:
      - id: editor
        uses: work/agent
        with:
          prompt: |
            Merge the four pre-verified subsystem reviews — do NOT re-verify, only
            fold together: de-duplicate, rank by severity, keep at most 6. Emit one
            JSON object.
            === compiler === ${{ needs.compiler.outputs.review }}
            # …runtime / web / security
      - name: show review
        run: |
          printf '%s\n' "===== REVIEW JSON BEGIN ====="   # …END
```

The split is deliberate: **verification happens once, per subsystem, in the focused
collects**; the top-level editor only folds the four already-distilled reviews into
one, so it works over a handful of small JSON blocks, not raw scanner dumps. The final
JSON (unlabeled `REVIEW JSON` sentinels) makes the pipeline usable as an automated
review loop: an agent can run `work run review`, parse the findings, fix, and re-run.

::: tip The model key never enters the guest
Each agent's API key is injected host-side, scoped to the model endpoint, so the key
never lands inside the micro-VM. See [Agent steps](../guide/agent-steps).
:::

## What it exercises

| In the workflow | Engine feature it leans on |
|---|---|
| `review` → four `*-review` reusables, nine `uses: work/agent` steps | [Agent steps](../guide/agent-steps) — a real Pi model in the job's sandbox — and [reusable workflows](../guide/reusable-workflows) composed two levels deep |
| `scan`/`collect` thread `steps.<id>.outputs.output` as job outputs | per-step outputs passed across the `needs` DAG |
| `collect` verifies each finding against the checkout | the agent reads the project's files directly in its own VM |

## Run it

The workflows live in
[`.workflows/`](https://github.com/nullbytelabs/work/tree/main/.workflows) —
`review.yaml` plus the four focused reviews (`compiler-review.yaml`,
`runtime-review.yaml`, `security-review.yaml`, `web-review.yaml`) and their reviewer
prompts under `.workflows/prompts/`. They need a model configured in `work.json`.

```bash
work run review           # the four focused reviews + the merge
work run compiler-review  # one subsystem, standalone
```

See [Agent steps](../guide/agent-steps) for the `work/agent` primitive, and
[Dogfooding](./dogfooding) for the deterministic `ci` gate that runs on every push.
