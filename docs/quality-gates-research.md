# Quality gates research — do our checks actually catch problems?

*June 2026. Question: are `npm test`, `lint`, `typecheck`, `knip`, and `fan-in`
really helping, and what better programmatic means exist for code smells and
security issues?*

Method: ran every gate against the current tree, measured unit-mode coverage with
`node --test --experimental-test-coverage`, ran a **9-mutation spot-check**
(introduce a plausible bug, run `test:unit`, record caught/survived, revert), and
audited the test suite's assertion depth and the security-sensitive surface.
Empirical results below were measured, not estimated.

## 1. What each gate is, and what it structurally cannot see

| Gate | What it catches | Structural blind spot |
|---|---|---|
| `typecheck` (tsc, `strict` + `noUncheckedIndexedAccess`) | type errors, nullability | runtime behavior; anything typed `unknown` / `Record<string, unknown>` (the gondolin interop layer is necessarily full of these) |
| `lint` (eslint, **non-type-checked** recommended preset) | syntax-level smells, unused vars | everything needing type info: floating promises, unsafe `any` flow, mis-`await`ed values |
| `knip` | dead exports, unused deps | dead *branches* inside live functions; exports kept alive only by tests |
| `fan-in` (report-only) | coupling distribution, god objects | by design not a gate; nobody fails on it |
| `test` / `test:unit` | behavior — see §2/§3 | anything on the far side of the `ExecutionTarget` boundary — see §3 |
| eslint `complexity: ["warn", 20]` | creeping complexity | warn-only: CI is green regardless, so it's only seen by someone reading logs |

All gates pass clean today. CI (`.github/workflows/ci.yml`) runs lint + typecheck +
knip + fan-in, then the **full** suite with QEMU — but note `WORK_TEST_NETWORK` and
`WORK_TEST_IMAGES` are never set anywhere, so the network examples (`checkout`,
`install-node`) and image builds are skipped in CI too (`test/examples.test.ts:27-34`).
That matters more than it sounds — see §4.

## 2. The test suite has real teeth — mutation spot-check

398 tests, ~10.5s in unit mode (`WORK_SKIP_VM=1`). Coverage: **91.3% line / 83.9%
branch** overall. But coverage measures *execution*, not *verification* — so we
mutation-tested: 9 hand-picked plausible bugs, one at a time, against `test:unit`.

| Mutation | Site | Result |
|---|---|---|
| matrix `exclude` inverted (keeps excluded cells) | `src/compiler/matrix.ts:48` | **CAUGHT** (1 fail) |
| cycle detection disabled | `src/compiler/compile.ts:234` | **CAUGHT** (1 fail) |
| `if:` equality operator flipped | `src/compiler/condition.ts:385` | **CAUGHT** (16 fails) |
| failed deps no longer skip dependents | `src/runtime/absurd/runtime.ts:331` | **CAUGHT** (2 fails) |
| `needs.*` outputs dropped | `src/runtime/absurd/runtime.ts:311` | **CAUGHT** (3 fails) |
| webhook bearer auth always passes | `src/web/server.ts` `constantTimeEqual` | **CAUGHT** (2 fails) |
| webhook HMAC auth always passes | `src/web/server.ts` `verifyHmacSha256` | **CAUGHT** (2 fails) |
| model API key never injected | `src/agent/egress.ts:80` | **CAUGHT** (1 fail) |
| guest secret env dropped in `provision()` | `src/targets/gondolin.ts:139` | **SURVIVED** (398 pass) |

8/9 caught, including both webhook auth bypasses and the key-injection drop. The
compiler/runtime/web layers are genuinely verified, not just executed — the suite
is pulling its weight where it runs.

The survivor is the story. It wasn't bad luck; it was picked as a control for the
one structural gap: **code on the far side of the target boundary**. Deleting
`...secretEnv` from the VM's env in `GondolinTarget.provision()` — the host↔guest
secret wiring — changes nothing in any automated tier. `egress-wiring.test.ts`
verifies the contract *up to* the target (the right hosts/secrets are handed over);
nothing verifies the target *honors* it.

## 3. Where green tests would let a real bug through

Per-subsystem depth (from auditing all 47 test files):

| Layer | Depth | Notes |
|---|---|---|
| spec / compiler (expr, condition, matrix, inputs) | **strong** | exhaustive error cases; confirmed by mutations |
| runtime orchestration (happy path + failure propagation) | **moderate** | ordering, skip/output threading covered; no timeout/signal/journal-corruption cases |
| egress (config → target contract) | **moderate → strong** | contract spied at the boundary; the *mediated* path (key isolation) now verified e2e by `egress-e2e.test.ts` (§5.1) |
| web server / webhooks | **moderate** | auth paths genuinely tested (mutations caught); no concurrency/race coverage |
| GondolinTarget / VM behavior | **weak** | 2 files VM-gated; smoke-level (`gondolin.test.ts` runs hello-world) |
| agent (real Pi runs) | **weak in-suite** | runner mocked in tests *by design* (project rule: verify via `demo.sh` + real runs instead) |

Concrete gaps where everything stays green:

1. **Host↔guest wiring** — the surviving mutation. Env propagation, secret
   placeholder injection, exit-code mapping, `allowedHosts` enforcement inside
   `src/targets/gondolin.ts:106-195` (54% line coverage, the uncovered half is
   exactly `provision()`/`run()` internals).
2. **Mediated egress end-to-end** — *was* the headline gap (key isolation had
   **zero** automated verification; the only egress-touching examples sat behind
   `WORK_TEST_NETWORK=1`, which no CI job set). **Now closed** by
   `egress-e2e.test.ts` (§5.1) for the single-secret/single-host case, and
   `WORK_TEST_NETWORK=1` is enabled in CI's full-suite job. Remaining: multi-host
   scoping is still unverified.
3. **Exit-code fidelity** — only exit 0/1/3 appear in tests; nothing pins
   exit 255, signal death (SIGKILL/SIGTERM), or timeout behavior.
4. **Concurrency** — `orchestrator.test.ts` runs one test at `maxConcurrency: 1`;
   no test demonstrates two independent jobs actually overlapping, and the web
   server has no concurrent-dispatch test.
5. **Stale status comment** — `test/durable-resume.test.ts:9-10` still says the
   test "is expected to fail until the runtime uses Absurd's resume more fully",
   but it passes (398/398). Per our own convention, that header needs scrubbing
   — and it means whole-workflow resume may be *more* done than `docs/phase-1.md`
   claims.

## 4. Security surface — what's guarded, what's unwatched

The design is sound where we looked: loopback-only bind + Host-header check +
CSRF token (`src/web/server.ts:226-260`), constant-time webhook auth over
fixed-length digests (`server.ts:923-948`), `${{ }}` is a hand-rolled tokenizer/
parser with no eval (`src/compiler/expr.ts`, `condition.ts`), strict `$VAR`
expansion for keys/tokens, and host-side `spawn`/`execFile` calls take only
engine-generated arguments (`src/images/build.ts:44`, `src/doctor/checks.ts:266`).
The mutation results back this up — the auth paths are tested, not just present.

A note on what the egress system *is*: it is **not** a general network sandbox.
Bare `run:` steps (no `uses:`/datasource) have open outbound network by design —
that's how `npm install` works, and workflows are author-trusted (the GitHub
Actions threat model). What egress mediation actually buys is **secret isolation**:
the real model/datasource key is injected host-side, scoped to its host, so it
never enters the guest where the agent could read it. That property — now pinned
by `egress-e2e.test.ts` (§5.1) — is the one that matters; "deny-by-default" is
about *which secrets/datasources a job is scoped to*, not blanket network denial.

What no gate or test currently watches:

- **Secret-injection scoping** beyond the one e2e case — the host-side swap is
  verified for a single allowed host; multi-secret / multi-host scoping is not.
- **Permissive-by-design agent egress** — any job with a `uses:` step gets
  `allowedHosts: ["*"]` (`src/agent/egress.ts:64`), even a composite wrapping
  only `work/checkout`. Documented, deliberate (and consistent with the
  open-egress-for-trusted-steps model above); flagged here only for completeness.
- **Secrets in persisted history** — step stdout/stderr and webhook payloads land
  in `.workflows/db/` run history verbatim. A workflow that `echo $TOKEN`s leaks
  into durable history; nothing scans or redacts.
- **Dependency vulnerabilities** — no `npm audit`/osv scan anywhere; runtime deps
  use caret ranges (only `absurd-sdk` is pinned); the two `@earendil-works/*`
  optional deps are the most security-critical and float on `^`.
- **Committed secrets** — `work.json` (real keys, gitignored) lives one
  `git add -f` away from history; no gitleaks/secret-scan hook.
- **Static security analysis** — no semgrep/CodeQL tier at all. (CodeQL needs
  GitHub Advanced Security on a private repo; semgrep OSS does not.)

## 5. Recommendations, ranked by expected catch-rate per unit effort

### 5.1 Close the boundary gap with a hermetic egress e2e test (highest value) — DONE

Shipped as `test/egress-e2e.test.ts` (VM tier, `vmTestSkip()` gating). It boots a
real VM whose "model host" is a recording HTTP server on a **host LAN interface
IP** (not loopback — see the resolved caveat below) and asserts the MEDIATED
contract: (a) the guest env holds a placeholder, never the real secret; (b) a
request to the allowlisted host arrives upstream with the real secret swapped in
host-side; (c) for a mediated job (allowlist set), a non-allowlisted host is
refused and never dialed. Kills mutation M9's whole class — the host↔guest secret
wiring is now verified, not just designed.

**Writing it clarified what "deny-by-default" actually means here — and corrected
a misleading comment.** An early draft also asserted "a bare job has no network."
That's false, and deliberately so: a job with no `uses:`/datasource (e.g. a plain
`run: npm install`) has **open outbound egress** — that's how it reaches the
registry, and the flagship `agent-project/ci.yaml` example depends on it. The
`gondolin.ts` comment had overstated this as a "deny-by-default posture" for bare
jobs; in reality "deny-by-default" applies to the egress *resolvers* (a job
doesn't get the model host + injected key, or a datasource, unless scoped) — not
to general network access for trusted steps. The comment is now corrected to say
exactly that. The valuable, real security property — the API key never enters the
guest — is what the test pins.

Resolved caveat: gondolin egress can't target host **loopback** from inside the
guest, but it *can* reach a host LAN IP (traffic egresses through gondolin's
host-side stack). Private ranges are blocked by default even when allowlisted, so
the test also threads a new `allowedInternalHosts` passthrough on
`GondolinTargetConfig` → `createHttpHooks` (purely additive — it widens access for
on-box upstreams; it restricts nothing).

### 5.2 Make the mutation spot-check a recurring, scripted tier — DONE

Shipped as `scripts/mutation-check.mjs` (`npm run mutation`), in the dependency-
light `fan-in.mjs` mold: a curated table of 14 mutations across compiler /
runtime / web-auth / egress, each planted and run against `test:unit`. Unlike
fan-in it has a real pass/fail, so it exits non-zero on a SURVIVED mutation (a
test gap) or a STALE find-string (the table drifted from the code). Safety: each
file is restored from an in-memory copy (not `git checkout`, which would wipe
unrelated edits), a dirty file is skipped rather than touched, and a crash/Ctrl-C
restores every pending file on the way out. `node scripts/mutation-check.mjs <id>`
runs one. Seed table = the experiment from §2 plus host-header/CSRF/datasource
cases. Wire into CI as report-only first (allow it to fail soft) until the table
settles, then make survivors blocking.

Deferred alternative — **StrykerJS** with the `command` runner: exhaustive and
finds gaps humans don't think of, but ~11s × hundreds of mutants, a real config
surface, and node:test + type-stripping is off its beaten path. Revisit only if
the curated table keeps missing survivors.

### 5.3 Turn on type-aware lint for the bug classes tsc misses

Switch `tseslint.configs.recommended` → `recommendedTypeChecked` (plus
`projectService: true`). The payoff rules for *this* codebase:
`no-floating-promises` and `no-misused-promises` — a durable runtime orchestrating
jobs over async boundaries is exactly where a dropped promise silently loses a
failure. The `no-unsafe-*` family will be noisy at the gondolin/absurd interop
edges; disable those per-file rather than globally. Expect a one-time cleanup;
lint gets slower (type info) but stays well under the test suite's 10s.

### 5.4 Cheap security automation in CI

In rough order of value:

1. **`npm audit --omit=dev` + osv-scanner** as a CI step (non-blocking at first;
   block on high/critical once the baseline is clean). Near-zero setup.
2. **gitleaks** (or `trufflehog git`) as a CI step and optionally a pre-commit
   hook — directly targets the `work.json`-near-history risk.
3. **Pin the security-critical deps**: `@earendil-works/gondolin` and
   `@earendil-works/pi-coding-agent` to exact versions (they *are* the sandbox);
   bump deliberately. `npm ci` + lockfile already protects CI, but exact pins
   make upgrades a reviewed diff rather than an install-time surprise.
4. **semgrep** with `p/typescript` + `p/nodejs` rulesets, report-only. Expect
   modest yield (the mutation results suggest the obvious injection/crypto
   mistakes aren't present) — its value is catching *future* regressions in
   `server.ts`/`egress/`. Skip CodeQL unless the repo goes public or gets GHAS.
5. **A redaction pass** on persisted step output (`src/persistence/runs.ts`):
   scrub strings matching configured secret values before they hit run history.
   This is a code change, not a gate, but it's the only fix for §4's
   secrets-in-history exposure.

### 5.5 Tend the existing gates

- **Coverage as a visible report, not a gate**: add a `coverage` script
  (`--experimental-test-coverage`) and print the summary in CI next to fan-in.
  Gate later, if ever — 91%/84% is already healthy, and the missing risk (VM
  paths) is structural, unreachable by threshold-chasing.
- **The `complexity` warning is write-only.** Either ratchet it (error at the
  current max so it can only improve) or accept it's decorative.
- **Scrub the stale header** in `test/durable-resume.test.ts` and re-check the
  matching "Known limitations" claims in `docs/phase-1.md` — the gate caught up
  with the docs.
- `knip` and `fan-in` are doing their jobs as-is; no change.

## 6. Bottom line

The gates are *not* theater: 8/9 plausible bugs — including two webhook auth
bypasses and a dropped API-key injection — turn the suite red in 11 seconds. The
suite's verification strength closely tracks its architecture: everything up to
the `ExecutionTarget` boundary is well-verified; everything past it (the actual
VM: env wiring, secret injection, egress enforcement, exit-code fidelity) is
smoke-tested at best and unwatched in CI. The highest-leverage moves are the
hermetic egress e2e test (5.1) and a recurring curated mutation check (5.2);
type-aware lint and the CI security steps (5.3/5.4) are cheap follow-ons.
Generic "code smell" tooling beyond that would mostly re-flag what `fan-in`
already shows.