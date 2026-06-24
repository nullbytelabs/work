# Testing strategy review — state of the apparatus

A critical pass over the whole test apparatus of `@nullbytelabs/work`: the
pyramid shape, where confidence actually comes from, what's strong, what gives
false confidence, and what to do next. Written 2026-06-17 against `main` at
`6aa04bd` (review branch `joshs/testing-review`). File/line references are
accurate as of that commit and will drift.

This is a *findings record*, not a mandate — the recommendations are ranked so
the high-leverage few are obvious. The `property-based-testing.md` record is the
companion for the PBT layer specifically; this document is the whole-suite view.

---

## Headline

The suite is in good shape and **above average in discipline** — behavior-oriented
assertions, a genuinely faithful durable-journal substrate (real PGLite
everywhere, real cross-restart), adversarial security tests, and a property-based
layer that has already found a real bug and driven a real security fix. The
foundations are sound; this is tuning, not rescue.

Three things are worth acting on, in order:

1. **The green suite does not prove the VM/agent path works** — and it exits
   green anyway on a host without QEMU. This is the central trust gap, and it is
   exactly what the project memory's "verify against a real run"
   rule exists to backstop. It should be surfaced structurally, not held as tribal
   knowledge.
2. **A real robustness bug surfaced during the audit**: the scheduler `tick`
   aborts the entire loop if any one schedule has a malformed cron expression.
   Untested, and a genuine fleet-ops hazard.
3. **The middle of the pyramid is overloaded and partly redundant**, and a
   handful of brittle/stale tests are accruing maintenance cost. Cheap to trim.

---

## The shape

70 top-level test files (~9.9k LOC tests vs ~14.6k LOC src), plus an e2e gallery
of 22 workflow dirs under `test/e2e/` driven by `examples.test.ts`.

| Tier | Files | ~LOC | Boots a real VM? |
|---|---|---|---|
| **Pure unit** | 37 (incl. 8 property tests) | ~5,300 | no |
| **Integration** (PGLite + `HostTarget` double, no VM) | 28 | ~3,700 | no |
| **e2e** | 5–6 | ~600 | only **3** files |

**It's a pyramid with a diamond waist and a pinpoint tip.** Wide, healthy unit
base (~55% of LOC, with `compiler/` exceptionally well covered). An unusually
thick integration middle — nearly as many files as the base — dominated by a
web/webhook/persistence/runtime cluster (~14 files) that each spin up a full
PGLite engine + `HostTarget` + web server. And a razor-thin true-e2e tip: only
**three files boot QEMU** (`examples.test.ts`, `egress-e2e.test.ts`, and one
describe in `gondolin.test.ts`), with essentially *all* broad real-VM coverage
consolidated into `examples.test.ts` driving the 21 workflow dirs.

The integration tier is doing work that in a classic pyramid would be split
between unit and e2e — which is a reasonable adaptation to the fact that the
*only* thing below the integration line is a micro-VM boundary (there is no
host-execution mode), but it concentrates risk (below) and accrues redundancy.

### Coverage by architecture layer

- **Strong, multi-tier:** `compiler/` (15 files, 6 property-based — the best-tested
  layer by far), `spec/`, `runtime/` (deep durability coverage), `egress/`
  (`agent-egress.test.ts` is the model adversarial file), `web/` server/SSE
  (9 files), `actions/`, `scaffold/`.
- **Thin / tested at the wrong altitude:** `targets/gondolin` — the single most
  security-critical, complex module — has only arg-building unit tests plus one
  VM smoke; its real VM behavior is verified almost entirely *indirectly* through
  `examples.test.ts`. No dispose/timeout/crash-on-real-target coverage exists
  anywhere (the crash contract is tested only against fake `CrashingTarget`
  doubles).
- **Untested:** `src/web/client.ts` (the entire 63 KB embedded frontend — expected,
  but it's the largest single UI artifact), `src/errors.ts` / `main()` error
  printing, the live-TTY TUI presenter wiring.

---

## Where confidence actually comes from (and where it doesn't)

The mocking boundary is drawn honestly. What's **real**: the durable journal
(PGLite, cross-restart), the HTTP server + webhook HMAC/bearer auth, the egress
resolver logic and key/secret scoping, the scheduler's clock seam. What's
**doubled**: the execution target (`HostTarget` for ~all runtime/web tests), and
the agent runner (a stub `AgentRunner` — the documented seam).

Two fidelity gaps in the doubling are worth naming precisely:

**1. The `HostTarget` double doesn't model the guest/host path divergence.**
`GondolinTarget.workspacePath` is a *fixed guest path* (`/workspace`) with the
host workdir mounted there; `HostTarget.workspacePath` is the host temp dir
itself (`_support.ts:56`). Any bug that depends on the guest path differing from
the host path — output capture under the fixed mount, checkout staging, agent
`cwd` — is invisible to every integration test and surfaces only in the
QEMU-gated examples. This is the highest-leverage masking risk in the suite.

**2. No automated test drives real model inference end-to-end.** The
agent-runner rule ("never mock the agent runner") is **honored** — the *seam* is
stubbed (allowed), the real `GuestPiRunner` install/wrapper/usage-extraction is
tested against a fake Pi SDK, and the key-never-enters-guest property is verified
on a real VM (`egress-e2e.test.ts:103`). But note the consequence: even the
real-VM `agent-project` review example runs the mock runner (no inference), as
its own YAML comment states. Real inference is exercised **only** by
a manual `work run review` against the live `work.json` — never in `npm test`.

Combine these with the CI/skip story and the trust gap becomes concrete:

> A fast/slow split exists (`npm run test:unit` sets `WORK_SKIP_VM=1`), but it
> is under-surfaced — not in `npm run check`, not a CI job, not in AGENTS.md.
> And on any host without QEMU, plain `npm test` **self-skips all VM coverage
> and still exits green.** CI does install QEMU and run the full tier as the hard
> gate (good), but the local signal is misleading. A passing `npm test` on a
> no-QEMU dev box is not evidence the VM/agent path works — which is the entire
> reason a real run exists.

Speed itself is not a problem: pure unit tests are ~0.1s/file, `tsc --noEmit` is
sub-second, no test hits a live LLM (all use injected runners + `sk-test`
dummies), and ~4% of files (3/70) carry essentially 100% of the VM cost. The
friction is the *serial single-process* full run (`--test-isolation=none` — one
hang stalls everything) and the under-surfaced fast tier, not raw slowness.

---

## The property-based layer

Genuinely high-value, not ceremonial. 29 properties across 8 files (all pure,
all in the fast tier). It has **found a real bug** (`cellId` leaked unsanitized
matrix keys into path-unsafe leg ids — fixed at `matrix.ts:87`, pinned as the
suite's one regression seed) and **driven a real security fix** (`walkPath`
prototype-chain read on attacker-controlled webhook `event` → `Object.hasOwn` at
`expr.ts:281`). The anti-tautology discipline is real: the condition engine uses
algebraic laws (De Morgan, double-negation) rather than a mirror-oracle that
would re-encode the bug, generators make hard constraints structural (no
`.filter`), and the findings log records *mutation-checking each property* and
even documents equivalent mutants. That is the discipline most PBT suites skip.

It has since spread beyond `compiler/` into `egress/` — the highest-leverage
gap this review flagged, **egress allowlist ↔ secret-scope host derivation
(`S-3`), landed in #27** (`test/egress-scope.property.test.ts`, 4 properties)
and caught a real security bug in the process (`F-8`: a `*` in a URL host is not
escaped by gondolin's `matchHostname`, so it widened both the reachable hosts and
the host a credential was injected for; now refused fail-closed in both
derivation seams). That validates the approach — a flagged invariant became a
property test that found a live bug. The remaining highest-value gaps:

- **`${{ }}` resolver dispatch** (`resolveNeeds`/`resolveSteps`/`resolveEvent`):
  the two-phase "defer-don't-error when context absent, throw on unknown root"
  contract is only example-tested today. Now the top untouched surface.
- **Spec parser totality**: no property test touches the YAML→`WorkflowSpec`
  parser; the classic "either a valid spec or a typed `WorkflowParseError`,
  never an untyped throw" property is missing.

Minor existing-test nits: `numRuns` is the default 100 everywhere (the
security-critical files would benefit from 1000+ at no real cost), the `F-7`
path-confinement near-miss counterexample is described in the doc but not pinned
as a regression case, `path-confinement` P3 tests an *inline re-implementation*
of the reusable-namespacing code rather than calling the real function, and
`expr-path.property.test.ts:88-94` asserts nothing beyond no-throw.

---

## Coverage blind spots, prioritized (security & durability first)

1. **`tick` aborts the whole loop on one bad schedule — a real bug.**
   `dueSlot` constructs `new Cron()` which throws on a malformed expression
   (`due.ts:25`), and `tick` has no per-item try/catch (`scheduler.ts:50-57`).
   One malformed cron — or one throwing `dispatch` — silently starves every later
   schedule. Untested. For a fleet-ops tool this is the highest-priority item.
2. **Observability error path is unguarded.** No test that a failing exporter or
   malformed hook payload doesn't crash the run — the layer's defining invariant
   ("telemetry must never take down the workflow") has zero coverage; only the
   disabled-no-op path is tested.
3. **Webhook dedup TTL** expiry and restart-non-durability (the defining
   behavior of the in-memory TTL map, `server.ts:169`) is unverified.
4. **Real-target failure/dispose/timeout** never covered — see the targets gap
   above.
5. **`web-resume.test.ts` doesn't actually exercise resume-from-checkpoint** — it
   seeds a zombie row but no durable journal, so the run re-executes from scratch
   and the test would pass equally if resume were a full re-run. Either seed a
   partial journal or soften the docstring.
6. **`conditional-steps` e2e can't distinguish skipped-vs-run** —
   `examples.test.ts:119` asserts only `status:"success"`, so the entire point of
   the example (a step was *skipped*) is unverified at the e2e tier.
7. Smaller: `--no-global` config-layer *selection* (merge is covered, selection
   isn't); scheduler `MAX_COALESCE` boundary; webhook audit rows for
   `too_large`/`bad_request`; composite/action *failure* propagation.

---

## Redundancy & maintainability (cheap wins)

- **Reusable workflows are tested at three layers + examples**;
  `reusable-runtime.test.ts` mostly re-asserts compile-layer structure already
  proven in `reusable.test.ts`. Trim to runtime deltas only.
- **"Survives engine restart"** is the same copy-pasted open→write→close→reopen
  template in three files (`persistence-runs`, `run-events`, `cli-run-events`);
  **"merge preserves other keys"** likewise in three (`config-merge` + two
  scaffold tests that should assert only their own generated section).
- **`examples.test.ts` success-only re-runs** of matrix/conditions/inputs/toposort
  add VM-smoke value but no new *semantic* assertion over the unit+property tiers.
- **Three+ divergent SSE readers**, two byte-for-byte duplicates (`collectSse` in
  both `web.test.ts:211` and `webhook-receiver.test.ts:303`); `postHook` and the
  ECHO/INCIDENT YAML fixtures copy-pasted across ~4 files. These belong in
  `_support.ts`.
- **Stale status comments** (a project-rule violation): `durable-resume.test.ts:14`
  and `:97` say the run ends "failure" while the actual assertion is
  `status === "interrupted"`. Scrub.
- **Brittle human-output matching**: `cli-runs.test.ts:45` (exact column layout +
  hint phrasing), `graph.test.ts` (mermaid/dot node-id spacing),
  `compiler.test.ts:85` (implicit-runs-on warning prose — **verify it still fires
  under this branch's `work:base`-default change**). Prefer the JSON-format
  assertions (`graph.test.ts:67`) as the model.
- **Tests that don't test their names**: `scaffold-webhook.test.ts:163`
  ("requires --workflow" — body tests the happy path). Also one dead
  commented-out parallelism test at `integration.test.ts:135`
  duplicating `run-concurrency.test.ts`.

---

## Recommendations

**P0 — close the trust gap (make the green/real divergence structural, not tribal):**
- Promote the fast tier: add `test:unit` to `npm run check`, document it in
  AGENTS.md as the dev inner loop, and add a fast CI job that gates *before* the
  VM job.
- Make a no-QEMU `npm test` *loud*, not silently green — print a prominent skipped
  summary (or a distinct exit annotation) so a passing run on a no-QEMU box is
  never mistaken for full coverage.
- Fix the scheduler `tick` bug (per-item try/catch) and add the malformed-cron /
  throwing-dispatch test. This is a behavior fix, not just a coverage gap.

**P1 — raise the floor on the thin/high-risk areas:**
- Add the observability exporter-failure test (telemetry-never-crashes-the-run).
- ~~Add the egress host-derivation property test (`S-3`)~~ — **done in #27**;
  the next PBT gap is `${{ }}` resolver dispatch (defer-don't-error / throw-on-
  unknown-root), then spec-parser totality.
- Add real-`GondolinTarget` dispose/timeout/crash coverage, or explicitly
  document that this confidence lives in a real run and accept it.

**P2 — trim and de-brittle (mechanical, low-risk):**
- Hoist the SSE readers / `postHook` / shared YAML fixtures into `_support.ts`.
- Trim the reusable-runtime and persistence-restart redundancy to deltas.
- Scrub the stale `durable-resume` comments; fix the two mis-named scaffold tests;
  pin the `F-7` counterexample; tighten `expr-path` P3/P4; bump `numRuns` on the
  security property files.

The through-line: the suite's *foundations* are strong and don't need rework. The
work is (a) making the line between "green" and "actually proven" impossible to
miss, (b) fixing the one real bug the audit turned up, and (c) paying down a
modest, well-localized redundancy/brittleness debt before it compounds.
