import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCreateDatasource,
  buildDatasourceEntry,
  resolvePreset,
  tokenEnvFor,
  DATASOURCE_PRESETS,
} from "../src/scaffold/datasource.ts";
import { parseConfig } from "../src/config/index.ts";
import { UserFacingError } from "../src/errors.ts";

const CONFIG = "work.json";

describe("tokenEnvFor (matches the resolver derivation)", () => {
  it("derives <NAME>_TOKEN, collapsing non-alphanumerics", () => {
    assert.equal(tokenEnvFor("grafana"), "GRAFANA_TOKEN");
    assert.equal(tokenEnvFor("my-grafana"), "MY_GRAFANA_TOKEN");
  });
});

describe("resolvePreset", () => {
  it("prefers an explicit preset over the name", () => {
    assert.equal(resolvePreset("my-graf", "grafana").id, "grafana");
  });
  it("infers from a name that matches a preset id", () => {
    assert.equal(resolvePreset("grafana", undefined).id, "grafana");
  });
  it("falls back to generic for an unknown name", () => {
    assert.equal(resolvePreset("foo", undefined).id, "generic");
  });
  it("throws on an unknown explicit preset", () => {
    assert.throws(() => resolvePreset("foo", "nope"), UserFacingError);
  });
});

describe("buildDatasourceEntry", () => {
  it("emits a $VAR token ref (never a literal) and an explicit tokenEnv", () => {
    const e = buildDatasourceEntry("grafana", DATASOURCE_PRESETS["grafana"]!, undefined);
    assert.equal(e.token, "$GRAFANA_TOKEN");
    assert.equal(e.tokenEnv, "GRAFANA_TOKEN");
    assert.equal(typeof e.token, "string");
    assert.match(e.token as string, /^\$/);
  });
  it("uses the preset baseUrl, overridable by --url", () => {
    const preset = DATASOURCE_PRESETS["grafana"]!;
    assert.equal(buildDatasourceEntry("g", preset, undefined).baseUrl, preset.baseUrl);
    assert.equal(buildDatasourceEntry("g", preset, "https://real.host/api").baseUrl, "https://real.host/api");
  });
  it("never emits a resolve key (deployment-specific)", () => {
    const e = buildDatasourceEntry("grafana", DATASOURCE_PRESETS["grafana"]!, undefined);
    assert.equal("resolve" in e, false);
  });
});

describe("runCreateDatasource (integration, real temp dir)", () => {
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), "pi-wf-ds-"));
  });
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  async function readCfg() {
    return JSON.parse(await readFile(join(proj, CONFIG), "utf-8"));
  }

  it("merges a generic datasource into a fresh work.json", async () => {
    const code = await runCreateDatasource(["api"], proj);
    assert.equal(code, 0);
    const cfg = await readCfg();
    // Valid config object.
    assert.doesNotThrow(() => parseConfig(cfg));
    const ds = cfg.datasources.api;
    assert.equal(resolvePreset("api", undefined).id, "generic");
    assert.equal(ds.baseUrl, DATASOURCE_PRESETS["generic"]!.baseUrl);
    // token is a $VAR ref, never a literal secret.
    assert.equal(ds.token, "$API_TOKEN");
    assert.equal(ds.tokenEnv, "API_TOKEN");
    assert.equal("resolve" in ds, false);
  });

  it("fills the right baseUrl/tokenHeader for a preset (grafana)", async () => {
    await runCreateDatasource(["grafana"], proj);
    const ds = (await readCfg()).datasources.grafana;
    const preset = DATASOURCE_PRESETS["grafana"]!;
    assert.equal(ds.baseUrl, preset.baseUrl);
    // grafana authenticates via the default Authorization header, so no tokenHeader.
    assert.equal("tokenHeader" in ds, preset.tokenHeader !== undefined);
    if (preset.tokenHeader !== undefined) assert.equal(ds.tokenHeader, preset.tokenHeader);
  });

  it("infers the preset from the name", async () => {
    await runCreateDatasource(["loki"], proj);
    assert.equal((await readCfg()).datasources.loki.baseUrl, DATASOURCE_PRESETS["loki"]!.baseUrl);
  });

  it("uses an explicit --preset over the name", async () => {
    await runCreateDatasource(["my-graf", "--preset", "grafana"], proj);
    const ds = (await readCfg()).datasources["my-graf"];
    assert.equal(ds.baseUrl, DATASOURCE_PRESETS["grafana"]!.baseUrl);
    assert.equal(ds.tokenEnv, "MY_GRAF_TOKEN");
  });

  it("honors --url override", async () => {
    await runCreateDatasource(["grafana", "--url", "https://grafana.internal/api"], proj);
    assert.equal((await readCfg()).datasources.grafana.baseUrl, "https://grafana.internal/api");
  });

  it("preserves prior work.json content when merging", async () => {
    const original = {
      providers: { fireworks: { baseUrl: "https://api.fireworks.ai/v1", apiKey: "$FIREWORKS_API_KEY" } },
      models: { kimi: { provider: "fireworks", model: "kimi-k2" } },
      defaultModel: "kimi",
    };
    await writeFile(join(proj, CONFIG), JSON.stringify(original, null, 2) + "\n");
    await runCreateDatasource(["grafana"], proj);
    const cfg = await readCfg();
    // Prior blocks survive.
    assert.deepEqual(cfg.providers, original.providers);
    assert.deepEqual(cfg.models, original.models);
    assert.equal(cfg.defaultModel, "kimi");
    // Datasource added.
    assert.equal(cfg.datasources.grafana.tokenEnv, "GRAFANA_TOKEN");
    assert.doesNotThrow(() => parseConfig(cfg));
  });

  it("refuses a collision without --force, overwrites with --force", async () => {
    await runCreateDatasource(["grafana"], proj);
    await assert.rejects(() => runCreateDatasource(["grafana"], proj), (e) => e instanceof UserFacingError);
    // With --force and a --url override, the entry is replaced.
    const code = await runCreateDatasource(["grafana", "--force", "--url", "https://new.host/api"], proj);
    assert.equal(code, 0);
    assert.equal((await readCfg()).datasources.grafana.baseUrl, "https://new.host/api");
  });

  it("dry-run writes nothing", async () => {
    const code = await runCreateDatasource(["grafana", "--dry-run"], proj);
    assert.equal(code, 0);
    assert.equal(existsSync(join(proj, CONFIG)), false);
  });
});
