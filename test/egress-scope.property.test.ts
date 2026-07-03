/**
 * Security property tests: the model key is scoped to *exactly* the host that is
 * allowlisted, which is *exactly* what `modelHostOf` derives from a `baseUrl`.
 * Target S-3 — see the Security track in docs/property-based-testing.md.
 *
 * The seam: `modelHostOf` (src/agent/guest-pi-runner.ts) derives a host from a
 * `baseUrl` and feeds it, verbatim, into BOTH the gondolin egress allowlist AND the
 * injected key's `hosts` scope. That host literal then becomes a gondolin
 * `matchHostname` *pattern* (vendor code). If the literal isn't an exact pattern, a
 * key is injected for an unintended host (leak) or a host is reachable without it.
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
 * silently scope a key to a whole pattern. `modelHostOf` now refuses a `*`-bearing
 * host (fail closed); P1/P4 pin that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

// The REAL vendor matcher (relative path bypasses the package `exports` gate).
import { matchHostname } from "../node_modules/@earendil-works/gondolin/dist/src/host/patterns.js";
import { modelHostOf } from "../src/agent/guest-pi-runner.ts";
import { makeAgentEgressResolver } from "../src/agent/index.ts";
import type { WorkConfig } from "../src/config/index.ts";
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

// A literal (non-`$`) key, so config expansion (expandEnvStrict / resolveModel)
// never couples these properties to ambient env vars.
const literalSecret = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), { minLength: 1, maxLength: 12 }).map((a) => "sek_" + a.join(""));

function agentStep(name: string, model?: string): PlannedStep {
  return { name, uses: "work/agent", env: {}, ...(model ? { with: { model } } : {}) };
}
const AGENT_JOB: PlannedJob = { id: "a", runsOn: "gondolin", machine: { cpus: 2, memory: "8G" }, needs: [], steps: [agentStep("a/0")] };

// ── P1: a derived host is an exact matchHostname pattern ─────────────────────
// The contract every allowlist/key entry rides on. (a) no wildcard escape
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

// ── P4: agent egress is allow-all, but the model key stays confined to its host ─
// The agent path grants `allowedHosts: ["*"]` (so the guest can npm-install Pi),
// which makes key-confinement load-bearing: the injected key must be scoped to the
// concrete model host and NOT injected for any other host that allow-all egress can
// reach. A `*`-bearing model host must drop the key entirely (fail closed).
const providerHostArb = fc.oneof(dnsHost, specialHost); // includes the `a*b.example` wildcard probe
const modelConfigArb = providerHostArb.chain((host) =>
  fc.tuple(port, literalSecret).map(([p, key]): WorkConfig => ({
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
