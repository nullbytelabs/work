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
    ├── main.yaml        # the CI pipeline
    └── agents/
        └── summarize/   # a project-local agent package (uses: agent/summarize)
```

The `main.yaml` pipeline:

1. **verify** — `npm install`, check `main.ts` is valid (`tsc --noEmit`), and
   smoke-run `npm start`; then capture the source for review.
2. **review** — an agent reviews/summarizes the captured source.

Run it (the workflow's `name:` is `ci`):

```bash
# by name, from anywhere (workspace defaults to cwd; --workspace points elsewhere)
./pi-workflows --workspace ./test/e2e/agent-project run ci --config pi-workflows.config.json

# or ad-hoc by path
./pi-workflows ./test/e2e/agent-project/.workflows/main.yaml --config pi-workflows.config.json
```

`node_modules/` is intentionally not part of the checkout — each job installs
its own deps, exactly like a fresh CI runner.
