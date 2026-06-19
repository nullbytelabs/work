# Accepted findings

Findings the maintainers have reviewed and judged acceptable as-is. The
`review` workflow's collect editor reads this file and suppresses matching
candidates, so settled questions stop resurfacing run after run.

One bullet per entry: `file` — the finding, and why it's accepted. Keep
entries specific enough to match (file + the gist of the issue).

- `src/persistence/run-events.ts` — `list(runId)`/`replayHistorical` load all `work.run_events`
  rows with no LIMIT and `work.run_events` has no retention. Accepted as-is: `work --web`
  is a local-first, single-operator console (PGLite file under `.workflows/db/`), the
  live in-memory frame ring IS capped (RING_CAP), and a global retention/streaming policy
  is a deliberate design choice (how many events per run to keep, purge cadence) that
  shouldn't be reflexively bolted on — to be designed alongside run history retention, not
  under review pressure. Not a correctness bug.
- `src/web/server.ts` (recordDelivery / `work.webhook_deliveries`) — durable delivery rows,
  including unauthenticated-rejection rows, are written without a row cap or retention.
  Accepted as-is for the same local-tool reason: the in-memory `recentDeliveries` ring is
  capped (RECENT_DELIVERIES_CAP), unauthenticated rejections to a *configured* hook are
  exactly the audit trail an operator wants, and a retention policy (keep-last-N-per-hook /
  periodic sweep) is a deliberate design decision to make together with the run/event
  retention above. The documented deployment is operator-controlled; not a correctness bug.
- `src/web/run-manager.ts` — terminal `RunRecord`s are never evicted from the in-memory
  `runs`/`order` maps (per-record frame ring is capped, count is not). Accepted as-is: LOW
  severity, only matters on a very long-lived server, and eviction must be conditional on a
  durable `runStore` being present (in memory-only mode `this.runs` IS the history list).
  Part of the same retention design area as the two above; defer to a deliberate pass.
- `src/runtime/absurd/runtime.ts` (per-run `registerTask` job:/orch: handlers never
  deregistered) — in the shared-engine `work --web` path the absurd-sdk client registry
  accumulates two closures per dispatched run for the server's lifetime. Accepted as-is:
  same long-lived-web-server in-memory-growth class as the run-record/event entries above,
  LOW severity, CLI is unaffected (each process owns + closes its own engine). The real
  fix (parameterized single-registration handlers, or deregister on terminal) is an
  absurd-sdk-shaped refactor to do deliberately, not reflexively under review pressure.
