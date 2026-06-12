# Egress data path: how a guest byte reaches an upstream

The five invariants of gondolin's mediated egress, distilled from the SDK
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
use a `.localhost` name as a guest-facing upstream label.

## 2. The guest-dialed IP is ignored; the host re-resolves the hostname

Intercepted TCP flows are classified, and for HTTP(S) the request's hostname
(SNI / URL host) is what routes: the host re-resolves it with Node's
`dns.lookup` and dials from the **engine process**
(`qemu/http.js: resolveHostname`, `http/utils.js: createLookupGuard`). The
address the guest dialed is never used upstream.

Consequence: **anything the engine host can reach is reachable from a job**,
including the host's own loopback — provided policy allows it (3) and the
hostname resolves host-side or is pinned (4).

## 3. Policy runs on the host-resolved IP; `allowedInternalHosts` lifts the private-range block

`isIpAllowed` (`http/hooks.js`) checks the hostname against `allowedHosts`,
then blocks internal ranges — loopback, RFC1918, link-local, CGNAT, and IPv6
equivalents — **on the host-resolved IP**, unless the hostname matches
`allowedInternalHosts`. That lift covers loopback, and its entries are
implicitly merged into the allowlist.

## 4. `onRequest` runs before everything that matters

Inside `createHttpHooks` (`http/hooks.js`), the user `onRequest` hook runs
**first**, then secret placeholders are swapped in, then (back in
`qemu/http.js`) policy checks run and undici dials the final URL. So a URL
rewrite in `onRequest` redirects the dial, and everything downstream — secret
scoping, `isIpAllowed`, TLS verification — sees the **rewritten** host.

This is how the engine implements datasource `resolve` pins (curl
`--resolve` analog): `makeResolveHook` (`src/targets/gondolin.ts`) rewrites
the pinned hostname to its IP, and the datasource egress resolver
(`src/egress/datasource.ts`) adds the pinned IP to `allowedInternalHosts`
**and** to the token's secret scope — both are required, because post-rewrite
the IP is the hostname.

Upstream TLS is verified host-side with Node's trust store, against the
post-rewrite host — `NODE_EXTRA_CA_CERTS` on the `work` process is honored,
and a raw-IP target needs that IP in the certificate's SANs (kind's default
API-server cert carries `127.0.0.1`, which is why the k8s-triage example
needs no certificate patching).

## 5. Mapped TCP (`tcp.hosts`) is a different animal

Gondolin's `tcp.hosts` option is raw passthrough: it bypasses HTTP
inspection, policy hooks, **and secret injection**. It is never appropriate
for datasources or anything credential-bearing; the engine deliberately does
not expose it.

## Quick implications table

| You want | The answer |
|---|---|
| Reach a service on the engine host's loopback | Datasource with `resolve: "127.0.0.1"`; any non-`.localhost` hostname label |
| Reach a private-IP upstream with a real DNS name | Its hostname must end up in `allowedInternalHosts` (the datasource resolver derives this from `resolve`) |
| A guest-facing hostname | Any label works — it only needs to resolve host-side **or** be pinned; never `localhost`/`*.localhost` |
| Custom upstream CA | `NODE_EXTRA_CA_CERTS` on the `work` process (host side); in-guest, clients verify the sandbox's MITM CA instead |
| Raw TCP to a fixed target | `tcp.hosts` exists but forfeits mediation and secrets — don't, for anything credential-bearing |
