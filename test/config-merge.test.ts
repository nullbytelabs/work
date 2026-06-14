/**
 * The merge-into-work.json writer (src/scaffold/config-merge.ts) — the shared
 * primitive the `create datasource` (and future webhook) generators ride on.
 * Unlike the scaffold writer, it intentionally edits an existing work.json by
 * adding one keyed entry, so it must: preserve everything else in the file,
 * refuse to clobber an existing entry without force, and validate the merged
 * shape before producing a write.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfigSection, planConfigMerge, writeConfigMerge } from "../src/scaffold/config-merge.ts";
import { UserFacingError } from "../src/errors.ts";

describe("mergeConfigSection (pure)", () => {
  const entry = { baseUrl: "https://grafana.example.com/api", token: "$GRAFANA_TOKEN", tokenEnv: "GRAFANA_TOKEN" };

  it("adds the section to a fresh config", () => {
    const merged = mergeConfigSection(undefined, "datasources", "grafana", entry, false);
    assert.deepEqual(merged, { datasources: { grafana: entry } });
  });

  it("preserves existing providers/models and unknown top-level keys", () => {
    const current = {
      providers: { fireworks: { baseUrl: "https://x", apiKey: "$K" } },
      models: { kimi: { provider: "fireworks", model: "m" } },
      defaultModel: "kimi",
      // an unknown/future top-level key must survive the round-trip
      experimental: { flag: true },
    };
    const merged = mergeConfigSection(current, "datasources", "grafana", entry, false);
    assert.deepEqual(merged.providers, current.providers);
    assert.deepEqual(merged.models, current.models);
    assert.equal(merged.defaultModel, "kimi");
    assert.deepEqual(merged.experimental, { flag: true });
    assert.deepEqual((merged.datasources as Record<string, unknown>).grafana, entry);
  });

  it("adds alongside an existing datasource entry", () => {
    const current = { datasources: { loki: { baseUrl: "https://loki" } } };
    const merged = mergeConfigSection(current, "datasources", "grafana", entry, false);
    assert.deepEqual(Object.keys(merged.datasources as object).sort(), ["grafana", "loki"]);
  });

  it("refuses to overwrite an existing key without force", () => {
    const current = { datasources: { grafana: { baseUrl: "https://old" } } };
    assert.throws(() => mergeConfigSection(current, "datasources", "grafana", entry, false), UserFacingError);
  });

  it("overwrites an existing key with force", () => {
    const current = { datasources: { grafana: { baseUrl: "https://old" } } };
    const merged = mergeConfigSection(current, "datasources", "grafana", entry, true);
    assert.deepEqual((merged.datasources as Record<string, unknown>).grafana, entry);
  });

  it("rejects a malformed entry (validates the merged shape)", () => {
    // a datasource needs a string baseUrl — parsePartialConfig should reject this
    assert.throws(() => mergeConfigSection(undefined, "datasources", "bad", { token: "$X" }, false), UserFacingError);
  });
});

describe("planConfigMerge / writeConfigMerge (disk)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "pi-wf-merge-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  const entry = { baseUrl: "https://grafana.example.com/api", token: "$GRAFANA_TOKEN", tokenEnv: "GRAFANA_TOKEN" };

  it("creates work.json when absent and reports a compact entry", async () => {
    const plan = await planConfigMerge(ws, "datasources", "grafana", entry, false);
    assert.equal(plan.created, true);
    assert.equal(plan.rel, "work.json");
    assert.equal(plan.entryText, JSON.stringify(entry)); // one line, bounded
    await writeConfigMerge(plan, { dryRun: false, color: false });
    const written = JSON.parse(await readFile(join(ws, "work.json"), "utf-8"));
    assert.deepEqual(written.datasources.grafana, entry);
  });

  it("merges into an existing work.json without losing prior content", async () => {
    await writeFile(
      join(ws, "work.json"),
      JSON.stringify({ providers: { p: { baseUrl: "https://x", apiKey: "$K" } }, models: {} }, null, 2),
    );
    const plan = await planConfigMerge(ws, "datasources", "grafana", entry, false);
    assert.equal(plan.created, false);
    await writeConfigMerge(plan, { dryRun: false, color: false });
    const written = JSON.parse(await readFile(join(ws, "work.json"), "utf-8"));
    assert.ok(written.providers.p, "prior providers survive");
    assert.deepEqual(written.datasources.grafana, entry);
  });

  it("dry run writes nothing", async () => {
    const plan = await planConfigMerge(ws, "datasources", "grafana", entry, false);
    await writeConfigMerge(plan, { dryRun: true, color: false });
    assert.equal(existsSync(join(ws, "work.json")), false);
  });

  it("rejects an existing work.json that is not valid JSON", async () => {
    await writeFile(join(ws, "work.json"), "{ not json");
    await assert.rejects(() => planConfigMerge(ws, "datasources", "grafana", entry, false), UserFacingError);
  });
});
