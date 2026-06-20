# Walk back the egress theater; broker secrets through `work.json`

**Status:** IMPLEMENTED (Slices A + B). Egress is open for every job
(`src/agent/egress.ts`) and `${{ secrets.* }}` resolves from a `work.json`
`secrets:` whitelist at runtime (`src/compiler/expr.ts`, `src/config/index.ts`,
`src/run.ts`, `src/runtime/absurd/runtime.ts`), covered by `test/secrets.test.ts`
and validated on a real gondolin VM (a pure `run:` job reached the network and read
a secret in-guest). §4c is decided; §6 Slice C (`work create secret`) and §7's
nice-to-haves remain. The companion to
[`secrets-management-and-injection.md`](secrets-management-and-injection.md): that
doc covers *acquiring* a secret from an external store; this one covers two
decisions — **(1) stop walling egress on jobs**, and **(2) let `work.json` whitelist
host secrets that flow through to the guest as `${{ secrets.* }}`.** Read
[`egress-data-path.md`](egress-data-path.md) first — the dial-path invariants are
assumed here.

---

## 1. The two decisions

1. **Drop deny-by-default egress.** Agent jobs already get allow-all egress
   (`src/agent/egress.ts:59`), and any job with a `work/checkout` step does too.
   The wall only ever dead-ends the one shape operators reach for first — a pure
   `run:` job — while doing nothing the agent boundary relies on. **What actually
   keeps a provider token out of a guest is the host-side header-swap, not the
   egress allowlist.** So the allowlist on `run:` jobs is theater: open egress for
   every job and delete the ceremony.

2. **Broker secrets through `work.json`.** A `secrets:` block — shaped like
   `datasources:` — whitelists which host secrets a workflow may address as
   `${{ secrets.NAME }}`. Each value is either plaintext or an `$ENV` reference (the
   same `$FIREWORKS_TOKEN` / `$GRAFANA_TOKEN` pattern already used for model
   `apiKey` and datasource tokens). Whitelisted secrets flow through to the guest;
   anything not listed is unaddressable. This is the missing piece that makes
   `aws` / `gcloud` / `kubectl` usable (§3).

The non-negotiable we keep: **the model/datasource header-swap path is untouched.**
That is the mechanism that keeps provider tokens out of agent calls, and it stays
exactly as-is. We are removing a redundant wall, not the real control.

---

## 2. Why the egress wall is theater (VALIDATED)

Egress is granted by a `resolveJobNetwork` callback the runtime forwards to the
target. Two resolvers compose as a **union** (`src/run.ts:163`, `composeResolvers`):

| Job shape | Egress today | Where |
|---|---|---|
| Any step is `work/*` or `action/*` (incl. `work/checkout`, `work/install-node`, `work/agent`) | **allow-all** (`allowedHosts: ["*"]`) | `src/agent/egress.ts:57-59` |
| `run:`-only, with scoped `datasources` | scoped to those datasource hosts + header-injected token | `src/egress/datasource.ts:88-128` |
| `run:`-only, no datasources | **fully denied** | `src/agent/egress.ts:57` returns `undefined` |

Three facts, stated plainly, dismantle the security story for the deny wall:

1. **A job that checks out code already has the whole internet.** `work/checkout`
   is a `uses:` step, so the job gets `["*"]`. The *only* job that gets nothing is
   the rare pure-`run:` job — exactly the first thing an operator writes.
2. **Agent jobs already have the whole internet.** `work/agent` → `["*"]`. The wall
   is not what stops an agent exfiltrating the provider key.
3. **The host-side header-swap is what isolates the token.** The real value never
   enters the guest; Gondolin swaps a placeholder into the `Authorization` header
   for one host and blocks it elsewhere (`src/targets/gondolin.ts`;
   `src/agent/egress.ts:10-18`). Egress scoping is belt-and-suspenders on top.

And the cost of the wall is real: **a control strict enough that people route
around it has negative security value** — the work moves from an isolated micro-VM
to the operator's unsandboxed laptop ("fuck it, I'll just run bash on my host").
We made the secure path the annoying path. Dropping the wall keeps the work *inside*
the VM, which still isolates the host — its actual job.

---

## 3. Why datasources can't cover the CLIs people want (VALIDATED)

Datasources inject a token as an **HTTP header**, host-side
(`src/egress/datasource.ts:118`; `tokenHeader` defaults to `Authorization`). Great
for bearer APIs (Grafana, Slack, an internal REST service). Useless for the CLIs
that drive real infra work:

- **AWS SigV4** signs each request with the secret key *in the client* — you can't
  header-swap a signature computed from a key you're withholding.
- **`gcloud` / GCP** — client-side signed JWT / ADC, same constraint.
- **`kubectl`** — client cert (mTLS) or a token the client reads from a kubeconfig.

For all of these the host's only useful role is allow/deny the connection; the CLI
signs in-guest with the in-guest credential. The credential must be *in the guest*.
That is the `secrets:` passthrough (§4), not header-swap.

---

## 4. The design

### 4a. Egress: allow-all for every job

Make the egress resolver return `{ allowedHosts: ["*"] }` for every job (still
computing the per-host model-key `secrets` for agent steps exactly as today). Pure
`run:` jobs stop being dead-ended; nothing about the agent path changes because it
was already allow-all. Deny-by-default and the `undefined`-means-blocked branch go
away.

Datasources do **not** go away — they remain the **header-swap** broker for a token
you want *never in the guest* (path a). With egress open, a datasource's host
*allowlisting* is moot, but its host-scoped token injection is still the strong
path for "call this API with a credential the workload never sees."

> A future `egress:` *narrowing* knob (let a security-conscious operator bound a
> job — even an agent job — to a host list) is **out of scope here**. The decision
> now is to remove the wall, not to rebuild it as opt-in. Capture it in §6 as a
> later nicety, not a launch requirement.

### 4b. Secrets: a `work.json` passthrough whitelist

Shaped like `datasources:` — keyed entries, value plaintext or `$ENV` reference:

```jsonc
{
  "models": { /* … */ },
  "datasources": { /* … unchanged … */ },

  "secrets": {
    "AWS_ACCESS_KEY_ID":     "$AWS_ACCESS_KEY_ID",      // env ref, like the fireworks/grafana tokens
    "AWS_SECRET_ACCESS_KEY":  "$AWS_SECRET_ACCESS_KEY",
    "DEPLOY_PAT":             "ghp_xxx"                  // or an outright plaintext value
  }
}
```

- **`work.json` is the proxy/whitelist.** Only names listed under `secrets:` are
  addressable. A workflow can't reach a host env var the operator didn't expose;
  the file is the explicit, auditable boundary between "secrets on the host" and
  "secrets a guest may see."
- **Addressed as `${{ secrets.NAME }}`** anywhere an expression is allowed —
  step/job/workflow `env:`, a `run:` body, a `with:` input. The compiler gains a
  `secrets` expression root mirroring `inputs` (companion §6b).
- **Resolved at runtime, never at compile time.** The value must not land in
  `PlannedStep.env`/`.run`, the Absurd/PGLite store, or a plan dump (companion
  §6b/§7). Resolve just-in-time and inject into the guest env for the referencing
  step only.
- **`$ENV` expansion reuses `expandEnv`** (`src/config/index.ts`) — the
  secret-zero stays in the host environment, never committed; `work.json` is
  already gitignored.

This is path (b) from the companion doc (value genuinely in-guest), now with a
first-class source instead of a hardcoded literal. It's the right and only tool for
the client-signing CLIs of §3.

### 4c. Agents may reference secrets — by intent (DECIDED)

The model/datasource credentials an **agent** uses still ride header-swap and never
enter its guest — unchanged, automatic, no operator action. The new `secrets:`
passthrough is a *separate*, operator-whitelisted set (your `aws` keys, a deploy
PAT) meant chiefly for `run:` steps.

**Decision: `${{ secrets.* }}` is referenceable anywhere expressions are allowed,
including inside a `work/agent` step.** Reaching one there is two deliberate acts —
whitelisting it in `work.json` *and* referencing it — so it's the operator's
intentional call, not a footgun the engine should pre-empt with a compile error. No
new ceremony.

This doesn't weaken the property we care about: the model key an agent uses is
isolated by header-swap regardless, and a secret only reaches an agent when an
operator explicitly hands it over. Docs should still present the datasource
**header-swap** path as the *recommended* way to give an agent a credential it
shouldn't see in plaintext (path a) — but referencing `secrets.*` from an agent step
is a supported, intentional choice when in-guest is genuinely what you want.

---

## 5. Trade-offs accepted (stated honestly)

- **Open egress + in-guest secret = the standard CI trust model.** A compromised
  transitive dependency in a `run:` step could read a `${{ secrets.* }}` value and
  POST it anywhere. GitHub Actions / GitLab CI / Buildkite all expose secrets as
  plain env to author-controlled steps with open network — we are not weaker than
  the tools operators already trust with these exact credentials.
- **The VM still isolates the host.** Filesystem, processes, kernel — the micro-VM's
  primary job — are unchanged. The secret is scoped to one job's guest and dies
  with the VM.
- **The strong path is still there, and still default for agents.** Anything you
  *don't* want in a guest goes through datasource/model header-swap (path a). The
  `secrets:` passthrough is the explicit opt-in for the cases that genuinely need
  the value in-guest.

Net: we trade a wall that pushed people to *less* isolation (host bash) for an open
but host-isolated VM. In practice that's a security improvement, even though one
default got more permissive on paper.

---

## 6. Slices & deferred

- **Slice A — drop the wall (small, no spec change).** Egress resolver returns
  allow-all for every job; remove the deny-by-default branch
  (`src/agent/egress.ts:57`). Keep model-key secret injection. Pure-`run:` jobs now
  reach the network. Validate on a real VM (§7).
- **Slice B — `secrets:` passthrough.** Parse `secrets:` in `work.json`
  (`src/config/index.ts`, already tolerant of unknown keys); add the `secrets`
  expression root (`src/compiler/expr.ts`, mirror `inputs`); resolve at runtime and
  inject into the referencing step's guest env (`src/runtime/absurd/runtime.ts`).
  Decide §4c.
- **Slice C — ergonomics.** `work create secret <name>` merges a `secrets.<name>`
  entry via the config-merge writer (like `create datasource`); docs/templates show
  the `aws`/`kubectl` happy path; `*.example.json` documents the block.
- **Deferred — optional `egress:` narrowing.** A host-allowlist knob (incl. for
  agent jobs) for operators who want defense-in-depth. Explicitly *not* part of
  walking back the wall; revisit only if asked.

Each slice is independently shippable and additive.

---

## 7. Open questions

> §4c — whether `${{ secrets.* }}` may be referenced inside a `work/agent` step — is
> **decided: yes, by intent** (see §4c). The items below remain.

1. **Plaintext vs `$ENV`-only in `work.json`.** Allow literal plaintext values
   (decided: yes), or force `$ENV`/store references to discourage committing
   secrets? `work.json` is gitignored, so plaintext is contained — but a plaintext
   value is one careless `git add -f` from exposure. Lean: allow plaintext,
   lint/doctor warns.
2. **Resolution sites.** Confirm `${{ secrets.* }}` is allowed in `env:`, `run:`,
   `with:` — and deliberately **not** in `if:`/conditions (companion §6b: a
   condition mustn't branch on a secret and leak it via skip patterns).
3. **Validate against a real VM.** Egress/secret behavior must be checked on a real
   gondolin run — the `HostTarget` double implements neither the header-swap nor the
   deny wall (project rule). A `secrets:`-driven `aws`/`kubectl` happy-path e2e is the
   acceptance gate.
4. **Tailnet reachability is orthogonal.** Reaching `eks-prod.ts.net` means the
   *engine host* dials it after SNI re-resolution — kubectl-against-the-fleet needs
   the engine on the tailnet regardless of this design. "Egress is open" ≠ "the
   target is routable."

---

## 8. Key files

`src/agent/egress.ts:34-82` (the resolver; `:57` is the deny-by-default branch to
remove; model-key injection to keep); `src/egress/datasource.ts:1-130` (the
header-swap broker — stays; "the mechanism is fully generic and job-level");
`src/run.ts:118,163-165` (`composeResolvers` union); `src/targets/gondolin.ts`
(header-swap, value never in guest); `src/config/index.ts` (`expandEnv` `$ENV`
expansion, unknown-key tolerance — where `secrets:` parses); `src/compiler/expr.ts`
(where a `secrets` root slots, mirroring `inputs`); `src/runtime/absurd/runtime.ts`
(runtime resolution + step `env` already materializes in-guest — the path-b
plumbing exists);
[`secrets-management-and-injection.md`](secrets-management-and-injection.md) §6/§7;
[`egress-data-path.md`](egress-data-path.md).
