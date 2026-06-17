/**
 * Security property tests: a credential is scoped to *exactly* the host that is
 * allowlisted, which is *exactly* what our host derivation produces from a
 * `baseUrl`. Target S-3 — see the Security track in docs/property-based-testing.md.
 *
 * The seam: `hostOf` (src/egress/datasource.ts) and `modelHostOf`
 * (src/agent/guest-pi-runner.ts) both derive a host from a `baseUrl` and feed it,
 * verbatim, into BOTH the gondolin egress allowlist AND the injected secret's
 * `hosts` scope. That host literal then becomes a gondolin `matchHostname`
 * *pattern* (vendor code). If the two derivations diverge, or the literal isn't an
 * exact pattern, a token is injected for an unintended host (leak) or a host is
 * reachable without its token.
 *
 * We do NOT re-test the vendor regex — we import the REAL `matchHostname` and lock
 * the contract we depend on: "a derived host matches itself and no structurally
 * distinct host; never a wildcard." A gondolin auto-bump that loosened matching
 * (suffix match, wildcard leak) turns these red instead of silently widening
 * egress. The matcher is reached by relative path on purpose — its package
 * `exports` map hides the subpath, but the file is the contract spec (per AGENTS.md
 * "Gondolin's behavior is checkable in node_modules/.../dist").
 *
 * Found here (F-8): `new URL("https://a*b.example").hostname` is `"a*b.example"` —
 * the `*` survives URL parsing, and `matchHostname` splits a pattern on `*` before
 * escaping, so that literal is a WILDCARD. A `baseUrl` host containing `*` would
 * silently scope a token/key to a whole pattern. Both derivations now refuse a
 * `*`-bearing host (fail closed); P1/P3/P4 pin that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

// The REAL vendor matcher (relative path bypasses the package `exports` gate).
import { matchHostname, matchesAnyHost } from "../node_modules/@earendil-works/gondolin/dist/src/host/patterns.js";
import { modelHostOf } from "../src/agent/guest-pi-runner.ts";
import { makeDatasourceEgressResolver } from "../src/egress/index.ts";
import { makeAgentEgressResolver } from "../src/agent/index.ts";
import type { PiWorkflowsConfig } from "../src/config/index.ts";
import type { PlannedJob, PlannedStep } from "../src/compiler/index.ts";

// ── arbitraries ──────────────────────────────────────────────────────────────

// A normal DNS host, sometimes mixed-case (the matcher is case-insensitive).
const labelChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-".split(""));
const label = fc.array(labelChar, { minLength: 1, maxLength: 8 }).map((a) => a.join(""));
const dnsHost = fc.array(label, { minLength: 1, maxLength: 4 }).map((a) => a.join("."));

// Adversarial host material. `*` is the dangerous one (survives URL parsing AND is
// the only matcher-special char it doesn't escape); the rest are forbidden host
// code points or regex metachars that should be escaped or rejected.
const nastyChar = fc.constantFrom(..."*.+?^${}()|[]\\-a1".split(""));
const nastyHost = fc.array(nastyChar, { minLength: 1, maxLength: 10 }).map((a) => a.join(""));

// Forms whose canonicalization the doc calls out: IPv6 (bracketed), IDN
// (punycoded), and a trailing-dot FQDN root.
const specialHost = fc.constantFrom("[::1]", "[2001:db8::1]", "bücher.example", "münchen.de", "example.com.", "a*b.example");

const hostArb = fc.oneof(dnsHost, nastyHost, specialHost);
const port = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined });
const path = fc.constantFrom("", "/", "/api", "/inference/v1");
const baseUrlArb = fc.tuple(hostArb, port, path).map(([h, p, pth]) => `https://${h}${p ? `:${p}` : ""}${pth}`);

// A literal (non-`$`) token/key, so config expansion (expandEnvStrict / resolveModel)
// never couples these properties to ambient env vars.
const literalSecret = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), { minLength: 1, maxLength: 12 }).map((a) => "sek_" + a.join(""));
const ipLiteral = fc.constantFrom("10.0.0.5", "192.168.1.9", "127.0.0.1", "[::1]", "[fd00::1]");

const JOB: PlannedJob = { id: "j", runsOn: "gondolin", machine: { cpus: 2, memory: "8G" }, needs: [], steps: [{ name: "j/0", run: "true", env: {} }] };

function agentStep(name: string, model?: string): PlannedStep {
  return { name, uses: "work/agent", env: {}, ...(model ? { with: { model } } : {}) };
}
const AGENT_JOB: PlannedJob = { id: "a", runsOn: "gondolin", machine: { cpus: 2, memory: "8G" }, needs: [], steps: [agentStep("a/0")] };

// ── P1: a derived host is an exact matchHostname pattern ─────────────────────
// The contract every allowlist/secret entry rides on. (a) no wildcard escape
// (the F-8 fix); (b) the literal matches itself; (c) and nothing structurally
// distinct — locks the vendor matcher against loosening (suffix/substring match).
test("egress-scope · a derived host is an exact matchHostname pattern (no wildcard escape)", () => {
  fc.assert(
    fc.property(baseUrlArb, (baseUrl) => {
      const h = modelHostOf(baseUrl);
      if (h === undefined) return; // unparseable or refused (`*`) — nothing is emitted
      assert.ok(!h.includes("*"), `derived host ${JSON.stringify(h)} is a wildcard pattern`);
      assert.ok(matchHostname(h, h), `host ${JSON.stringify(h)} fails to match its own pattern`);
      for (const other of [`x.${h}`, `${h}.evil`, `pre${h}`, `${h}post`]) {
        if (other.toLowerCase() === h.toLowerCase()) continue;
        assert.ok(!matchHostname(other, h), `pattern ${JSON.stringify(h)} leaked to ${JSON.stringify(other)}`);
      }
    }),
  );
});

// ── P2: the two derivations agree at the resolver boundary ───────────────────
// `hostOf` (datasource) must equal `modelHostOf` (agent) for the same baseUrl, or a
// credential and its allowlist could be derived against different hosts. Compared
// through the datasource resolver's emitted `allowedHosts` so `hostOf` stays private.
test("egress-scope · datasource and agent host derivations agree (no seam divergence)", () => {
  fc.assert(
    fc.property(baseUrlArb, (baseUrl) => {
      const expected = modelHostOf(baseUrl);
      const config: PiWorkflowsConfig = { providers: {}, models: {}, datasources: { ds: { baseUrl } } }; // token-less: compare hosts only
      const net = makeDatasourceEgressResolver(config, { datasources: ["ds"] })(JOB);
      if (expected === undefined) {
        // fail-closed: a `*`-bearing or unparseable host yields no datasource egress
        assert.ok(net === undefined || (net.allowedHosts ?? []).length === 0, `expected no egress for ${JSON.stringify(baseUrl)}, got ${JSON.stringify(net?.allowedHosts)}`);
      } else {
        assert.deepEqual(net?.allowedHosts, [expected], `datasource host disagrees with modelHostOf for ${JSON.stringify(baseUrl)}`);
      }
    }),
  );
});

// ── P3: a datasource token is scoped only to allowlisted, non-wildcard hosts ──
// For any config + scope, every host a secret is scoped to is reachable (⊆ the
// allowlist) and is never a wildcard. The credential never lands on a host the job
// can't reach, and never on a pattern.
const dsEntry = fc.record({
  baseUrl: baseUrlArb,
  token: fc.option(literalSecret, { nil: undefined }),
  resolve: fc.option(ipLiteral, { nil: undefined }),
});
const dsConfigArb = fc
  .dictionary(fc.constantFrom("grafana", "loki", "prom", "tempo", "api"), dsEntry, { minKeys: 1, maxKeys: 5 })
  .chain((datasources) => {
    const names = Object.keys(datasources);
    // Scope may include real names and unknown ones (the resolver must skip unknowns).
    return fc.subarray([...names, "ghost", "missing"], { minLength: 0 }).map((scope) => ({ datasources, scope }));
  });

test("egress-scope · a datasource token is scoped only to allowlisted, non-wildcard hosts", () => {
  fc.assert(
    fc.property(dsConfigArb, ({ datasources, scope }) => {
      const net = makeDatasourceEgressResolver({ providers: {}, models: {}, datasources }, { datasources: scope })(JOB);
      if (!net) return; // nothing scoped/resolvable — vacuously fine
      const allow = net.allowedHosts ?? [];
      const internal = net.allowedInternalHosts ?? [];
      for (const s of Object.values(net.secrets ?? {})) {
        for (const host of s.hosts) {
          assert.ok(!host.includes("*"), `token scoped to a wildcard host ${JSON.stringify(host)}`);
          // Reachable: either an allowlisted host or a pinned internal host (resolve).
          assert.ok(matchesAnyHost(host, allow) || internal.includes(host), `token scoped to ${JSON.stringify(host)} not in allowlist ${JSON.stringify(allow)} / internal ${JSON.stringify(internal)}`);
        }
      }
    }),
  );
});

// ── P4: agent egress is allow-all, but the model key stays confined to its host ─
// The agent path grants `allowedHosts: ["*"]` (so the guest can npm-install Pi),
// which makes key-confinement load-bearing: the injected key must be scoped to the
// concrete model host and NOT injected for any other host that allow-all egress can
// reach. A `*`-bearing model host must drop the key entirely (fail closed).
const providerHostArb = fc.oneof(dnsHost, specialHost); // includes the `a*b.example` wildcard probe
const modelConfigArb = providerHostArb.chain((host) =>
  fc.tuple(port, literalSecret).map(([p, key]): PiWorkflowsConfig => ({
    providers: { prov: { baseUrl: `https://${host}${p ? `:${p}` : ""}/v1`, apiKey: key } },
    models: { m: { provider: "prov", model: "some-model" } },
    defaultModel: "m",
  })),
);

test("egress-scope · agent egress is allow-all but the model key stays confined to its host", () => {
  fc.assert(
    fc.property(modelConfigArb, (config) => {
      const net = makeAgentEgressResolver(config)(AGENT_JOB);
      assert.deepEqual(net?.allowedHosts, ["*"], "an agent job gets mediated allow-all egress");
      const secrets = Object.values(net?.secrets ?? {});
      const FOREIGN = "attacker-controlled.example"; // a host allow-all egress would reach
      for (const s of secrets) {
        for (const host of s.hosts) {
          assert.ok(!host.includes("*"), `model key scoped to a wildcard host ${JSON.stringify(host)}`);
          assert.ok(matchHostname(host, host), `model-key host ${JSON.stringify(host)} fails its own pattern`);
          assert.ok(!matchHostname(FOREIGN, host), `model key would inject for the foreign host ${JSON.stringify(FOREIGN)}`);
        }
      }
    }),
  );
});
