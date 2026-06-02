# Programmatic / Embedded Tunneling for `work --web --hooks`: Research

> Follow-up to [`webhook-triggers-research.md`](webhook-triggers-research.md) §6,
> which assumed the **operator** fronts the loopback-bound receiver with an
> external tunnel ("we document a tunnel, we don't ship one"). This explores the
> next step the user raised: could the engine itself **programmatically bring up the
> ingress** (`work --web --hooks --tunnel`)? Focus on **Node-embeddability** — the
> project is Node.js with a zero/minimal-dependency ethos and an esbuild-built
> published artifact. Covers Tailscale, Pangolin, ngrok, and cloudflared.
> **No code written.** Tags: **VERIFIED** (cited vendor/registry doc) / **INFERRED**
> (synthesis/judgment).

---

## 1. TL;DR verdict

**Only ngrok can be embedded in-process from Node.** Everything else is, from
Node's vantage, either a **sidecar binary** you `child_process.spawn` or a
**self-hosted** edge you operate. The clean tiering for our zero-dep posture:

- **(A) User fronts it** — current §6 stance. Bind loopback, document tunnels, ship
  nothing. Zero deps. *Keep as the dependable default.*
- **(B) `--tunnel <provider>` — spawn an installed binary** (`cloudflared` /
  `tailscale` / ngrok-agent). **No npm dependency** (a runtime *external-binary*
  requirement, not a bundle dep). *Recommended next step.*
- **(C) `@ngrok/ngrok` as an OPTIONAL dependency** — true one-command embedded
  ingress, no external binary. Fits the existing gondolin/pi optional-dep pattern,
  at the cost of a ~11 MB native module + a mandatory ngrok account.

**The invariant across all three:** the tunnel is **transport, never trust.** Per
§4 of the webhook doc, our `node:crypto` HMAC/bearer + replay window + fail-closed
gate are **always on**; any tunnel-edge auth is strictly defense-in-depth (the
operator may misconfigure it or switch tunnels, and — see §6 — it doesn't even
cover our motivating senders).

---

## 2. Node-embeddability matrix

| Technology | In-process from Node? | First-class Node SDK? | Sidecar binary (`child_process`)? | Self-host required? | Native weight |
|---|---|---|---|---|---|
| **ngrok** (`@ngrok/ngrok`) | **YES** — the only one | **YES** (Rust core via NAPI; no separate agent binary) | n/a | No (ngrok cloud edge) | ~11 MB native `.node`/platform (VERIFIED) |
| **cloudflared** | No | **No** SDK; community wrappers spawn it | **YES** (`cloudflared tunnel run` / `--url`) | No (CF edge) | single static Go binary, external |
| **Tailscale** (`tsnet`) | **Go only** (`tsnet` embeds a node); from Node only via the CLI/daemon | **No** | **YES** (`tailscale funnel`, needs `tailscaled`) | No (TS coordination) | Go binary + daemon, external |
| **Pangolin + Newt** | No | **No** | **YES** (run `newt`) | **YES** (you host Pangolin) — or Pangolin **Cloud** | `newt` binary, external + a hosted edge |

Reading it: ngrok is the lone in-process option. Tailscale's elegant in-process
`tsnet` model is **Go-only** and thus irrelevant to Node except as a daemon to
shell out to. Pangolin is additionally a *self-host* play (you operate the public
edge). (INFERRED from the per-tech findings below.)

---

## 3. Tailscale — `tsnet` is Go-only; Node path is CLI shell-out

- **No in-process Node embed (VERIFIED).** The embeddable surface is `tsnet` (Go)
  and its C wrapper `libtailscale` (a `c-archive` that "spins up an entire Go
  runtime inside your process"; consumer must compile it, no prebuilt binaries).
  There is **no official Node binding**: `@tailscale/connect` is a browser **WASM
  client** (tsnet-as-WASM is an acknowledged *unsupported* bug — "Executable not
  implemented for js", tailscale#8315); the one community FFI wrapper
  (`tailscale-js`) is **Bun-only and experimental**. An FFI route via `koffi`/
  `node-ffi-napi` over `libtailscale` is theoretically possible but **breaks zero-dep**
  (native module + per-platform `libtailscale` build + Go runtime inside Node) —
  not viable.
- **`tsnet.ListenFunnel`** *does* open a public, TLS-terminated Funnel endpoint
  programmatically — but only from **Go** (VERIFIED). Ports **443/8443/10000** only;
  `*.ts.net` naming only (fine for a webhook URL, just no custom domain).
- **The realistic Node path = shell out to the `tailscale` CLI (VERIFIED).**
  `tailscale funnel --bg <port>` (background, survives restart), `funnel status
  --json` (scriptable URL discovery), `funnel off`/`reset` (teardown). **Hard
  prerequisites the engine cannot satisfy from a cold start:** `tailscaled` must be
  running, the machine **already joined to a tailnet**, MagicDNS on, and the
  **funnel node-attribute set in the tailnet policy file**. So the engine can
  automate the *last mile* but not remove the tailnet/daemon/policy setup — worse
  first-run UX than ngrok/cloudflared's "one binary + token."
- **Headless identity (VERIFIED):** an OAuth client (`auth_keys` scope) can mint
  **ephemeral, pre-authorized, tagged** auth keys via `POST /api/v2/tailnet/:tn/keys`
  (pure `fetch`, zero-dep) — but a key is not a running node; you still need
  tailscaled/tsnet to consume it. Security caveats: OAuth-minted keys must be tagged;
  reusable keys are "very dangerous if stolen"; revoking a key does **not** deauth
  already-joined nodes. Prefer short-TTL ephemeral keys minted just-in-time from an
  OAuth secret in the existing `$ENV`/gitignored secrets surface.
- **Verdict (INFERRED):** offer as opt-in **`--tunnel tailscale`** that shells out to
  an **already-configured** `tailscale` CLI — ideal for teams *already on Tailscale*.
  **Do not embed** (Go-only, irreconcilable with the Node zero-dep ethos).

---

## 4. Pangolin — self-hosted edge + Newt sidecar (not embeddable)

- **What it is (VERIFIED):** Fossorial's "identity-aware VPN + tunneled reverse
  proxy based on WireGuard," three Go components — **Pangolin** (control plane +
  Traefik data plane, drives routes dynamically from its DB via an internal
  config server), **Gerbil** (WireGuard interface manager with an HTTP API), and
  **Newt** (the userspace-WireGuard **client** that runs next to your service and
  connects *outbound* to Pangolin). Community Edition is **AGPL-3**, ~20.5k stars,
  actively released.
- **Correction to a prior assumption (VERIFIED):** there is now a **Pangolin Cloud**
  free tier (≤5 users) at `app.pangolin.net` — so it's not strictly self-host-only;
  you can use the hosted control plane and just run Newt. This softens the "stand up
  a VPS" barrier.
- **Not embeddable in Node (VERIFIED-grounded):** no SDK for any component. Newt is a
  standalone Go daemon ("no public Go API for embedding"), configured by
  `NEWT_ID`/`NEWT_SECRET`/`PANGOLIN_ENDPOINT`, and — crucially — **targets are pushed
  from Pangolin over a control websocket, not configured locally.** A Node process
  can at most **spawn Newt as a sidecar** and/or **call Pangolin's REST Integration
  API** (Bearer keys, opt-in on self-host) to register a `Site → Resource → Target`
  pointing at our `127.0.0.1:<port>`. (Caveat: an open issue, fosrl/pangolin #1344,
  reports resource-creation API breakage — verify before relying on auto-registration.)
- **Verdict (INFERRED):** the **self-hosted / own-everything** option — right when the
  operator wants no third-party TLS termination, identity-aware access (SSO/RBAC) in
  front of the hook, and is exposing *many* services behind one control plane.
  **Overkill for one laptop + one webhook.** Mention it (with **Pangolin Cloud** as
  the lighter middle-ground) in the self-hosted column; our posture is unchanged
  (loopback-bound, Newt sidecar relays in, our HMAC stacks on top).

---

## 5. ngrok `@ngrok/ngrok` — the one true in-process Node embed

- **What it is (VERIFIED):** "the ngrok agent in library form" — embeds **ngrok-rust
  via NAPI-RS**, **no separate agent binary**. v1.7.0, MIT/Apache-2.0, ~259k weekly
  downloads. One-liner: `const l = await ngrok.forward({ addr: 4280,
  authtoken_from_env: true }); l.url()`.
- **Packaging fits our ethos (VERIFIED):** the top-level package has **no production
  deps**; the native core ships as **platform-specific `optionalDependencies`**
  (darwin/linux/win × arch, ~11 MB each) that npm selects by OS/arch — **exactly the
  gondolin/pi optional-dependency pattern** already in use, and esbuild can keep it
  external.
- **Edge features settable from Node (VERIFIED):** `oauth_*`/`oidc_*`, `basic_auth`,
  `ip_restriction_*`, `traffic_policy`, `mutual_tls_cas`, custom `domain`, and
  `verify_webhook_provider`/`verify_webhook_secret`.
- **⚠️ The correction that matters most (VERIFIED) — supersedes §6 optimism:**
  ngrok's edge `verify-webhook` is **named-provider-only (GitHub/Stripe/Slack/…), no
  generic-HMAC mode**, and **neither Alertmanager nor Grafana is on the list.** So for
  *our* motivating senders — Alertmanager (can't sign) and Grafana (a *custom*
  `X-Grafana-Alerting-Signature` scheme) — ngrok edge verification does **nothing**.
  Its edge value for the incident path collapses to OAuth/IP/basic-auth
  defense-in-depth; **our `node:crypto` HMAC/bearer remains the real boundary.**
- **Cost (VERIFIED):** a ~11 MB native dep, a **mandatory ngrok account/authtoken**
  (free tier = one `*.ngrok-free.app`), ngrok-terminated TLS, single-vendor.
- **Verdict (INFERRED):** the only literal "one command → public URL, no external
  binary" path. Belongs as an **optional dependency**, never a default.

---

## 6. cloudflared — the strongest sidecar (no Node SDK)

- **No official Node SDK (VERIFIED):** spawn the **single static Go binary** as a
  child process. Community wrappers (`cloudflared` npm / `untun`) demonstrate the
  pattern (download-on-demand + spawn, emit a `url` event) but aren't worth a dep —
  cleaner to spawn it ourselves.
- **Two modes (VERIFIED):** **named tunnel** (`tunnel run --token`) = stable URL on
  your own domain, unlimited bandwidth, outbound-only, durable — the §6-recommended
  production default. **TryCloudflare quick** (`--url`) = no account/token, random
  `*.trycloudflare.com` URL that changes per run.
- **⚠️ Caveat for our async receiver (VERIFIED → INFERRED impact):** TryCloudflare
  quick tunnels have **no SSE support and a 200 concurrent-request cap**. Our design
  (webhook-triggers §7) streams live run progress over SSE and the UI watches
  webhook runs over SSE — so **quick tunnels are unfit for anything but a bare hook
  POST demo.** If we shell to cloudflared, **default to named-tunnel-token mode**;
  treat `--quick` as throwaway, eyes open.
- **Verdict:** the best **(B)** sidecar option, aligned with §6's "Cloudflare named
  Tunnel as default." From Node it's `child_process.spawn`, **no npm dep** if we
  require the operator to have the binary; Cloudflare Access can sit in front as
  edge auth independent of our HMAC.

**Others (brief):** `localtunnel` — **avoid** (effectively unmaintained; unpatched
critical axios SSRF + open high-sev vulns). `bore`/`frp` — self-hostable single
binaries, no Node story, advanced-operator only. Legacy `ngrok` npm — superseded by
`@ngrok/ngrok`.

---

## 7. Decision framework & dependency-philosophy tension

The project ships **zero/minimal runtime deps**, an **esbuild-built artifact**, and
uses **optional dependencies** for heavyweight engines (gondolin/pi). That maps onto
the three postures:

| | (A) User fronts it | (B) Spawn sidecar (`--tunnel`) | (C) Embed SDK (`@ngrok/ngrok`) |
|---|---|---|---|
| npm deps added | none | **none** | one optional native dep (~11 MB) |
| Runtime requirement | operator runs a tunnel | an external **binary on PATH** | an ngrok account/authtoken |
| Bundle/artifact impact | none | none | external (optional), like gondolin/pi |
| First-run ergonomics | worst (DIY) | good (one flag, if binary present) | best (one flag, self-contained) |
| Who terminates TLS | operator's edge | CF/TS/ngrok edge | ngrok edge |
| Edge auth (defense-in-depth) | operator's | CF Access / TS ACL / ngrok OAuth | ngrok OAuth/IP/basic from Node |
| Our HMAC/bearer (§4) | **always on** | **always on** | **always on** |

The tension (INFERRED): A and B add **zero npm weight**; C trades zero-dep purity
for the only "it just works" experience — but stays disciplined *if* gated behind an
optional dependency the bundle treats as external (the project already does this).
**Ephemeral vs stable:** quick/TryCloudflare and free-tier ngrok churn the URL on
restart — fine for a demo, bad for a registered Alertmanager `url:` target; stable
ingress means a **named CF tunnel (own domain)** or an **ngrok reserved domain**,
both requiring operator account state.

---

## 8. Recommendation (tiered)

1. **Keep (A) as the default.** Loopback receiver; document Cloudflare named Tunnel
   (default) + ngrok (quick-start), as §6 already says. Our HMAC/bearer is the
   boundary.
2. **Add (B) `--tunnel <provider>` — the recommended next build.** Detect an
   installed `cloudflared`/`tailscale`/ngrok-agent, spawn it pointed at
   `127.0.0.1:<port>`, surface the public URL in the CLI/TUI, tear it down on
   shutdown. Default cloudflared to **named-tunnel-token** (stable, SSE-capable);
   offer `--quick` with the no-SSE/200-cap caveat. Best ergonomics-to-philosophy
   ratio: one external-binary requirement, **zero bundle weight**.
3. **Offer (C) `@ngrok/ngrok` as an optional dependency** for true one-command
   embedded ingress (mirrors gondolin/pi). Document the costs plainly (~11 MB native
   dep, ngrok account, ngrok-terminated TLS). Set edge OAuth/IP/basic-auth from Node
   as defense-in-depth — but **do not** rely on its `verify-webhook` for the incident
   path (it can't sign Alertmanager/Grafana).

In every tier the §4 invariants (fail-closed gate, HMAC-or-bearer constant-time over
the raw body, replay/dedupe) are unchanged and always on. The tunnel only changes who
terminates TLS and what optional edge auth sits in front. IP allowlists stay
discouraged (origin sees the *tunnel* IP).

---

## 9. Corrections to feed back into `webhook-triggers-research.md` §6

Two of §6's notes are now refined by verified findings (worth footnoting there):

1. **ngrok `verify-webhook` is NOT a broad edge-HMAC win for our senders.** It's
   named-provider-only with no generic-HMAC mode, and **neither Alertmanager nor
   Grafana is supported.** For the document's own motivating path, edge verification
   is unavailable — our `node:crypto` HMAC/bearer does the work. (§6's table credited
   it as "50+ providers, 403s bad sigs," which is true *only* for those named
   providers.)
2. **TryCloudflare quick tunnels don't support SSE and cap at 200 concurrent
   requests** — unfit for the live-run streaming in §7. Prefer **named** Cloudflare
   tunnels for anything beyond a bare hook-POST demo.

---

## 10. Open questions

1. **Build (B) first?** `--tunnel cloudflared|tailscale|ngrok` (spawn-installed) is
   the lowest-philosophy-cost way to get one-flag ingress. Worth doing before any
   embed.
2. **Is (C) worth a native optional dep?** ngrok-SDK embed is the nicest UX but adds
   an 11 MB native module + vendor account; gate behind opt-in like gondolin/pi.
3. **Stable-URL story** for a registered Alertmanager target — named CF tunnel (own
   domain) vs ngrok reserved domain; both need operator account state. Document the
   "your `url:` must be stable" requirement prominently.
4. **Tailscale headless onboarding** — is the OAuth→ephemeral-key automation worth
   documenting, or just assume "already on a tailnet"?

---

## 11. Sources

**ngrok:** [@ngrok/ngrok npm](https://www.npmjs.com/package/@ngrok/ngrok) · [ngrok-javascript](https://github.com/ngrok/ngrok-javascript) · [JS quickstart](https://ngrok.com/docs/getting-started/javascript) · [Config interface](https://ngrok.github.io/ngrok-javascript/interfaces/Config.html) · [verify-webhook action](https://ngrok.com/docs/traffic-policy/actions/verify-webhook) · [registry @ngrok/ngrok](https://registry.npmjs.org/@ngrok/ngrok)
**cloudflared:** [GitHub](https://github.com/cloudflare/cloudflared) · [downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) · [TryCloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) · [run params](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/) · [node-cloudflared](https://github.com/JacobLinCool/node-cloudflared) · [untun](https://github.com/unjs/untun)
**Tailscale:** [tsnet](https://pkg.go.dev/tailscale.com/tsnet) · [kb/1244 tsnet](https://tailscale.com/kb/1244/tsnet) · [libtailscale](https://github.com/tailscale/libtailscale) · [WASM #8315](https://github.com/tailscale/tailscale/issues/8315) · [tailscale-js (Bun)](https://github.com/mastermakrela/tailscale-js) · [Funnel kb/1223](https://tailscale.com/kb/1223/funnel) · [funnel CLI kb/1311](https://tailscale.com/kb/1311/tailscale-funnel) · [auth-keys](https://tailscale.com/docs/features/access-control/auth-keys) · [OAuth clients](https://tailscale.com/docs/features/oauth-clients)
**Pangolin:** [fosrl/pangolin](https://github.com/fosrl/pangolin) · [fosrl/newt](https://github.com/fosrl/newt) · [fosrl/gerbil](https://github.com/fosrl/gerbil) · [install site/Newt](https://docs.pangolin.net/manage/sites/install-site) · [Integration API](https://docs.pangolin.net/manage/integration-api) · [pricing/Cloud](https://pangolin.net/pricing) · [resource-API issue #1344](https://github.com/fosrl/pangolin/issues/1344)
**Other:** [localtunnel #724](https://github.com/localtunnel/localtunnel/issues/724) · [localtunnel Snyk](https://security.snyk.io/package/npm/localtunnel)
