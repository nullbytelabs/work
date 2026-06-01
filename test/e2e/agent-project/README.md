# Sample project (with a pi-workflows pipeline)

A tiny TypeScript project that demonstrates the **real-world shape** for
pi-workflows: a project keeps its pipeline and agents in a `.workflows/` folder
(the analog of `.github/workflows/`), and the workflow runs against the project
root checkout.

```
.                       # <- project root: the "checkout" jobs operate on
├── main.ts             # the program
├── package.json        # deps + `npm start`
├── package-lock.json
└── .workflows/
    ├── ci.yaml          # fast verification pipeline      (name: ci)
    ├── review.yaml      # standalone agent review         (name: review)
    └── agents/
        └── summarize/   # a project-local agent package (uses: agent/summarize)
```

Two independent pipelines, so verification and review run on their own schedules:

- **`ci.yaml`** (`name: ci`) — **verify**: `npm install`, check `main.ts` is valid
  (`tsc --noEmit`), smoke-run `npm start`. Fast, no model needed.
- **`review.yaml`** (`name: review`) — **review**: an agent reads `main.ts` from
  the checkout and summarizes it. The agent is workspace-aware, so this pipeline
  needs nothing from CI — no `needs`, no threaded output.

Run them by name (the run resolves `.workflows/*.yaml` by the `name:` inside):

```bash
# fast CI, no model needed
./pi-workflows --workspace ./test/e2e/agent-project run ci

# the agent review (needs a model config)
./pi-workflows --workspace ./test/e2e/agent-project run review --config pi-workflows.config.json

# or ad-hoc by path
./pi-workflows ./test/e2e/agent-project/.workflows/review.yaml --config pi-workflows.config.json
```

`node_modules/` is intentionally not part of the checkout — each job installs
its own deps, exactly like a fresh CI runner.
