# `on: webhook` — Webhook Triggers + Incident-Response Pipelines: Research + Design

> Research note for a generic `on: webhook` trigger: a workflow opts in, an
> **authenticated** HTTP POST carries a payload, the URL selects the workflow, and
> the payload becomes the run's **inputs and/or a raw `event` context** — i.e.
> "`workflow_dispatch` with a remote, authenticated ingress." The motivating use
> case is incident response: Grafana/Alertmanager POSTs an alert (through a tunnel)
> → parallel structured fact-finding jobs → agent synthesis → a response action.
>
> **Builds on** [`web-ui-research.md`](web-ui-research.md) — the webhook receiver is
> an *extension of the same long-lived `node:http` server* (RunManager, the
> `parse→compile→Runtime.run` dispatch path, the loopback posture), not a new
> stack. **No code written yet.** Consolidates six parallel investigations
> (trigger/spec/context, security, Alertmanager/Grafana specifics, exposure +
> async receiver, the incident pipeline, config/secrets/ops). Date: 2026-06-01.
>
> Tags used throughout: **VALIDATED** (grounded in our code, file:line) /
> **VERIFIED** (cited external standard/vendor doc) / **PROPOSED** (a design choice)
> / **NEEDS-BUILDING** (net-new engine work).

---

## 1. Thesis & the shape of the work

The **interior** of this pattern is already the engine's strength. Parallel
fan-out fact-finding feeding a single fan-in agent job is **supported today**
(§8). What's missing are the **edges**: the trigger machinery, the payload
context, generalized egress for plain steps, and the security/async/config layers
that a remotely-triggered system requires.

Concretely, the work splits into five buildable pieces, roughly in dependency
order:

1. **The trigger + `event` context** (§3) — give the inert `on:` field meaning;
   expose the POST body as `${{ event.* }}`. The one real *parser* change.
2. **The authenticated async receiver** (§6–7) — HMAC/bearer auth, ack-fast,
   run-async, dedupe, backpressure — an extension of the `--web` server.
3. **Generalized egress/secrets for `run` steps** (§5, §8) — so fact-finding can
   reach a logs/metrics API and the response can post to Slack. The plumbing
   already exists; only the *resolver* is agent-gated.
4. **Config + ops surface** (§5) — where hook secrets and datasource creds live,
   how the receiver is started, what's audited.
5. **Pipeline ergonomics** (§8) — optional: multi-output agents, dynamic matrix.

Everything is implementable with **`node:http` + `node:crypto`, zero new
dependencies**, consistent with the project's posture.

---

## 2. The trigger model

`on: webhook` is **opt-in per workflow** and means: *this workflow may be started
by an authenticated POST.* A workflow without it is not remotely triggerable
(fail-closed, §4). Routing, payload, and gating:

- **Routing — URL path (recommended).** `POST /hooks/<name>` → the existing
  `findWorkflowByName(workspace, name)` (`src/project.ts:50`), the same lookup the
  CLI's `run <name>` uses. Free, unambiguous (names are already unique), and makes
  per-hook auth scoping natural. A payload field naming the workflow is rejected as
  the *primary* router (it lets the caller pick any workflow); an optional
  per-workflow **payload filter** (an `if:`-style predicate over `event.*`) can
  reject non-matching posts with a 4xx.
- **Opt-in gate.** `on:` is currently parsed into `spec.on` as `unknown`
  (`src/spec/types.ts:104`, `src/spec/parse.ts:318`) and **read by nothing** — so
  this is greenfield with no migration. The gate lives in the webhook handler:
  resolve name → `parseWorkflow` → assert `spec.on` declares `webhook`, else
  404/403. Best made part of resolution (a webhook-aware lookup that filters to
  `on: webhook` files), so a non-opted workflow is invisible to the router. This is
  the first time `spec.on` becomes load-bearing.
- **Payload → inputs + the `event` context** — see §3.

---

## 3. The `event` context — the one real engine/parser change

A webhook payload is arbitrary, deeply-nested JSON (Alertmanager's `alerts[]`,
`commonLabels{}`, …). You **cannot** feed it through the existing inputs system:
`resolveInputs` rejects undeclared keys and accepts only flat scalars (no array or
object input type) — `src/compiler/inputs.ts:24,77`, `:11`. So, like GitHub's
`github.event`, expose the whole body as a raw **`event` context**, and offer
typed inputs as optional sugar *derived* from it.

**The parser reality (VALIDATED), which is the load-bearing finding:**

- There are **two** independent evaluators. The `if:`/`when:` engine
  (`src/compiler/condition.ts`) is a real recursive-descent parser that **already
  walks arbitrary-depth dotted object paths** (`condition.ts:285-302`) — gated to
  roots `{inputs, needs, steps, matrix}` (`:258`). Adding `"event"` to that
  allowlist makes `if: ${{ event.commonLabels.severity == 'critical' }}` work with
  almost no new code.
- The `${{ }}` string-**interpolation** engine (`src/compiler/expr.ts`) is the
  opposite: a fixed set of **flat regexes** (`inputs.<name>`,
  `needs.<job>.outputs.<name>`, `steps.<id>.outputs.<key>`, `matrix.<axis>`),
  with a catch-all **throw** on anything else (`expr.ts:34,83`). It supports **no
  nested paths and no array indexing**. So `${{ event.alerts[0].labels.severity }}`
  hits the throw today.
- **Array indexing (`[0]`) is net-new in BOTH evaluators** — neither tokenizes
  `[`. This is the single genuinely-new parser feature the rich `event.*` access
  demands.

**Design (PROPOSED):**
- Add `event` to `ExprContext` (`expr.ts:20`) and to `ConditionContext`/`ROOTS`
  (`condition.ts:43,258`).
- Replace the flat `event.*` handling in `interpolate` with a **path-walking
  resolver** (adopt the condition engine's object-walk) **plus** array-index
  tokenizing (`[n]`, optionally `['key']`). Define stringification explicitly:
  scalars `String()`, `${{ event }}` (whole object) → `JSON.stringify`,
  missing/non-scalar → empty string (GHA-ish).
- **Resolution phase:** resolve `event` at **compile/ingress** (one
  `compile(spec, { inputs, event })` call), so concrete values bake into the plan —
  consistent with how `inputs` already work (`compile.ts:207`) and keeps the plan
  self-contained. (Alternative: thread the raw body to runtime; flagged as an open
  question if payload size makes plan bloat a concern.)
- **Typed inputs as optional sugar:** a workflow that wants a validated, named
  scalar maps it out of the body via an input default, e.g.
  `severity: { default: "${{ event.commonLabels.severity }}" }`, resolved before
  `resolveInputs` runs — reusing the existing validator (pattern/options/required)
  unchanged for the few fields the author cares about, while `event` keeps the long
  tail.

**Touch points:** `spec/types.ts:104` (typed `WebhookTrigger`), `spec/parse.ts:318`
(a real `parseOn()` validator modeled on `parseInputs`), `compiler/expr.ts`
(event + path/index walker), `compiler/condition.ts` (event root), `compiler/
compile.ts` + `inputs.ts` (thread `event`), the webhook handler (capture body →
`compile(spec,{inputs,event})`).

---

## 4. Security — the crux (the trigger becomes a real boundary)

This is the project's first trigger that faces a hostile, unauthenticated
internet, and **the loopback model from `web-ui-research.md` §9 does not transfer.**
That model (bind `127.0.0.1`, `Host`-header check, CSRF token) assumes the network
is the boundary and the adversary is a malicious *browser page*. A webhook receiver
is deliberately tunnel-exposed; the caller is an anonymous internet client sending
server-to-server (no Origin, no preflight to lean on). So the trigger needs
**cryptographic request authentication**, not topology assumptions.

**Key framing:** gondolin sandboxes the *action* (`sandboxed:true` is hard-wired,
`runtime.ts:510`) but **not the triggering**. A forged trigger still spends real
money (LLM/API), posts to external systems, and consumes VM slots. So the design
must **fail closed**.

### Threat model → mitigation

| Threat | Mitigation |
|---|---|
| Forgery (craft a POST) | HMAC signature **or** bearer token (constant-time) |
| Replay (resend a captured valid request) | signed-timestamp window (~300s) + delivery-id/fingerprint dedupe |
| Oversized / JSON-bomb body | hard byte cap, **stream-abort** before buffering; parse only after auth |
| Flood / cost-DoS | rate limit + **bounded concurrent runs** + ack-fast |
| Slow-loris | header/body read timeouts (`server.headersTimeout`/`requestTimeout`) |
| Misconfig → open trigger | **fail-closed**: no auth configured ⇒ trigger disabled (404) |

### HMAC verification (VERIFIED standards)

Three reference models, identical crypto, differing only in *what string is
signed*: **GitHub** `X-Hub-Signature-256` = `sha256=`+hex HMAC over the **raw
body**; **Stripe** `Stripe-Signature: t=…,v1=…` signs `"{t}.{body}"` (timestamp
baked in → replay-resistant, default tolerance **300s**); **Slack** signs
`"v0:{ts}:{body}"`. Verify with Node built-ins only:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = createHmac("sha256", secret).update(rawBody).digest();   // Buffer
const got = Buffer.from(hexSigFromHeader, "hex");
return got.length === expected.length && timingSafeEqual(expected, got);   // constant-time
```

Load-bearing pitfalls (VERIFIED): **hash the RAW bytes before any JSON parse**
(re-serializing breaks the signature — the #1 webhook bug; we own `node:http` so we
read the raw stream ourselves, an advantage); **`timingSafeEqual` throws on
length mismatch** so guard length first (digest length is public); strip the scheme
prefix and **pin the algorithm** (never trust a header-supplied alg).

### When the sender can't HMAC — bearer fallback

Support **two first-class modes: `hmac` (preferred — adds body integrity + replay)
and `bearer`** (a shared token in `Authorization`/custom header, constant-time
compared; no integrity on its own, but fine over the tunnel's TLS).
**URL-path-secret is prohibited as sole auth** (leaks via logs/referers/tunnel
dashboards); **mTLS is out of scope v1** (the tunnel terminates TLS, so the origin
can't see the client cert). This bearer fallback isn't theoretical — **Alertmanager
literally cannot HMAC-sign** (§5), so it's the required path for the canonical
sender.

### Layered model & the mandatory/optional matrix (PROPOSED, all node-built-in)

```
Internet → [optional tunnel-edge verify] → node:http origin:
  L1 fail-closed gate      no auth declared ⇒ 404 (hook invisible)
  L2 size cap + timeouts   abort > ~128–256KB; header/body timeouts
  L3 rate limit            per-hook token bucket + bounded concurrent runs
  L4 authenticate          HMAC-SHA256(raw body) OR bearer, constant-time
  L5 replay check          signed-timestamp window (300s) + delivery-id dedupe
  L6 parse + validate      JSON.parse only now; map body→inputs; resolveInputs
  L7 ack-fast              202 + runId; gondolin runs the action async
```

| Control | Status |
|---|---|
| Fail-closed default + per-workflow opt-in | **Mandatory** |
| Request auth (HMAC **or** bearer), constant-time, raw-body | **Mandatory** |
| Replay window + delivery-id/fingerprint dedupe (runs are non-idempotent) | **Mandatory** |
| Size cap, timeouts, rate limit + bounded concurrent runs, parse-after-auth | **Mandatory** |
| Per-hook secrets (vs one global) | Recommended |
| Tunnel-edge verify (ngrok `verify-webhook`, CF Access) | Optional (defense-in-depth) |
| IP allowlist | Discouraged (brittle behind tunnels — origin sees the *tunnel* IP) |
| mTLS / URL-path-secret-as-sole-auth | Out of scope / Prohibited |

---

## 5. Sender reality: Grafana & Alertmanager (this constrains the auth design)

**The correction worth leading with:** our prior assumption that "neither supports
HMAC" is **half wrong.**

- **Grafana Alerting natively HMAC-SHA256-signs** its webhook (header
  `X-Grafana-Alerting-Signature`, hex; if a timestamp header is configured the
  signed message is `timestamp + ":" + body`, else just `body`). It *also* supports
  basic auth / `Authorization` header / arbitrary **Extra Headers** / TLS.
  **(VERIFIED — Grafana webhook-notifier docs.)**
- **Prometheus Alertmanager does NOT sign**, and won't soon — the feature request
  (#4248) is **closed "not planned."** Its `http_config` offers `basic_auth`,
  `authorization`/bearer, `oauth2`, and `tls_config` (mTLS) — **but no custom-header
  map and no HMAC.** **(VERIFIED.)** ⇒ For Alertmanager, our receiver authenticates
  via **bearer token / basic auth / mTLS / path secret**, full stop.

**Payloads (VERIFIED).** Both are Alertmanager-shaped; treat the body as the
Alertmanager superset and branch on `version`:
- **Alertmanager** (`version:"4"`): `status` (firing/resolved), `groupKey`,
  `truncatedAlerts`, `commonLabels`, `commonAnnotations`, `externalURL`, and
  `alerts[]` each with `labels`, `annotations`, `startsAt`/`endsAt`,
  `generatorURL`, `fingerprint`.
- **Grafana** (`version:"1"`): adds `orgId`, top-level `title`/`message`/`state`,
  and per-alert `dashboardURL`/`panelURL`/`silenceURL`/`values` (a refID→number
  map; note `valueString` is a *template* field, not a default JSON key, and
  `imageURL` is not a documented body field). Grafana also supports fully
  custom-templated bodies — don't assume the default shape if the operator
  customizes it.

**Delivery / retry / grouping (VERIFIED).** POST, `application/json`, **2xx =
success**; **only 5xx is retried** (4xx is not), and retries die at the
`group_interval` deadline — so **ack fast or risk a context-deadline cancel.**
There is **no delivery-id/idempotency header** from either sender, so dedupe on
`groupKey` + per-alert `fingerprint` + `status` + `startsAt`. Cadence is **batched**
(many `alerts[]` per body): first batch ~`group_wait` (30s) after firing, updates
no oftener than `group_interval` (5m), re-sends a still-firing group every
`repeat_interval` (4h), plus a separate `status:"resolved"` POST to auto-close.

**Useful fact-finding fields:** `alerts[].labels.{alertname,severity,instance,job,
namespace}`, `annotations.{summary,description,runbook_url}`, `generatorURL`,
`startsAt`, `fingerprint`/`groupKey`, and Grafana's `dashboardURL`/`values`. (Labels
and annotations are arbitrary maps — `severity`/`runbook_url` are strong
conventions, not guarantees; parse defensively.)

---

## 6. Exposure / tunneling

The engine stays **loopback-bound** (`127.0.0.1`); the tunnel connects *outbound*
to its edge and forwards back to loopback, so we receive hooks **without ever
binding `0.0.0.0`** — preserving the `web-ui` §9 posture. Exposure is the operator's
responsibility; we document a tunnel, we don't ship one.

| | ngrok | **Cloudflare Tunnel** | Tailscale Funnel | Reverse proxy |
|---|---|---|---|---|
| Free stable URL | 1 `*.ngrok-free.app` | **own domain, free, unlimited bw** | `*.ts.net` only | own domain |
| Edge auth it adds | **`verify-webhook`** (HMAC at edge, 50+ providers, 403s bad sigs) | **Access** (service token / SSO, free ≤50) + WAF/DDoS | funnel ACLs (coarse) | whatever you configure |
| Ports / persistence | static domain persists | outbound-only, named tunnel durable | 443/8443/10000 only | fully yours |
| Best for | quick "reach my laptop" | **long-lived receiver (default)** | already-Tailscale teams | compliance / no cloud MITM |

**Recommendation (PROPOSED):** document **Cloudflare named Tunnel** as the default
(free stable URL on your own domain, unlimited bandwidth, outbound-only, optional
Access in front), and **ngrok** as the quick-start (its `verify-webhook` edge
action offloads HMAC for known providers). **Defense-in-depth:** the tunnel's auth
and **our** HMAC/bearer are independent layers — never rely on either alone (the
operator may forget the edge, or switch tunnels). Note Alertmanager can't do SSO, so
for the CF-Access path it needs a **service token**; otherwise lean on our bearer
check.

---

## 7. Async receiver architecture (extends the `--web` server)

The UI path *awaits* `AbsurdRuntime.run` and streams over SSE. **The webhook path
must NOT await it** — `run()` boots gondolin VMs and the sender wants a fast 2xx.
So:

```
POST /hooks/:name   (remote sender)
  1. validate route + auth (HMAC/bearer)         → 401/403 on fail        (sync, cheap)
  2. dedupe (delivery key)                        → 200 {runId} if dup     (replay → no new run)
  3. backpressure (capacity)                      → 202 queued | 429 full
  4. map payload→inputs; parseWorkflow→compile(spec,{inputs,event})  → 400 on bad
  5. mint runId, register RunRecord, START in BACKGROUND:
        const p = runtime.run(plan, { ..., hooks: webPresenter.hooks });   // NOT awaited
        p.then(onComplete).catch(onError);
  6. ACK 200/202 { runId, statusUrl, eventsUrl }
```

- **Dedupe (NEEDS-BUILDING, small).** No delivery-id header exists (§5), so the
  delivery key = an explicit header if present, else `sha256(workflow + raw body)`.
  Keep a bounded TTL map → on a hit, return the original `runId`, start nothing. A
  neat reuse: **make the `runId` deterministic from the delivery key** — then every
  job's existing Absurd `idempotencyKey` (`${runId}:${jobId}`, `runtime.ts:194`)
  collides and `spawn_task`'s `on conflict … do nothing` (`schema.sql:744`) makes
  the duplicate a no-op **engine-level**, for free. (Today `runId` is internal/random
  at `runtime.ts:131`; surfacing/injecting it is *already* on the `web-ui` §6
  to-do.)
- **Backpressure (NEEDS-BUILDING).** A `RunManager`-owned bounded run semaphore +
  FIFO queue (the `web-ui` §12 open decision, now forced by alert storms): under
  the limit → **200 running**; queued → **202** (+ `runId`/`statusUrl`); full →
  **429** + `Retry-After` (which re-hits dedupe safely). One job = one VM
  (`runtime.ts:316`), so this bounds VM contention and stops a webhook storm from
  starving the UI.
- **Coexistence with `--web` (REUSABLE).** Same server, route-partitioned: loopback
  UI routes (Host+token) vs `POST /hooks/*` (HMAC/bearer). A webhook-triggered run
  is just another `RunRecord` keyed by `runId` with the same `WebPresenter`→SSE
  bridge, so **the UI watches it live for free**; tag it `trigger:"webhook"` vs
  `"dispatch"`.
- **Callback (PROPOSED, optional).** A hook may declare a `callbackUrl`; on
  completion POST the `WorkflowResult` summary back (HMAC-signed by us, symmetric
  with what we ask of senders) — closes the loop for incident systems whose ack
  timeout is far shorter than the run.

---

## 8. The incident-response pipeline (showcase + capability map)

**The interior works today.** The "parallel fact-finding → one agent synthesis"
core is exactly what the engine does well:

- **Fan-out parallelism — SUPPORTED.** `needs` compiles to a DAG (`compile.ts`
  topoSort); the runtime schedules all jobs via `Promise.all(plan.jobOrder.map(
  schedule))` with worker `concurrency` (`runtime.ts:216,149`). Independent
  fact-finders genuinely run concurrently (the `fan-out-fan-in` example is the
  precedent).
- **N→1 fan-in data flow — SUPPORTED (the crux, and it works).** Each job's
  `outputs:` resolve at job end (`runtime.ts:404`); a downstream job receives
  **every** dependency's outputs in its `needs` context (`runtime.ts:164`), so one
  agent job reads `${{ needs.recent_deploys.outputs.summary }}`, `${{
  needs.error_logs.outputs.summary }}`, … from many parents. Facts reach the agent
  via `with:` (resolved before the handler runs, `runtime.ts:494`) → bound into the
  agent's task template.

**Worked sketch** (illustrative; `### NEEDS-BUILDING` marks what doesn't exist yet):

```yaml
name: incident
on:
  webhook: { source: alertmanager }          ### NEEDS-BUILDING: trigger machinery
jobs:
  # FAN-OUT — 4 independent fact-finders run in PARALLEL (SUPPORTED)
  recent_deploys:
    runs-on: gondolin
    outputs: { summary: "${{ steps.q.outputs.summary }}" }   # SUPPORTED
    steps:
      - id: q
        run: |
          svc="${{ event.commonLabels.service }}"            ### NEEDS-BUILDING: event.*
          out=$(curl -s "https://deploys.internal?svc=$svc") ### NEEDS-BUILDING: run-step egress+secret
          { echo "summary<<EOF"; echo "$out"; echo EOF; } >> "$PI_OUTPUT"   # SUPPORTED
  error_logs:   { runs-on: gondolin, outputs: { summary: "${{ steps.q.outputs.summary }}" }, steps: [ … ] }
  metrics:      { runs-on: gondolin, outputs: { summary: "${{ steps.q.outputs.summary }}" }, steps: [ … ] }
  related_alerts:{ runs-on: gondolin, outputs: { summary: "${{ steps.q.outputs.summary }}" }, steps: [ … ] }

  # FAN-IN — one agent consumes ALL four (SUPPORTED end-to-end)
  triage:
    runs-on: gondolin
    needs: [recent_deploys, error_logs, metrics, related_alerts]
    outputs: { assessment: "${{ steps.synth.outputs.assessment }}" }   # one blob (Limit A)
    steps:
      - id: synth
        uses: agent/incident-triage
        with:
          deploys: "${{ needs.recent_deploys.outputs.summary }}"   # SUPPORTED
          logs:    "${{ needs.error_logs.outputs.summary }}"
          metrics: "${{ needs.metrics.outputs.summary }}"
          related: "${{ needs.related_alerts.outputs.summary }}"
          # alert: "${{ event }}"                                ### NEEDS-BUILDING: event.*

  respond:
    runs-on: gondolin
    needs: [triage]
    steps:
      - env: { ASSESSMENT: "${{ needs.triage.outputs.assessment }}" }   # SUPPORTED
        run: curl -s -XPOST "$SLACK_WEBHOOK" --data "{\"text\":\"$ASSESSMENT\"}"  ### NEEDS-BUILDING: run-step egress+secret
```

**The egress gap (the most important pipeline finding).** A fact-finding `run: curl
…` and the Slack `respond` step both need an **allowlisted host + a header secret**.
The mechanism is **fully generic and already job-level**: `GondolinTarget` merges a
job's `JobNetwork.secrets` placeholders into the **VM-wide env every step sees** and
swaps the real value into outbound headers host-side for allowlisted hosts only
(`gondolin.ts:106-116`; the runtime forwards `resolveJobNetwork?.(job)` verbatim,
`runtime.ts:315`). **What's missing is only the resolver:** the sole one wired in is
`makeAgentEgressResolver`, which returns `undefined` for any job with no
`agent/*` step (`egress.ts:57`). So **egress is effectively agent-only today — a
property of the resolver, not the sandbox.** Closing it = a config-driven resolver +
a per-job spec surface to declare `allowedHosts`/`secrets`; **no sandbox change.**
This is the highest-value enabler for real pipelines and should be validated against
a **real gondolin run** (the header-swap lives in real Gondolin httpHooks, not the
test double — per the project's "verify against demo.sh" rule).

**Capability map:**

| Pipeline piece | Status |
|---|---|
| Fan-out parallel jobs | **Supported** (`runtime.ts:216,149`) |
| N→1 fan-in outputs threading | **Supported** (`runtime.ts:164,404,494`) |
| Agent job reads facts via `with: needs.*.outputs.*` | **Supported** (`uses-handler.ts:77`, `agent/index.ts:130`) |
| Read raw alert payload (`event.*`) | **Needs-building** (§3) |
| Egress + secret for plain `run` steps | **Needs-building, small** (resolver only; §5/§8) |
| Multi-output agent (severity/root_cause/confidence as separate outputs) | **Needs-building** — agent maps its whole final message to its *first* output only (`agent/index.ts:136`) |
| Dynamic matrix over alert instances | **Needs-building** — matrix axes are static compile-time literals (`spec/types.ts:67`); can't derive from the alert |
| The trigger itself | **Needs-building** (§2) |

---

## 9. Configuration, secrets & operations

**Config (PROPOSED): extend the existing file.** `parseConfig` validates only
`providers`/`models`/`defaultModel` and **ignores unknown top-level keys**
(`config/index.ts:54`), and secrets already use `$VAR` expansion + a gitignored
file. So add `datasources` and `webhooks` sections that inherit all of that — one
operator-owned, commit-safe secrets surface:

```jsonc
{
  "providers": { /* … */ }, "models": { /* … */ }, "defaultModel": "kimi",
  "datasources": {
    "grafana": { "baseUrl": "https://grafana.internal", "token": "$GRAFANA_TOKEN" }
  },
  "webhooks": {
    "deploy-incident": {
      "workflow": "incident", "enabled": true,
      "auth": "hmac-sha256",                 // hmac-sha256 | bearer
      "secret": "$HOOK_DEPLOY_SECRET",       // per-hook, $ENV — never a literal
      "signatureHeader": "X-Hub-Signature-256",
      "datasources": ["grafana"]             // which creds this hook's run may use
    }
  }
}
```

**The workflow declares intent; config holds the secret reference; the environment
holds the value.** The `on: webhook` block names a config entry — a *reference*, not
a secret — so the committed workflow stays secret-free:

```yaml
on:
  webhook: { secret: deploy-incident }   # names webhooks.deploy-incident in config
```

This gives **per-hook scoping** (each hook its own `$ENV` secret) rather than one
global webhook secret.

**Secret injection generalizes (VALIDATED plumbing, PROPOSED resolver).** A
fact-finding job's datasource token rides the *same* host-side header-swap as the
model key — a `makeDatasourceEgressResolver(config, hook)` emits `{ allowedHosts:
[host], secrets: { GRAFANA_TOKEN: { hosts:[host], value: expandEnv(...) } } }`,
composed with the agent resolver (union `allowedHosts`, merge `secrets` by env-var
name). The `run` step references `$GRAFANA_TOKEN`; the real value never enters the
guest. **Datasource creds must route through the resolver, never through workflow
`env:`** (which *is* visible in-guest).

**Operating the receiver (PROPOSED).** Fold hooks into the same long-lived server:
`work --web [--hooks]` (or `work serve`), `127.0.0.1` + `--port 4280`, fronted by
the operator's tunnel. Per-hook `enabled` toggles. One receiver routes by path
(`POST /hooks/:name`).

**Audit & failure modes (PROPOSED).** Webhook triggers are security-sensitive — log
**every delivery attempt before dispatch** (so rejects are recorded even with no
run): `{ ts, hook, sourceIp, deliveryKey, workflow, authResult, httpStatus,
runId|null }`, in a dedicated append-only audit log / a `webhook_deliveries` table
beside the future `runs` table — **never the payload body or the secret** (hash/
length at most). Responses: **401** missing auth, **403** invalid signature /
disabled hook / replay, **404** unknown hook (generic body — don't disclose which
hooks exist), **400** malformed/oversized, **202** accepted. Durable audit depends
on turning on persistence (the `dataDir` work from `web-ui` §8).

---

## 10. Consolidated gap list (prioritized)

1. **Trigger machinery + `event` context** (§2–3) — the foundation. Largest piece;
   the only real *parser* change (array indexing in `interpolate`, `event` root in
   both evaluators).
2. **Authenticated async receiver** (§4,§6,§7) — HMAC/bearer, fail-closed, ack-fast,
   dedupe, backpressure. Extends the `--web` server; `node:http`+`node:crypto`.
3. **Generalized egress/secrets for `run` steps** (§5,§8,§9) — a composed
   config-driven resolver. **Small, no sandbox change**, high leverage. Validate on
   a real gondolin run.
4. **Config surface** (§9) — `datasources` + `webhooks` sections + per-workflow
   opt-in/secret-reference; reuses `$ENV`/gitignore.
5. **Pipeline ergonomics** (§8, optional) — multi-output agents; dynamic
   (alert-derived) matrix.
6. **Persistence for audit/history** — couples to `web-ui` §8 (default `dataDir` +
   a `runs`/`webhook_deliveries` table).

---

## 11. Phased roadmap

- **Phase 0 — Trigger spine.** `parseOn()` + typed `on: webhook`; the `event`
  context (compile-time, incl. array indexing); the opt-in gate; `POST /hooks/:name`
  with **bearer** auth + fail-closed; ack-fast async dispatch reusing the RunManager.
  Ships a working manual-payload trigger (and the Alertmanager path, since AM is
  bearer-only anyway).
- **Phase 1 — Hardening.** HMAC mode (incl. Grafana's `X-Grafana-Alerting-Signature`
  and GitHub/Stripe/Slack schemes), replay window + dedupe (deterministic runId),
  size cap/timeouts/rate limit, bounded-concurrency queue (200/202/429).
- **Phase 2 — Fact-finding egress.** The generalized datasource resolver +
  per-job/`webhooks` allowlist+secret surface; validated against a real gondolin run.
  This is what makes the incident pipeline *do* anything.
- **Phase 3 — Ops.** Audit log + failure-mode responses; durable history (with
  `web-ui` persistence); optional signed on-complete callback.
- **Phase 4 — Ergonomics.** Multi-output agents; dynamic matrix; per-workflow
  payload filters.

---

## 12. Open questions / decisions

1. **`event` resolution phase** — compile-time bake (simpler, plan self-contained)
   vs runtime-threaded (smaller plan, coexists with `needs`/`steps`). Lean
   compile-time; revisit if large payloads bloat the plan.
2. **Array-index grammar scope** — both evaluators, or only `interpolate`?
3. **Non-scalar interpolation semantics** — `${{ event.alerts }}` → JSON, empty, or
   error? Define explicitly.
4. **Concurrent runs policy** — global semaphore vs per-source budget; default
   `maxConcurrentRuns` against the host's VM budget.
5. **Generalized egress validation** — the resolver plumbing supports run-step
   secrets, but nothing exercises a non-agent secret yet; needs a real-gondolin test
   (the test double doesn't implement the header-swap).
6. **Auth granularity** — per-hook secret (recommended) vs a server-wide ingress
   token; pluggable signature schemes (GitHub/Stripe/Slack/Grafana) selected by
   config.
7. **Filter-fail behavior** — a non-matching payload filter → 200-skip (idempotent)
   or 4xx? (Senders retry on non-2xx; AM dies at the group_interval deadline.)
8. **Multi-output agents** — worth building for clean structured fan-out from the
   synthesis stage, or live with one-blob-per-agent?

---

## 13. Key files & sources

**Code (file:line):** `spec/types.ts:104` + `spec/parse.ts:318` (`on:` inert);
`compiler/expr.ts:34,83` (flat interpolation, the throw) + `condition.ts:258,285`
(nested-path engine, root allowlist); `compiler/inputs.ts:11,24,77` (scalar-only,
unknown-key reject); `compiler/compile.ts:171,207,216` (topoSort, inputs resolve,
parallel schedule); `runtime/absurd/runtime.ts:131` (internal runId), `:149,216`
(worker concurrency / Promise.all), `:164,404,494` (fan-in outputs), `:194` +
`schema.sql:744` (idempotency key + conflict-skip), `:315` (resolveJobNetwork
forward), `:510` (sandboxed); `targets/gondolin.ts:106-116` (VM-wide secret env +
header-swap) + `factory.ts:19` (generic TargetContext); `agent/egress.ts:47-69`
(agent-only resolver, generic shape); `agent/uses-handler.ts:77` + `agent/index.ts:
130,136` (with→agent inputs, first-output-only); `config/index.ts:28,44,119`
(schema, `$ENV` expansion); `cli.ts:146,230` (config resolution, resolver wiring);
`docs/web-ui-research.md` §3/§4/§6/§8/§9 (server, dispatch, RunManager, persistence,
loopback posture).

**External (VERIFIED):** GitHub [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries);
Stripe [Verify signatures](https://docs.stripe.com/webhooks/signature); Slack [Verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack/);
Node [`timingSafeEqual` behavior](https://github.com/nodejs/node/issues/17178);
Prometheus [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/) + [HMAC request #4248 (closed "not planned")](https://github.com/prometheus/alertmanager/issues/4248);
Grafana [webhook notifier (native HMAC)](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/) + [template reference](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/template-notifications/reference/);
ngrok [verify-webhook action](https://ngrok.com/docs/traffic-policy/actions/verify-webhook); [Cloudflare Tunnel vs ngrok vs Tailscale](https://dev.to/mechcloud_academy/cloudflare-tunnel-vs-ngrok-vs-tailscale-choosing-the-right-secure-tunneling-solution-4inm).
