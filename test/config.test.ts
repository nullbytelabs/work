import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, resolveModel } from "../src/config/index.ts";
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
  it("parses a valid config", () => {
    const c = parseConfig(sample);
    assert.equal(c.defaultModel, "kimi");
    assert.equal(c.providers["fireworks"]!.baseUrl, "https://api.fireworks.ai/inference/v1");
  });

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

  it("parses optional datasources/webhooks sections alongside providers/models", () => {
    const c = parseConfig({
      ...sample,
      datasources: { grafana: { baseUrl: "https://grafana.internal", token: "$GRAFANA_TOKEN" } },
      webhooks: { "deploy-incident": { workflow: "incident", auth: "hmac-sha256", datasources: ["grafana"] } },
    });
    assert.equal(c.datasources!["grafana"]!.baseUrl, "https://grafana.internal");
    assert.equal(c.webhooks!["deploy-incident"]!.workflow, "incident");
    // The model catalog is untouched by the new sections.
    assert.equal(c.defaultModel, "kimi");
  });

  it("leaves datasources/webhooks undefined when absent", () => {
    const c = parseConfig(sample);
    assert.equal(c.datasources, undefined);
    assert.equal(c.webhooks, undefined);
  });
});
