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
- [`egress-data-path.md`](egress-data-path.md) — the five invariants of how a
  guest byte actually reaches an upstream: synthetic DNS, host-side
  re-resolution (the guest-dialed IP is ignored), the private-range block,
  hook ordering, and what `resolve` pins build on. **Read before designing
  anything that touches sandbox networking.**
- [`pi-in-gondolin.md`](pi-in-gondolin.md) — why agent steps run *inside* the
  VM rather than on the host: the threat model and the placement options
  considered.
- [`secrets-management-and-injection.md`](secrets-management-and-injection.md) —
  roadmap for brokering secrets from external stores (auth models, backend
  evaluation, phasing).
- [`egress-walk-back.md`](egress-walk-back.md) — walking back the
  deny-by-default egress wall (it's theater: agent and checkout jobs already get
  allow-all, and the host-side header-swap — not the allowlist — is what isolates
  tokens), plus a `work.json` `secrets:` passthrough whitelist (`${{ secrets.* }}`,
  plaintext or `$ENV` ref) that finally makes `aws`/`gcloud`/`kubectl` usable
  in-guest. A control people route around has negative value.

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
- [`scheduled-triggers-research.md`](scheduled-triggers-research.md) — the
  `on: schedule` cron trigger: GHA-mirrored syntax, why durability rides Absurd's
  `sleepUntil` (a self-rescheduling ticker, not `pg_cron`), the web-server
  lifecycle as host, and `croner` for cron math.
- [`tailnet-incident-response-research.md`](tailnet-incident-response-research.md) —
  a cluster fleet and its LGTM telemetry stack reached over a Tailscale tailnet
  (tokens via the `secrets:` whitelist), and the autonomous loop: PrometheusRule → Alertmanager → `work`
  webhooks → conditional diagnostic DAGs → ops notify → remediation hand-off.
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
- [`generator-expansion-research.md`](generator-expansion-research.md) — a
  state-of-the-generators assessment: how useful `init`/`create` are today, the
  docs-site coverage gaps, and the ranked unaccounted-for surfaces to scaffold
  next (action packages, webhook config, template variety).

## Testing & quality

- [`testing-strategy-review.md`](testing-strategy-review.md) — a critical
  whole-suite review: the pyramid shape (wide unit base, diamond integration
  waist, pinpoint VM tip), where confidence actually comes from vs. where the
  green suite gives false confidence (the no-QEMU silent-skip trust gap, the
  `HostTarget` path-divergence blind spot, no automated real-inference path), the
  one real bug it turned up (scheduler `tick` aborts on a bad cron), and ranked
  P0/P1/P2 recommendations.
- [`property-based-testing.md`](property-based-testing.md) — adopting fast-check
  for the pure compiler/spec surface: Anthropic's PBT framing (properties as a
  higher-altitude spec; "is the test testing anything worthwhile?"), the
  pattern vocabulary, the ranked concern inventory (matrix fan-out is the entry
  point; expression access-path is the showcase round-trip), the anti-tautology
  quality gate, and a living findings log. A knowledge guide + progress tracker.

## Observability

- [`observability-otel-metrics.md`](observability-otel-metrics.md) — instrumenting
  runs with OpenTelemetry traces (run→job→step spans, GenAI/CI-CD semconv, VM image
  and token attributes) and metrics, pushed over OTLP to Grafana Alloy → Tempo +
  Prometheus: the hooks seam as the single instrumentation point, traces across
  crash-resume (skip-on-replay for free via memoized checkpoints; persist+restore the
  root span context), the metric catalog, the agent token-capture gap, and the opt-in /
  no-op dependency design.

Records for explored-but-rejected directions (multi-host queues, embedded
tunnels, …) are removed once the decision is captured; they live in git
history.
