import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePartialConfig,
  mergeConfig,
  validateConfig,
  parseConfig,
} from "../src/config/index.ts";
import { makeDatasourceEgressResolver } from "../src/egress/datasource.ts";
import { composeResolvers, type ComposedJobNetwork } from "../src/egress/compose.ts";
import { UserFacingError } from "../src/errors.ts";
import type { PlannedJob } from "../src/compiler/index.ts";
import { MACHINE_TYPES } from "../src/compiler/index.ts";

/** A minimal PlannedJob — the datasource resolver ignores step content. */
function job(): PlannedJob {
  return { id: "j", runsOn: "gondolin", machine: MACHINE_TYPES.medium!, needs: [], steps: [] };
}

const withDs = {
  providers: {},
  models: {},
  datasources: {
    grafana: { baseUrl: "https://grafana.internal", token: "$GRAFANA_TOKEN" },
  },
  webhooks: {
    "deploy-incident": {
      workflow: "incident",
      enabled: true,
      auth: "hmac-sha256",
      secret: "$HOOK_DEPLOY_SECRET",
      signatureHeader: "X-Hub-Signature-256",
      datasources: ["grafana"],
    },
  },
};

describe("config: datasources + webhooks", () => {
  it("round-trips through parse/merge/validate", () => {
    const c = parseConfig(withDs);
    assert.equal(c.datasources!["grafana"]!.baseUrl, "https://grafana.internal");
    assert.equal(c.datasources!["grafana"]!.token, "$GRAFANA_TOKEN");
    const w = c.webhooks!["deploy-incident"]!;
    assert.equal(w.workflow, "incident");
    assert.equal(w.auth, "hmac-sha256");
    assert.deepEqual(w.datasources, ["grafana"]);
  });

  it("treats both sections as optional (absent is fine)", () => {
    const c = parseConfig({ providers: {}, models: {} });
    assert.equal(c.datasources, undefined);
    assert.equal(c.webhooks, undefined);
  });

  it("ignores unknown top-level keys", () => {
    const c = parseConfig({ providers: {}, models: {}, somethingElse: 42 });
    assert.equal(c.datasources, undefined);
  });

  it("rejects a malformed datasource (missing baseUrl)", () => {
    assert.throws(
      () => parsePartialConfig({ datasources: { bad: { token: "$X" } } }),
      (e) => e instanceof UserFacingError && /datasources\.bad needs a string baseUrl/.test(e.message),
    );
  });

  it("rejects a malformed webhook (missing workflow)", () => {
    assert.throws(
      () => parsePartialConfig({ webhooks: { bad: { auth: "bearer" } } }),
      (e) => e instanceof UserFacingError && /webhooks\.bad needs a string workflow/.test(e.message),
    );
  });

  it("rejects an invalid webhook auth scheme", () => {
    assert.throws(
      () => parsePartialConfig({ webhooks: { x: { workflow: "w", auth: "basic" } } }),
      (e) => e instanceof UserFacingError && /auth must be/.test(e.message),
    );
  });

  it("validateConfig rejects a webhook referencing an unknown datasource (same layer)", () => {
    assert.throws(
      () =>
        validateConfig(
          parsePartialConfig({
            datasources: { grafana: { baseUrl: "https://g" } },
            webhooks: { h: { workflow: "w", datasources: ["ghost"] } },
          }),
        ),
      (e) => e instanceof UserFacingError && /references unknown datasource "ghost"/.test(e.message),
    );
  });

  it("validateConfig stays lenient when no datasources map exists (cross-layer)", () => {
    // A webhook may reference a datasource defined in another layer; with no
    // `datasources` map present at all, we must NOT reject.
    const c = validateConfig(parsePartialConfig({ webhooks: { h: { workflow: "w", datasources: ["grafana"] } } }));
    assert.deepEqual(c.webhooks!["h"]!.datasources, ["grafana"]);
  });

  it("validateConfig rejects an empty webhook workflow", () => {
    assert.throws(
      () => validateConfig(parsePartialConfig({ webhooks: { h: { workflow: "  " } } })),
      (e) => e instanceof UserFacingError && /workflow must be a non-empty string/.test(e.message),
    );
  });

  it("merges datasources/webhooks by key; omitted map inherits the lower layer", () => {
    const base = parsePartialConfig({
      datasources: { grafana: { baseUrl: "https://g" }, prom: { baseUrl: "https://p" } },
    });
    const over = parsePartialConfig({
      datasources: { grafana: { baseUrl: "https://g2" } }, // wholesale replace
      webhooks: { h: { workflow: "w" } },
    });
    const m = mergeConfig(base, over);
    assert.equal(m.datasources!["grafana"]!.baseUrl, "https://g2");
    assert.equal(m.datasources!["prom"]!.baseUrl, "https://p"); // inherited
    assert.equal(m.webhooks!["h"]!.workflow, "w");

    // A layer that omits datasources entirely inherits the lower layer's map.
    const m2 = mergeConfig(base, parsePartialConfig({ providers: {}, models: {} }));
    assert.deepEqual(Object.keys(m2.datasources!).sort(), ["grafana", "prom"]);
  });
});

describe("makeDatasourceEgressResolver", () => {
  it("grants scoped datasource host + token secret with $VAR expanded", () => {
    process.env["GRAFANA_TOKEN"] = "tok-abc";
    try {
      const c = parseConfig(withDs);
      const resolve = makeDatasourceEgressResolver(c, { datasources: ["grafana"] });
      const net = resolve(job());
      assert.deepEqual(net, {
        allowedHosts: ["grafana.internal"],
        secrets: { GRAFANA_TOKEN: { hosts: ["grafana.internal"], value: "tok-abc" } },
      });
    } finally {
      delete process.env["GRAFANA_TOKEN"];
    }
  });

  it("honors an explicit tokenEnv override", () => {
    process.env["MY_GRAF"] = "tok-xyz";
    try {
      const c = parseConfig({
        providers: {},
        models: {},
        datasources: { grafana: { baseUrl: "https://grafana.internal", token: "$MY_GRAF", tokenEnv: "MY_GRAF" } },
      });
      const net = makeDatasourceEgressResolver(c, { datasources: ["grafana"] })(job());
      assert.equal(net!.secrets!["MY_GRAF"]!.value, "tok-xyz");
    } finally {
      delete process.env["MY_GRAF"];
    }
  });

  it("denies by default when no datasources are scoped", () => {
    const c = parseConfig(withDs);
    assert.equal(makeDatasourceEgressResolver(c)(job()), undefined);
    assert.equal(makeDatasourceEgressResolver(c, { datasources: [] })(job()), undefined);
  });

  it("returns undefined when config is absent", () => {
    assert.equal(makeDatasourceEgressResolver(undefined, { datasources: ["grafana"] })(job()), undefined);
  });

  it("skips unknown scoped datasources without throwing", () => {
    const c = parseConfig(withDs);
    assert.equal(makeDatasourceEgressResolver(c, { datasources: ["ghost"] })(job()), undefined);
  });

  it("allowlists a token-less datasource without a secret", () => {
    const c = parseConfig({
      providers: {},
      models: {},
      datasources: { open: { baseUrl: "https://open.api" } },
    });
    const net = makeDatasourceEgressResolver(c, { datasources: ["open"] })(job());
    assert.deepEqual(net, { allowedHosts: ["open.api"] });
  });

  it("a resolve pin emits the rewrite, lifts the internal block for the IP, and scopes the secret to both forms", () => {
    process.env["K8S_TOKEN_T"] = "sa-tok";
    try {
      const c = parseConfig({
        providers: {},
        models: {},
        datasources: {
          k8s: { baseUrl: "https://work-triage.internal:7443", token: "$K8S_TOKEN_T", resolve: "127.0.0.1" },
        },
      });
      const net = makeDatasourceEgressResolver(c, { datasources: ["k8s"] })(job());
      assert.deepEqual(net, {
        allowedHosts: ["work-triage.internal"],
        allowedInternalHosts: ["127.0.0.1"],
        hostResolves: { "work-triage.internal": "127.0.0.1" },
        // The sandbox rewrites the URL host to the pin BEFORE injecting the
        // secret, so the scope must cover the pinned IP, not just the name.
        secrets: { K8S_TOKEN: { hosts: ["work-triage.internal", "127.0.0.1"], value: "sa-tok" } },
      });
    } finally {
      delete process.env["K8S_TOKEN_T"];
    }
  });

  it("an IPv6 resolve pin uses the bracketed URL-hostname form", () => {
    const c = parseConfig({
      providers: {},
      models: {},
      datasources: { v6: { baseUrl: "https://v6.internal", resolve: "::1" } },
    });
    const net = makeDatasourceEgressResolver(c, { datasources: ["v6"] })(job());
    assert.deepEqual(net!.hostResolves, { "v6.internal": "[::1]" });
    assert.deepEqual(net!.allowedInternalHosts, ["[::1]"]);
  });

  it("rejects a resolve that is not an IP literal", () => {
    assert.throws(
      () => parseConfig({ providers: {}, models: {}, datasources: { x: { baseUrl: "https://x", resolve: "evil.com" } } }),
      (e) => e instanceof UserFacingError && /resolve must be an IP address literal/.test(e.message),
    );
  });
});

describe("composeResolvers", () => {
  // A stand-in for the agent resolver shape: wildcard hosts + a model key secret.
  const agentLike = (_j: PlannedJob): ComposedJobNetwork | undefined => ({
    allowedHosts: ["*"],
    secrets: { PI_WF_MODEL_KEY: { hosts: ["api.fireworks.ai"], value: "model-key" } },
  });

  it("unions hosts and merges secrets by env-var name", () => {
    const dsLike = (_j: PlannedJob): ComposedJobNetwork | undefined => ({
      allowedHosts: ["grafana.internal"],
      secrets: { GRAFANA_TOKEN: { hosts: ["grafana.internal"], value: "tok" } },
    });
    const net = composeResolvers(
      (_j) => ({ allowedHosts: ["a.com"] }),
      dsLike,
    )(job());
    assert.deepEqual(net!.allowedHosts!.sort(), ["a.com", "grafana.internal"]);
    assert.deepEqual(net!.secrets, { GRAFANA_TOKEN: { hosts: ["grafana.internal"], value: "tok" } });
  });

  it("merges hostResolves across resolvers, first writer wins", () => {
    const net = composeResolvers(
      (_j) => ({ allowedHosts: ["a.internal"], hostResolves: { "a.internal": "127.0.0.1" } }),
      (_j) => ({ allowedHosts: ["b.internal"], hostResolves: { "b.internal": "10.0.0.5", "a.internal": "10.9.9.9" } }),
    )(job());
    assert.deepEqual(net!.hostResolves, { "a.internal": "127.0.0.1", "b.internal": "10.0.0.5" });
  });

  it("absorbs a wildcard: any ['*'] makes the union ['*']", () => {
    const dsLike = (_j: PlannedJob): ComposedJobNetwork | undefined => ({
      allowedHosts: ["grafana.internal"],
      secrets: { GRAFANA_TOKEN: { hosts: ["grafana.internal"], value: "tok" } },
    });
    const net = composeResolvers(agentLike, dsLike)(job());
    assert.deepEqual(net!.allowedHosts, ["*"]);
    assert.deepEqual(Object.keys(net!.secrets!).sort(), ["GRAFANA_TOKEN", "PI_WF_MODEL_KEY"]);
  });

  it("returns undefined when every resolver returns undefined", () => {
    const net = composeResolvers(
      (_j) => undefined,
      (_j) => undefined,
    )(job());
    assert.equal(net, undefined);
  });

  it("composes the real datasource resolver with an agent-like resolver", () => {
    process.env["GRAFANA_TOKEN"] = "tok-real";
    try {
      const c = parseConfig(withDs);
      const net = composeResolvers(
        agentLike,
        makeDatasourceEgressResolver(c, { datasources: ["grafana"] }),
      )(job());
      assert.deepEqual(net!.allowedHosts, ["*"]); // agent wildcard absorbs grafana host
      assert.equal(net!.secrets!["GRAFANA_TOKEN"]!.value, "tok-real");
      assert.equal(net!.secrets!["PI_WF_MODEL_KEY"]!.value, "model-key");
    } finally {
      delete process.env["GRAFANA_TOKEN"];
    }
  });
});
