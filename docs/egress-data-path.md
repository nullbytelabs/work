# Egress data path: how a guest byte reaches an upstream

The five invariants of gondolin's egress path, distilled from the SDK
source (`node_modules/@earendil-works/gondolin/dist/src`, v0.8.x — paths below
are into that tree). Every design that touches sandbox networking should be
checked against these **before** it grows workarounds; each invariant is
short, load-bearing, and non-obvious from the option names alone.

> **Provenance:** the k8s-triage example (June 2026) was first built on the
> assumption that guests connect to upstreams directly, which forced LAN-IP
> binding and certificate patching onto a local kind cluster. Twenty minutes
> in the files cited here falsified the assumption and deleted all of it. The
> SDK ships readable compiled JS — when a design hinges on sandbox behavior,
> that source is the spec.

## 1. Guest DNS is synthetic

The host-side network backend answers all guest DNS itself
(`qemu/net.js`, `qemu/dns.js: buildSyntheticDnsResponse`). Guests never see a
real address: names resolve to TEST-NET (`192.0.2.1`) or, in per-host mapping
mode, to per-name synthetic IPs in `198.19.0.0/16`. Guest-side resolvability
of a hostname is therefore **irrelevant** to whether it can be reached.

The one carve-out: `localhost` and `*.localhost` are RFC-6761 special-cased
(`qemu/dns.js: isLocalhostDnsName`) and answered with `127.0.0.1` — the
guest's **own** loopback. A dial to such a name never leaves the VM. Never
use a `.localhost` name as a guest-facing upstream label. (Model providers on
the engine host's loopback are handled for you: `loopbackModelPin`
(`src/agent/guest-pi-runner.ts`) hands the guest an alias hostname and the
egress resolver pins it back to the loopback IP host-side, so a
`baseUrl: http://localhost:8000/v1` provider just works.)

## 2. The guest-dialed IP is ignored; the host re-resolves the hostname

Intercepted TCP flows are classified, and for HTTP(S) the request's hostname
(SNI / URL host) is what routes: the host re-resolves it with Node's
`dns.lookup` and dials from the **engine process**
(`qemu/http.js: resolveHostname`, `http/utils.js: createLookupGuard`). The
address the guest dialed is never used upstream.

Consequence: **any public upstream the engine host can resolve is reachable
from a job** — provided policy allows it (3) and the hostname resolves
host-side.

## 3. Policy runs on the host-resolved IP; internal ranges stay blocked

`isIpAllowed` (`http/hooks.js`) checks the hostname against `allowedHosts`,
then blocks internal ranges — loopback, RFC1918, link-local, CGNAT, and IPv6
equivalents — **on the host-resolved IP**. work grants jobs allow-all *public*
egress (`allowedHosts: ["*"]`, `src/agent/egress.ts`) but never lifts the
internal-range block, so opening public egress does not expose host-loopback or
private-network services to a job.

## 4. `onRequest` runs before everything that matters

Inside `createHttpHooks` (`http/hooks.js`), the user `onRequest` hook runs
**first**, then secret placeholders are swapped in, then (back in
`qemu/http.js`) policy checks run and undici dials the final URL. So a URL
rewrite in `onRequest` redirects the dial, and everything downstream — secret
scoping, `isIpAllowed`, TLS verification — sees the **rewritten** host.

The engine uses exactly this ordering to inject the model API key: when a
model is configured, `makeAgentEgressResolver` (`src/agent/egress.ts`) scopes a
header-only secret to the model host, so the placeholder is swapped into the
Authorization header for that one host and the real key never enters the guest.
Upstream TLS is verified host-side with Node's trust store, against the dialed
host — `NODE_EXTRA_CA_CERTS` on the `work` process is honored.

## 5. Mapped TCP (`tcp.hosts`) is a different animal

Gondolin's `tcp.hosts` option is raw passthrough: it bypasses HTTP
inspection, policy hooks, **and secret injection**. It is never appropriate
for anything credential-bearing; the engine deliberately does not expose it.

## Quick implications table

| You want | The answer |
|---|---|
| Reach a public upstream from a job | Egress is open (`allowedHosts: ["*"]`) for every job — no allowlist to maintain |
| Use a local model server (llama.cpp, ollama, omlx) | Just set the provider's `baseUrl` to `http://localhost:<port>/...` — the engine aliases the host for the guest and pins it back to loopback host-side (`loopbackModelPin`) |
| A guest-facing hostname | Any label works — it only needs to resolve host-side; never `localhost`/`*.localhost` |
| Pass a credential to a `run:` step or action | Put it in the `secrets:` whitelist in `work.json` and reference `${{ secrets.NAME }}` — it flows into the step env, never via the allowlist |
| Keep the model key out of the guest | Automatic — it's host-injected and scoped to the model host (`makeAgentEgressResolver`); no guest env ever sees it |
| Custom upstream CA | `NODE_EXTRA_CA_CERTS` on the `work` process (host side); in-guest, clients verify the sandbox's MITM CA instead |
| Raw TCP to a fixed target | `tcp.hosts` exists but forfeits mediation and secrets — don't, for anything credential-bearing |
