/**
 * Image registry resolution — pure filesystem lookup, no Gondolin build. A
 * `work:<variant>` resolves to a build-config, user images
 * (`.workflows/images/<variant>/`) overriding bundled built-ins; an unknown
 * variant errors with the available list.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImageConfig, listImages } from "../src/images/index.ts";

describe("images — registry resolution", () => {
  it("resolves the bundled work:base build-config", () => {
    assert.match(resolveImageConfig("base", undefined), /images\/image-builtin\/base\/build-config\.json$/);
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
