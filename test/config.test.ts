import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, resolveModel, mergeConfig, parseJsonc, stripJsonc } from "../src/config/index.ts";
import { UserFacingError } from "../src/errors.ts";

const sample = {
  providers: {
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", apiKey: "$FW_KEY" },
  },
  models: {
    kimi: { provider: "fireworks", model: "accounts/fireworks/models/kimi-k2p6", maxTokens: 256 },
  },
  defaultModel: "kimi",
};

describe("config", () => {
  it("resolves a model and expands $ENV in the apiKey", () => {
    process.env["FW_KEY"] = "secret-123";
    const c = parseConfig(sample);
    const m = resolveModel(c); // default
    assert.equal(m.baseUrl, "https://api.fireworks.ai/inference/v1");
    assert.equal(m.model, "accounts/fireworks/models/kimi-k2p6");
    assert.equal(m.apiKey, "secret-123");
    assert.equal(m.maxTokens, 256);
    delete process.env["FW_KEY"];
  });

  it("throws (not a blank key) when the apiKey's $ENV is unset", () => {
    delete process.env["FW_KEY"];
    const c = parseConfig(sample);
    assert.throws(
      () => resolveModel(c),
      (e) => e instanceof UserFacingError && /FW_KEY/.test(e.message) && /not set/.test(e.message),
    );
  });

  it("rejects a model that references an unknown provider", () => {
    assert.throws(
      () => parseConfig({ providers: {}, models: { x: { provider: "ghost", model: "m" } } }),
      (e) => e instanceof UserFacingError && /unknown provider "ghost"/.test(e.message),
    );
  });

  it("errors resolving an unknown model alias", () => {
    const c = parseConfig(sample);
    assert.throws(
      () => resolveModel(c, "nope"),
      (e) => e instanceof UserFacingError && /not defined in config\.models/.test(e.message),
    );
  });

  // The webhooks parse shape (present, absent, malformed, merge) is owned by
  // test/config-merge.test.ts and test/scaffold-webhook.test.ts — not re-asserted here.
});

describe("config — observability", () => {
  // Regression: parse/merge whitelisted known keys, silently dropping `observability`
  // so config-native telemetry never enabled (only OTEL_* env did). Keep it surviving.
  it("parses and preserves the observability block (incl. $VAR headers)", () => {
    const c = parseConfig({
      ...sample,
      observability: {
        enabled: true,
        otlpEndpoint: "https://otlp.example/otlp",
        headers: { Authorization: "Basic $GRAFANA_CLOUD_OTLP_TOKEN" },
        metricExportIntervalMs: 5000,
        traces: { enabled: true },
        metrics: { enabled: false },
      },
    });
    assert.equal(c.observability?.enabled, true);
    assert.equal(c.observability?.otlpEndpoint, "https://otlp.example/otlp");
    assert.equal(c.observability?.headers?.["Authorization"], "Basic $GRAFANA_CLOUD_OTLP_TOKEN");
    assert.equal(c.observability?.metricExportIntervalMs, 5000);
    assert.equal(c.observability?.metrics?.enabled, false);
  });

  it("survives a layer merge (project overrides global wholesale)", () => {
    const merged = mergeConfig(
      parseConfig({ ...sample, observability: { enabled: false, otlpEndpoint: "https://global/otlp" } }),
      parseConfig({ ...sample, observability: { enabled: true, otlpEndpoint: "https://project/otlp" } }),
    );
    assert.equal(merged.observability?.enabled, true);
    assert.equal(merged.observability?.otlpEndpoint, "https://project/otlp");
  });

  it("rejects a malformed observability block", () => {
    assert.throws(() => parseConfig({ ...sample, observability: { enabled: "yes" } }), UserFacingError);
    assert.throws(() => parseConfig({ ...sample, observability: { headers: { X: 5 } } }), UserFacingError);
  });

  it("leaves observability undefined when absent", () => {
    assert.equal(parseConfig(sample).observability, undefined);
  });
});

describe("JSONC (work.json's on-disk form)", () => {
  it("strips line and block comments and trailing commas", () => {
    const text = `{
      // a line comment
      "providers": {
        /* a block
           comment */
        "p": { "baseUrl": "https://x/v1", "apiKey": "$K" },
      },
      "models": { "m": { "provider": "p", "model": "id" }, },
      "defaultModel": "m",
    }`;
    const cfg = parseConfig(parseJsonc(text));
    assert.equal(cfg.defaultModel, "m");
    assert.equal(cfg.providers.p!.baseUrl, "https://x/v1");
  });

  it("preserves `//` and commas that live inside strings", () => {
    const out = parseJsonc('{ "baseUrl": "https://api.example/v1", "note": "a, b]" }') as Record<string, string>;
    assert.equal(out["baseUrl"], "https://api.example/v1"); // the // in the URL survived
    assert.equal(out["note"], "a, b]"); // the comma-before-bracket inside a string survived
  });

  it("keeps line numbers so a parse error still points at the right place", () => {
    // The comment lines are blanked, not removed, so the bad token stays on line 3.
    const stripped = stripJsonc(`{\n  // c\n  bad\n}`);
    assert.equal(stripped.split("\n").length, 4);
  });

  it("still rejects genuinely malformed JSON", () => {
    assert.throws(() => parseJsonc("{ not: valid }"));
  });
});
