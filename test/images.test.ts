/**
 * Image registry resolution — pure filesystem lookup, no Gondolin build. A
 * `work:<variant>` resolves to a build-config, user images
 * (`.workflows/images/<variant>/`) overriding bundled built-ins; an unknown
 * variant errors with the available list.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImageConfig, listImages } from "../src/images/index.ts";
import { PI_PACKAGE } from "../src/agent/index.ts";

describe("images — registry resolution", () => {
  it("resolves the bundled work:base build-config", () => {
    assert.match(resolveImageConfig("base", undefined), /images\/image-builtin\/base\/build-config\.json$/);
  });

  it("resolves the bundled work:pi build-config (no workspace needed)", () => {
    assert.match(resolveImageConfig("pi", undefined), /images\/image-builtin\/pi\/build-config\.json$/);
  });

  // work:pi bakes Pi in; work:base's runner installs it on demand. If the baked spec
  // and the installed spec drift, the two images silently run different Pi versions —
  // so the bundled image must pin exactly what the runner does.
  it("bakes the same Pi version the runner installs (work:pi must not drift from work:base)", async () => {
    const cfg = JSON.parse(await readFile(resolveImageConfig("pi", undefined), "utf-8")) as {
      postBuild?: { commands?: string[] };
    };
    const piSpec = (s: string | undefined) => (s ? /@earendil-works\/pi-coding-agent@(\S+)/.exec(s)?.[1] : undefined);
    const baked = (cfg.postBuild?.commands ?? []).map(piSpec).find(Boolean);
    assert.ok(baked, "work:pi build-config should install @earendil-works/pi-coding-agent in postBuild");
    assert.equal(baked, piSpec(PI_PACKAGE), "work:pi must bake the same Pi spec the runner installs");
  });

  it("lets a user image override a bundled one", async () => {
    const ws = await mkdtemp(join(tmpdir(), "pi-wf-img-"));
    const userBase = join(ws, ".workflows", "images", "base");
    await mkdir(userBase, { recursive: true });
    await writeFile(join(userBase, "build-config.json"), "{}");
    try {
      assert.equal(resolveImageConfig("base", ws), join(userBase, "build-config.json"));
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("lists available images (bundled ∪ user)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "pi-wf-img-"));
    const custom = join(ws, ".workflows", "images", "custom");
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, "build-config.json"), "{}");
    try {
      const imgs = listImages(ws);
      assert.ok(imgs.includes("base"), "bundled base is listed");
      assert.ok(imgs.includes("custom"), "user image is listed");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("errors with the available list for an unknown image", () => {
    assert.throws(() => resolveImageConfig("nope", undefined), /unknown work image "work:nope"[\s\S]*work:base/);
  });
});
