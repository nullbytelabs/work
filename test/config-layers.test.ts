import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePartialConfig,
  mergeConfig,
  validateConfig,
  loadMergedConfig,
  globalConfigCandidates,
  resolveGlobalConfigPath,
  globalConfigWritePath,
  type PiWorkflowsConfig,
} from "../src/config/index.ts";
import { UserFacingError } from "../src/errors.ts";

describe("parsePartialConfig (shape only, no cross-refs)", () => {
  it("accepts a model whose provider is absent from this layer", () => {
    // The trap: a project layer's provider may live in the global layer.
    const c = parsePartialConfig({ models: { m: { provider: "from-global", model: "x" } } });
    assert.equal(c.models["m"]!.provider, "from-global");
    assert.deepEqual(c.providers, {});
  });
  it("shrinks to just a defaultModel", () => {
    const c = parsePartialConfig({ defaultModel: "kimi" });
    assert.equal(c.defaultModel, "kimi");
  });
  it("still rejects wrong field types", () => {
    assert.throws(() => parsePartialConfig({ providers: { p: { baseUrl: 1, apiKey: "k" } } }), UserFacingError);
    assert.throws(() => parsePartialConfig("nope"), UserFacingError);
  });
});

describe("mergeConfig", () => {
  const base: PiWorkflowsConfig = {
    providers: { fw: { baseUrl: "b", apiKey: "$K" } },
    models: { kimi: { provider: "fw", model: "m1" }, shared: { provider: "fw", model: "old" } },
    defaultModel: "kimi",
  };
  it("unions providers/models and lets the higher layer replace a colliding entry wholesale", () => {
    const over: PiWorkflowsConfig = { providers: {}, models: { shared: { provider: "fw", model: "new" } } };
    const m = mergeConfig(base, over);
    assert.equal(m.models["shared"]!.model, "new"); // replaced
    assert.equal(m.models["kimi"]!.model, "m1"); // inherited
    assert.ok(m.providers["fw"]); // inherited
  });
  it("defaultModel is last-writer-wins; an empty over inherits base", () => {
    assert.equal(mergeConfig(base, { providers: {}, models: {} }).defaultModel, "kimi");
    assert.equal(mergeConfig(base, { providers: {}, models: {}, defaultModel: "shared" }).defaultModel, "shared");
  });
});

describe("validateConfig (cross-refs, post-merge)", () => {
  it("rejects a lone project layer but accepts it once merged under global", () => {
    const global = parsePartialConfig({ providers: { fw: { baseUrl: "b", apiKey: "$K" } } });
    const project = parsePartialConfig({ models: { kimi: { provider: "fw", model: "m" } }, defaultModel: "kimi" });

    // Project alone fails (provider "fw" lives in global).
    assert.throws(() => validateConfig(project), (e) => e instanceof UserFacingError && /unknown provider "fw"/.test(e.message));
    // Merged, it validates.
    assert.doesNotThrow(() => validateConfig(mergeConfig(global, project)));
  });
  it("rejects a defaultModel missing from the merged models", () => {
    const c = parsePartialConfig({ providers: {}, models: {}, defaultModel: "ghost" });
    assert.throws(() => validateConfig(c), (e) => e instanceof UserFacingError && /defaultModel/.test(e.message));
  });
});

describe("loadMergedConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-wf-cfg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("merges a global catalog with a project layer that only picks a model", async () => {
    const g = join(dir, "global.json");
    const p = join(dir, "project.json");
    await writeFile(g, JSON.stringify({ providers: { fw: { baseUrl: "b", apiKey: "$K" } }, models: { kimi: { provider: "fw", model: "m" } } }));
    await writeFile(p, JSON.stringify({ defaultModel: "kimi" }));
    const cfg = await loadMergedConfig([{ path: g, required: false }, { path: p, required: true }]);
    assert.equal(cfg?.defaultModel, "kimi");
    assert.ok(cfg?.providers["fw"]);
  });

  it("returns undefined when no layer exists", async () => {
    const cfg = await loadMergedConfig([{ path: join(dir, "nope.json"), required: false }]);
    assert.equal(cfg, undefined);
  });

  it("throws when a required layer is missing", async () => {
    await assert.rejects(
      () => loadMergedConfig([{ path: join(dir, "missing.json"), required: true }]),
      (e) => e instanceof UserFacingError && /cannot read config file/.test(e.message),
    );
  });

  it("throws on invalid JSON", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json");
    await assert.rejects(
      () => loadMergedConfig([{ path: bad, required: true }]),
      (e) => e instanceof UserFacingError && /not valid JSON/.test(e.message),
    );
  });

  it("validates cross-refs only after merging (project provider from global)", async () => {
    const g = join(dir, "g.json");
    const p = join(dir, "p.json");
    await writeFile(g, JSON.stringify({ providers: { fw: { baseUrl: "b", apiKey: "$K" } } }));
    await writeFile(p, JSON.stringify({ models: { kimi: { provider: "fw", model: "m" } }, defaultModel: "kimi" }));
    // Project file in isolation would fail validate; merged it must succeed.
    await assert.doesNotReject(() => loadMergedConfig([{ path: g, required: false }, { path: p, required: true }]));
  });
});

describe("global config path resolution", () => {
  it("prefers XDG, then ~/.config/work, then the ~/.work fallback", () => {
    const cands = globalConfigCandidates({ XDG_CONFIG_HOME: "/xdg" }, "/home/u");
    assert.deepEqual(cands, ["/xdg/work/work.json", "/home/u/.config/work/work.json", "/home/u/.work/work.json"]);
  });
  it("omits the XDG candidate when XDG_CONFIG_HOME is unset", () => {
    const cands = globalConfigCandidates({}, "/home/u");
    assert.deepEqual(cands, ["/home/u/.config/work/work.json", "/home/u/.work/work.json"]);
  });
  it("write path is XDG-first and never the ~/.work fallback", () => {
    assert.equal(globalConfigWritePath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"), "/xdg/work/work.json");
    assert.equal(globalConfigWritePath({}, "/home/u"), "/home/u/.config/work/work.json");
  });
  it("resolveGlobalConfigPath returns the first existing candidate", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-wf-home-"));
    try {
      assert.equal(resolveGlobalConfigPath({}, home), undefined); // none yet
      await mkdir(join(home, ".config", "work"), { recursive: true });
      await writeFile(join(home, ".config", "work", "work.json"), "{}");
      assert.equal(resolveGlobalConfigPath({}, home), join(home, ".config", "work", "work.json"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
