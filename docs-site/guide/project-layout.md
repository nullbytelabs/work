# Project layout

For a one-off, a standalone `workflow.yaml` is fine. For a real project, keep your
workflows and actions together in a `.workflows/` directory at the project root.

```
my-project/
├── package.json
├── src/…
└── .workflows/
    ├── verify.yaml             # a workflow (name: verify)
    └── actions/
        └── review/             # a local action package
            └── action.yaml     # JavaScript or composite (may wrap work/agent)
```

::: tip Scaffold it
`work init` creates this layout (a starter workflow + config), and
`work create <name>` adds another workflow — `--template agent-action` also writes
an `actions/<name>/` composite action (wrapping [`work/agent`](./agent-steps)) like
the one above. See the [CLI reference](../reference/cli#work-init).
:::

## Running a workflow by name

When your workflows live in `.workflows/`, run one **by its `name:`** — the engine
resolves the `.workflows/*.yaml` whose `name:` matches:

```bash
work --workspace my-project run verify
```

`--workspace` points at the project root (it defaults to the current directory, so
from inside the project you can just `work run verify`).

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
# .workflows/verify.yaml — runs against the project root
name: verify
jobs:
  verify:
    runs-on: gondolin
    steps:
      - run: npm install --no-audit --no-fund
      - run: npx tsc --noEmit main.ts
      - run: npm start --silent
```

## Multiple workflows

Keep separate workflows side by side and run whichever you need. A common split is
a quick check you run often and a heavier agent task on demand:

```
.workflows/
├── verify.yaml    # name: verify  — install, typecheck, smoke test
└── review.yaml    # name: review  — an agent reviews the source
```

```bash
work run verify    # fast verification
work run review    # agent review when you want one
```

Workflows in the same `.workflows/` can also **call each other**: a `release`
workflow can pull in `verify` as one job and add deploy steps after it, rather
than duplicating the checks. See [Reusable workflows](./reusable-workflows).

::: tip Complete example
[`test/e2e/agent-project/`](https://github.com/nullbytelabs/pi-workflows/tree/main/test/e2e/agent-project)
is a full, runnable project laid out this way — a verification workflow and a
separate `review.yaml` that runs an [agent step](./agent-steps).
:::
