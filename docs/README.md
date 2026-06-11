# Design records

These are the project's **design and research records** — the *why* behind the
engine's architecture: the alternatives weighed, the threat models, the
trade-offs accepted. They are written for contributors and maintainers.

**If you want to learn or use `work`, read the
[documentation site](https://nullbytelabs.github.io/work/) instead** — that is
the canonical, user-facing documentation. Records here describe the tree as it
stood when each decision was made; file/line references may have drifted, but
the rationale is the point.

## Architecture & durability

- [`absurd-durable-workflows.md`](absurd-durable-workflows.md) — mapping
  GitHub-Actions concepts onto Absurd's durable-task primitives; the engine's
  durability vocabulary.
- [`durable-orchestrator.md`](durable-orchestrator.md) — why orchestration is
  itself a durable task (two-queue saga, crash-resume without an external
  re-driver).
- [`pglite-wasm-postgres-database.md`](pglite-wasm-postgres-database.md) —
  PGLite as the embedded Postgres: what it supports, and the single-connection
  ceiling that scopes it to single-host use.

## Security & isolation

- [`gondolin-secure-execution.md`](gondolin-secure-execution.md) — the Gondolin
  micro-VM isolation model: networking (deny-by-default), secret injection
  (header-swap; real values never enter the guest), lifecycle gotchas.
- [`pi-in-gondolin.md`](pi-in-gondolin.md) — why agent steps run *inside* the
  VM rather than on the host: the threat model and the placement options
  considered.
- [`secrets-management-and-injection.md`](secrets-management-and-injection.md) —
  roadmap for brokering secrets from external stores (auth models, backend
  evaluation, phasing).

## Workflow surface

- [`agent-primitive-and-actions.md`](agent-primitive-and-actions.md) — the
  reframe from engine-owned agent packages to a minimal `work/agent` primitive
  plus user-space actions.
- [`reusable-workflows.md`](reusable-workflows.md) — job-level `uses:`: why
  compile-time inlining over a nested runtime, and the deliberate divergences
  from GitHub Actions.
- [`webhook-triggers-research.md`](webhook-triggers-research.md) — the webhook
  trigger and its security boundary (layered auth, sender constraints,
  deployment tiers).
- [`gondolin-custom-images.md`](gondolin-custom-images.md) — the `work:*`
  image namespace: lazy builds through Gondolin's own builder, tagged store.
- [`nested-self-hosting.md`](nested-self-hosting.md) — running the full test
  suite (incl. the real-VM e2e tier) self-hosted in nested gondolin VMs: the
  TCG fallback, the `work:nested` image, and the trade-offs.

## Interfaces

- [`tui-iteration-2.md`](tui-iteration-2.md) — the live terminal view: why a
  layered status list (not a box-and-edge DAG) and why it's hand-rolled.
- [`web-ui-research.md`](web-ui-research.md) — the `--web` console: zero-dep
  server, SSE event protocol, run history and persistence.
- [`init-doctor-scaffolding-research.md`](init-doctor-scaffolding-research.md) —
  `work init` / `create` / `doctor`: config layering, template strategy,
  doctor's read-only contract.

Records for explored-but-rejected directions (multi-host queues, embedded
tunnels, …) are removed once the decision is captured; they live in git
history.
