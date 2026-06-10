# Secrets Management & Injection: Research + Design

> Research for brokering secrets from external stores (Doppler, HashiCorp
> Vault/OpenBao, Infisical, cloud KMS, SOPS, …) into work
> (npm `@nullbytelabs/work`) jobs — "GitHub-Actions-style secrets," fetched at run
> time via a service account / OIDC and injected securely into sandboxed jobs. The
> spark was **Doppler**; since it's paid SaaS, this covers the OSS/self-hostable
> alternatives too.
>
> **Builds on** [`webhook-triggers-research.md`](webhook-triggers-research.md) §5/§9,
> which found that secret injection is already **job-level, not agent-level** — only
> the *resolver* is agent-gated. This doc generalizes that into a real
> secrets-provider layer. **No code written.** Consolidates five investigations
> (Doppler, Vault/OpenBao, the backend landscape, the OIDC/service-account auth
> model, and the engine integration). Tags: **VALIDATED** (our code, file:line) /
> **VERIFIED** (cited vendor/standard) / **PROPOSED** / **NEEDS-BUILDING**.

---

## 1. Thesis — the delivery is built; the acquisition is the work

The engine already has the *hard* part and it's the right shape:

- **A host-side "header-swap" broker (VALIDATED).** `GondolinTarget` takes a job's
  `secrets: { ENVNAME: { hosts, value } }`, and `createHttpHooks` keeps the **real
  value host-side**, swapping it into outbound HTTP headers **only for allowlisted
  hosts** — the guest sees only a placeholder env var, never the secret
  (`src/targets/gondolin.ts:50,106-116`; `src/agent/egress.ts:7-9,65-69`). This is
  *better* than GitHub Actions, which exposes secrets as plain env vars in the
  runner. The runtime forwards this verbatim and stays agent-agnostic
  (`runtime.ts:315`).

So the question isn't "how do we inject secrets" — it's **"where do the secret
*values* come from, and how does the engine authenticate to get them."** Today the
answer is just `$ENV` expansion (`src/config/index.ts:46,119`). The work is an
**acquisition layer**: a pluggable provider that fetches from a store via a
service-account/OIDC credential, and a `${{ secrets.* }}` context that rides the
existing header-swap injection — resolved **at runtime, never baked into the durable
plan**.

**And it's useful today** (§8): the smallest slice — letting a config `apiKey` be
`doppler://proj/cfg/OPENAI_KEY` instead of a raw value — lands on the *current* agent
product with no spec change, and an operator stops pasting keys into config or even
into `$ENV`.

---

## 2. The auth model — OIDC vs service accounts, and the honest laptop caveat

The user's interest is "OIDC or service accounts for programmatic secure access."
The clear-eyed finding:

**How OIDC federation actually works (VERIFIED).** A workload asks **its own trusted
OIDC issuer** for a signed JWT attesting its identity (GitHub Actions:
`token.actions.githubusercontent.com`, with `sub`/`aud`/`repo`/`environment` claims).
It exchanges that JWT at a backend's token endpoint (AWS `AssumeRoleWithWebIdentity`,
GCP Workload Identity Federation, Vault/Infisical/Doppler JWT auth); the backend
verifies the signature against the issuer's JWKS and checks `aud`/`sub` against a
preconfigured trust policy → returns **short-lived creds, no stored secret**. This is
the gold standard *because a trusted third party already attests the workload*.

**The hard truth for a local CLI (VERIFIED mechanics, INFERRED applicability):**
workload-OIDC needs an issuer that attests *the workload*. **A developer's laptop has
no such issuer** — nothing can sign "this is work on Josh's laptop" in a way a
backend would trust. So workload-OIDC federation **does not fit a local CLI**. What
*does* fit:
- **Interactive OIDC login** (auth-code + PKCE, or device grant) — opens a browser,
  authenticates *the human*, returns a short-lived token (how `op`/`gcloud`/`aws sso`
  work). A nicety, not unattended automation.
- For *programmatic* local use, the realistic primitive is a **scoped, revocable
  service-account / machine-identity token** — stored in the **OS keychain**, not a
  plaintext dotfile and not bare `$ENV`.

**The security gradient (VERIFIED), worst → best:**

| Tier | Mechanism | Where backends sit |
|---|---|---|
| 1 | Static long-lived API keys in env/files | cloud SA JSON keys; raw provider keys; **work today** |
| 2 | Scoped service-account / machine-identity tokens (TTL, usage caps, revocable) | Infisical MI, Doppler SA, 1Password SA, Vault AppRole |
| 3 | Short-TTL federated **OIDC** tokens (no stored credential, ~1h, audience-bound) | GitHub Actions → AWS/GCP/Vault/Infisical/Doppler-Identity |
| 4 | **Dynamic** per-use secrets (minted on demand, auto-revoked) | Vault/OpenBao dynamic engines |

**The "secret-zero" problem (VERIFIED):** every backend needs *one* credential to
fetch the rest. Mitigations: eliminate it with OIDC where an issuer exists; Vault
**AppRole response-wrapping** (single-use, tamper-evident `secret_id` delivery);
short-TTL/usage-capped bootstrap tokens; **OS-keychain** storage; hardware-backed
keys. work' current model (parent shell → `$ENV`) is "env-injection from an
orchestrator" — fine in CI, weak on a laptop.

**Per-deployment-shape posture (PROPOSED):**
- **(a) Local CLI** → scoped service-account/machine-identity token in the **OS
  keychain**; interactive OIDC login as a DX nicety. *Don't promise workload-OIDC
  here.*
- **(b) Long-lived server** (`--web`/webhook) → service account baseline; **JWT/OIDC**
  if it runs alongside an IdP / on a cloud instance / SPIFFE; Vault AppRole with
  wrapped `secret_id` otherwise.
- **(c) CI / cloud** → real **OIDC workload-identity federation** (the target
  end-state, zero stored secret).

**"GitHub Actions secrets" parity** = *both*: (1) static encrypted secrets injected at
runtime (our current model — the floor), and (2) OIDC to trade an attested identity
for short-lived creds (the upgrade). Mirror both: keep `$ENV` as the universal
fallback, add the provider abstraction whose best implementation is OIDC in CI/cloud
and a keychain-backed service account on the laptop.

---

## 3. Backend landscape + recommendation

Per-backend (VERIFIED unless noted), then a matrix and a pick.

- **Doppler** — polished SaaS, generous-ish free tier. **Service Tokens** (read-only,
  one project+config, **free**, the smallest revocable bootstrap) vs **Service
  Accounts** and **Service Account Identities (OIDC, issuer-agnostic)** which are
  **Team+ ($21/user/mo)**. SDK is a stale zero-dep REST wrapper → use `node:fetch`.
- **HashiCorp Vault** — feature-rich but **BSL-licensed** (not OSI). Prefer the fork:
- **OpenBao** — **MPL-2.0**, Linux Foundation, 2.5.0 GA (Feb 2026), API-compatible for
  the KV+auth subset. The OSS self-host pick. AppRole + JWT/OIDC auth; KV-v2 static
  secrets; **dynamic secrets** (a real superpower Doppler lacks). No official Node SDK
  (only Go/Ruby) → `node:fetch`. Self-hosting cost is real (storage, **unseal
  lifecycle**, TLS).
- **Infisical** — **the strongest Doppler alternative**: **MIT** core, self-host +
  free SaaS tier, **Machine Identities with OIDC/Universal auth in the FREE tier**
  (only human *SSO* is paid — a distinction worth stressing), clean first-party
  `@infisical/sdk`, project→env→path scoping that maps to our `$ENV` model.
- **Cloud KMS** (AWS Secrets Manager/SSM, GCP Secret Manager, Azure Key Vault) — IAM +
  **workload-identity federation** (IRSA / WIF / Entra Workload ID), official but
  **heavy** Node SDKs; the biggest supply-chain surface (recent npm worms targeted AWS
  credential harvesting). → optional, lazy-loaded power-user adapters.
- **1Password** — service accounts + `op://vault/item/field` refs; `@1password/sdk` is
  **v0 (WASM/Rust)**; **no free tier**. Fast-follow, not a launch backend.
- **SOPS + age/PGP** — file-based, **git-committable**, **no server**, fully free OSS;
  decrypt locally (key possession; KMS can delegate). The "no backend service" option.
- **Baseline** — `.env`/`$ENV` (current), `direnv`, OS keychain (note `keytar` is
  unmaintained).

| Backend | OSS/free | Self-host | OIDC/WIF | Machine-id / SA | Node SDK | REST-only OK | Injection |
|---|---|---|---|---|---|---|---|
| **Infisical** | ✅ MIT + free tier | ✅ | ✅ (free MI-OIDC; SSO paid) | ✅ | ✅ `@infisical/sdk` | ✅ | env; proj/env/path |
| **OpenBao** | ✅ MPL-2.0 | ✅ | ✅ JWT/OIDC | ✅ AppRole/JWT | ⚠️ community | ✅ | env/templated; KV path |
| Vault | ⚠️ BSL | ✅ | ✅ | ✅ | ⚠️ community | ✅ | same |
| **Doppler** | ❌ SaaS (free tier) | ❌ | ✅ (Team+) | ✅ (SA Team+) | ✅ (stale) | ✅ | env; proj/config |
| AWS / GCP / Azure | ❌ paid (SSM std free) | ❌ | ✅ IRSA/WIF/Entra | ✅ IAM | ✅ heavy | ✅ | env; cloud paths |
| 1Password | ❌ no free tier | ⚠️ Connect cache | ❌ | ✅ SA | ✅ v0 WASM | ✅ | `op://` |
| **SOPS+age** | ✅ free OSS | ✅ no server | ❌ (KMS delegates) | n/a (key) | ❌ shell `sops` | n/a | decrypt file → env |
| .env / keychain | ✅ free | ✅ | ❌ | ❌ | ⚠️ `keytar` | n/a | env (current) |

**Recommendation (PROPOSED), optimize for OSS + OIDC + least complexity:**
- **Tier 1 (build first):** the **`env`/file fallback (have it) + SOPS** (free,
  server-less), **Infisical** (the OSS headline — MIT, free OIDC machine-identity,
  clean SDK), and **OpenBao** (Vault ecosystem, MPL-2.0, JWT/OIDC) over a **thin REST
  adapter** to dodge SDK churn.
- **Tier 2:** **Doppler** as the turnkey SaaS path.
- **Tier 3:** cloud-KMS as **lazy-loaded optional adapters** (keep the heavy SDKs out
  of the core install; mind supply chain).
- Design the broker around a tiny adapter interface (`authenticate() → read(scope) →
  map`) over REST, so no single SDK's weight/maturity is load-bearing.

---

## 4. Doppler specifics (the spark)

- **Skip the SDK (VERIFIED).** `@dopplerhq/node-sdk` is zero-dep but **stale** (v1.3.0,
  2024) and a thin REST wrapper. Use `node:fetch`:
  `GET https://api.doppler.com/v3/configs/config/secrets/download?format=json` with
  `Authorization: Bearer <token>` → a flat `{NAME: value}` map. A **Service Token**
  implies project+config (omit the params). Cache per run (rate limits: 120/min read
  on free).
- **Auth ranked:** read-only **Service Token** in `$ENV` (free, single-config, instantly
  revocable — the secret-zero answer) → **Service Account** token (org-scoped, Team+)
  → **Service Account Identity (OIDC)** via `POST /v3/auth/oidc` exchanging a JWT for a
  short-lived token (issuer-agnostic via a custom Discovery URL — **not** CI-only;
  Team+).
- **Plan reality (VERIFIED):** anything beyond a read-only Service Token needs **Team+**.
  Document that the free path is the Service Token.

---

## 5. Vault / OpenBao specifics

- **Recommend OpenBao** (MPL-2.0) over Vault (BSL) for the "free/self-hostable"
  requirement; build against the **common KV-v2 + AppRole/JWT subset** so the client
  works on either.
- **Auth:** **AppRole** (`role_id` + `secret_id` → token; **response-wrap** the
  `secret_id` for tamper-evident delivery; renew at ~50% TTL) for servers; **JWT/OIDC**
  (`POST /v1/auth/jwt/login` with `{role, jwt}`) wherever a federated identity exists —
  it eliminates the static bootstrap secret.
- **KV-v2:** `GET /v1/<mount>/data/<path>` → value at `data.data`. **Dynamic secrets**
  (auto-expiring per-use DB/cloud creds) are the strategic upside (no Doppler
  equivalent) — out of scope for v1, but design the provider so a "dynamic" source can
  slot in.
- **No official Node SDK** (only Go/Ruby; `node-vault` is community + axios) → zero-dep
  `node:fetch`. **Don't** adopt Vault Agent/sidecar — the engine already *is* the
  broker.
- **Self-host cost (VERIFIED):** dev mode is trivial; prod needs a storage backend, the
  **unseal lifecycle** (the #1 gotcha — plan auto-unseal early), and TLS. Worth it only
  for self-sovereignty or dynamic secrets.

---

## 6. Engine integration design

### 6a. Two injection paths — pick per use-case (VALIDATED)

| Secret use-case | Path | Property |
|---|---|---|
| API token to call an **allowlisted host** (Slack/Grafana/model/deploy API) | **(a) host-side header-swap** (`JobNetwork.secrets` → `gondolin.ts:106-116`) | **real value never enters the guest** — the strong path; the default for most store secrets |
| Value a command genuinely needs as a literal env var (DB password to a CLI, key echoed to a file) | **(b) step `env`** (`runtime.ts:435-446`) | value **is visible in-guest**; unavoidable, minimize blast radius — never the default |

Most "secrets-from-a-store" cases are HTTP tokens → **path (a)**, which gives the real
guarantee.

### 6b. A `${{ secrets.NAME }}` context — NEEDS-BUILDING, runtime-resolved

- **Where it slots (VALIDATED limits):** `expr.ts` is flat-regex with a catch-all throw
  (`expr.ts:34,83`); a `secrets` root mirrors `inputs` almost exactly (flat names, no
  nesting) — add `secrets?` to `ExprContext` + a `/^secrets\.([A-Za-z_][\w-]*)$/`
  branch.
- **Resolve at RUNTIME, not compile time (the crux).** `inputs`/`matrix` bake into the
  durable plan at compile (`compile.ts:207`); `needs`/`steps` *defer* and resolve in the
  runtime (`expr.ts:61,72`; `runtime.ts:434,494`). **Secrets MUST follow the deferral
  model** — if resolved at compile time the value lands in `PlannedStep.env`/`.run` and
  persists into Absurd/PGLite and any plan dump (§7 forbids). So leave `${{ secrets.* }}`
  intact at compile and resolve just-in-time.
- **Keep `secrets` OUT of the `if:`/condition roots** (`condition.ts:258`) — a deliberate
  decision, so a condition can't branch on a secret value and leak it via skip patterns.

### 6c. Pluggable provider + config surface — PROPOSED

```ts
interface SecretsProvider { resolveSecret(ref: SecretRef): Promise<string>; }
// backends: env | doppler | openbao/vault | infisical (each authenticates via SA/OIDC)
```
Extend the existing config file (its parser **ignores unknown top-level keys**,
`config/index.ts:54`); backend creds use the existing **`$ENV` expansion** so the
secret-zero bootstrap (`$DOPPLER_TOKEN`, `$BAO_ROLE_ID`) stays in the environment, never
a literal in the committed/gitignored file — same pattern the webhook doc proposes:

```jsonc
{
  "providers": { /* … */ }, "models": { /* … */ },
  "secrets": {
    "backends": {
      "doppler": { "type": "doppler", "token": "$DOPPLER_TOKEN", "project": "app", "config": "prod" },
      "bao":     { "type": "openbao", "addr": "https://bao.internal", "roleId": "$BAO_ROLE_ID", "secretId": "$BAO_SECRET_ID" }
    },
    "default": "doppler"
  }
}
```

**Compose with `resolveJobNetwork` (VALIDATED seam).** The runtime takes one
`resolveJobNetwork?` (`runtime.ts:82,315`); the webhook doc already proposes composing
resolvers (union `allowedHosts`, merge `secrets` by env name). A
`makeSecretsEgressResolver(config, provider)` scans a job's steps for `${{ secrets.* }}`,
calls `resolveSecret`, and emits `{ allowedHosts, secrets: { ENVNAME: { hosts, value } } }`,
composed with the agent resolver. `resolveSecret` is async, so `resolveJobNetwork` becomes
async — a one-line change at `runtime.ts:315` (`const network = await deps.resolveJobNetwork?.(job)`).

---

## 7. Security / hygiene model

- **Never in the durable plan or logs (VALIDATED guarantee via runtime resolution).**
  Resolve at runtime (§6b) so secrets never land in `PlannedStep.env`/`.run` → never in
  the Absurd/PGLite store. Since `StepResult.stdout/stderr` *is* persisted/streamed
  (`runtime/types.ts:13-21`), the **header-swap path is strongly preferred** — the value
  can't appear in captured output because it never enters the guest.
- **Header-swap keeps it out of the guest (VALIDATED):** placeholder env only,
  host-scoped (`gondolin.ts:50,106-116`; `guest-pi-runner.ts:84` "carries everything
  EXCEPT the key").
- **Never in the package:** `files: ["bin","dist","README.md"]`.
- **Secret-zero in `$ENV`, not committed** (`expandEnv`, `config/index.ts:45,119`).
- **In-memory TTL cache only (PROPOSED):** `resolveSecret` results cached in-process with
  a short TTL — never disk, never PGLite; bounds backend calls and staleness.

---

## 8. "Directly useful today" — the smallest slices

- **Slice 0 (tiny, no spec change, lands on the current product):** make config
  `apiKey` (and any config secret) resolvable through a provider — `apiKey:
  "doppler://app/prod/OPENAI_KEY"` resolved via `SecretsProvider` instead of / after
  `$ENV` (`config/index.ts:119`). Rides the existing agent egress path untouched
  (`egress.ts:65`); the operator stops pasting raw keys into config and doesn't even
  need the key in `$ENV`. Useful with the CLI exactly as shaped today.
- **Slice 1:** add the `secrets` context (`expr.ts`) + generalize the egress resolver to
  plain `run` steps (`makeSecretsEgressResolver`, composed at `cli.ts:230`). Now a
  `run:` step can declare `secrets.SLACK` and get the token brokered host-side for
  `hooks.slack.com` only — the exact "highest-value enabler, no sandbox change" the
  webhook doc flags.

---

## 9. Reusable today vs net-new

| Piece | Status |
|---|---|
| `JobNetwork` → gondolin header-swap (generic, job-level, host-side-only) | **VALIDATED reusable** (`runtime.ts:60-65,315`; `gondolin.ts:50,106-116`) |
| `$ENV` expansion for backend creds; config ignores unknown keys | **VALIDATED reusable** (`config/index.ts:45,54,119`) |
| Runtime deferral pattern (`needs`/`steps` already defer) | **VALIDATED pattern** (`expr.ts:61,72`) |
| `secrets` context root in `expr.ts` | **NEEDS-BUILDING** (mirror `inputs`) |
| `SecretsProvider` + backends (env/doppler/openbao/infisical, REST) | **NEEDS-BUILDING** |
| `secrets:` config section + parse | **NEEDS-BUILDING** |
| Generalize resolver beyond agent steps + make it async | **NEEDS-BUILDING, small** (`egress.ts:57`, `runtime.ts:315`) |
| OS-keychain storage for the secret-zero bootstrap (local CLI) | **NEEDS-BUILDING** (optional, DX) |

**Phasing:** Slice 0 (config refs) → `env`+SOPS+Doppler providers → `secrets` context +
generalized run-step resolver (Slice 1) → Infisical + OpenBao providers → OIDC/keychain
auth niceties → cloud-KMS optional adapters → (later) dynamic secrets.

---

## 10. Open questions

1. **Runtime resolution into `JobNetwork`** — make `resolveJobNetwork` async and have it
   scan a job's steps for `${{ secrets.* }}` to pre-compute the job-wide header-swap
   network (matches current job-level granularity), vs a finer per-step seam. Recommend
   the former (reuses everything).
2. **Validate non-agent secrets against a real gondolin run** — egress is "agent-only
   today, a property of the resolver not the sandbox," and the **test double doesn't
   implement the header-swap** (webhook doc §12.5). Per the standing rule, secrets-into-
   `run`-step work must be checked against `demo.sh`/a real VM, not just the suite.
3. **Keep `secrets` out of `if:`** (`condition.ts` ROOTS) — confirm as a deliberate
   no-leak decision.
4. **Auth posture per shape** — which backends ship OIDC vs SA tokens first; OS-keychain
   on the laptop (worth a `keytar`-free implementation given `keytar` is unmaintained).
5. **`secrets://` reference grammar** — `backend://scope/NAME` vs a config-lookup name;
   how a workflow declares which backend/scope a secret comes from.

---

## 11. Key files & sources

**Code:** `src/config/index.ts:45,54,119` (`$ENV` expansion, unknown-key tolerance);
`src/agent/egress.ts:44-69` (the resolver template, agent-gated); `src/targets/
gondolin.ts:50,106-116` (header-swap, value never in guest) + `factory.ts:27`;
`src/runtime/absurd/runtime.ts:60-65,82,315,435-446,494-499` (JobNetwork, resolver
forward, env/with resolution); `src/compiler/expr.ts:20-43,61,72,83` (where a `secrets`
root slots) + `condition.ts:258` (keep secrets out); `src/agent/guest-pi-runner.ts:34,84`
(placeholder env); `package.json:13-17` (`files`); `docs/webhook-triggers-research.md`
§5/§9/§12.

**External (VERIFIED):** Doppler [Service Tokens](https://docs.doppler.com/docs/service-tokens) · [Service Account Identities (OIDC)](https://docs.doppler.com/docs/service-account-identities) · [secrets download](https://docs.doppler.com/reference/secrets-download) · [pricing](https://www.doppler.com/pricing);
OpenBao [openbao.org](https://openbao.org/) · [KV-v2](https://openbao.org/docs/secrets/kv/kv-v2/); Vault [AppRole](https://developer.hashicorp.com/vault/docs/auth/approle) · [JWT/OIDC](https://developer.hashicorp.com/vault/api-docs/auth/jwt) · [response-wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping) · [dynamic secrets](https://developer.hashicorp.com/vault/tutorials/get-started/understand-static-dynamic-secrets);
Infisical [Machine Identities](https://infisical.com/docs/documentation/platform/identities/machine-identities) · [OIDC auth](https://infisical.com/docs/documentation/platform/identities/oidc-auth/general) · [Node SDK](https://infisical.com/docs/sdks/languages/node) · [pricing](https://infisical.com/pricing);
GitHub [OIDC hardening](https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect); GCP [Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation); AWS [IAM roles for GH Actions](https://aws.amazon.com/blogs/security/use-iam-roles-to-connect-github-actions-to-actions-in-aws/);
[SOPS](https://github.com/getsops/sops); 1Password [Service Accounts](https://developer.1password.com/docs/service-accounts/get-started/); RFC 8628 [Device Grant](https://oauth.net/2/device-flow/).
