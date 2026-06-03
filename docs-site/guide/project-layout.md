# Project layout

For a one-off, a standalone `workflow.yaml` is fine. For a real project, keep your
pipelines and agents in a `.workflows/` directory — the same idea as
`.github/workflows/`.

```
my-project/
├── package.json
├── src/…
└── .workflows/
    ├── ci.yaml                 # a pipeline (name: ci)
    └── agents/
        └── review/             # a local agent package
            ├── agent.yaml
            ├── instructions.md
            └── task.md
```

::: tip Scaffold it
`work init` creates this layout (a starter workflow + config), and
`work create <name>` adds another workflow — `--template agent-action` also writes
an `agents/<name>/` package like the one above. See the
[CLI reference](../reference/cli#work-init).
:::

## Running a pipeline by name

When your workflows live in `.workflows/`, run one **by its `name:`** — the engine
resolves the `.workflows/*.yaml` whose `name:` matches:

```bash
work --workspace my-project run ci
```

`--workspace` points at the project root (it defaults to the current directory, so
from inside the project you can just `work run ci`).

## What gets checked out

This is the key behavior to understand:

- When a workflow lives in **`.workflows/`**, the **project root** (the parent of
  `.workflows/`) is what gets checked out into each job's workspace — so
  `package.json`, your source, `npm install`, and friends are all there.
- A standalone **`workflow.yaml` outside `.workflows/`** uses its own folder as the
  checkout instead.

Each job gets its own **fresh copy** of the checkout. `.git/` and `node_modules/`
are never staged, so every job installs its own dependencies — keeping jobs
hermetic and independent.

```yaml
# .workflows/ci.yaml — runs against the project root
name: ci
jobs:
  verify:
    runs-on: gondolin
    steps:
      - run: npm install --no-audit --no-fund
      - run: npx tsc --noEmit main.ts
      - run: npm start --silent
```

## Multiple pipelines

Keep separate pipelines side by side and run whichever you need. A common split is
fast CI on every change and a heavier agent review on demand:

```
.workflows/
├── ci.yaml        # name: ci      — install, typecheck, smoke test
└── review.yaml    # name: review  — an agent reviews the source
```

```bash
work run ci        # fast verification
work run review    # agent review when you want one
```

::: tip Complete example
[`test/e2e/agent-project/`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/agent-project)
is a full, runnable project laid out exactly this way — a `ci.yaml` pipeline and a
separate `review.yaml` that runs an [agent step](./agent-steps).
:::
