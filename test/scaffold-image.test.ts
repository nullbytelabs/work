/**
 * `work create image <name>` — generates an arch-agnostic Gondolin build-config
 * under `.workflows/images/<name>/` that is immediately selectable as
 * `runs-on: work:<name>`. The arch-agnostic property is load-bearing (the engine
 * injects the host arch at build time), so it's asserted explicitly.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCreateImage, IMAGE_SKELETON, imageConfigText } from "../src/scaffold/image.ts";
import { resolveImageConfig } from "../src/images/index.ts";
import { UserFacingError } from "../src/errors.ts";

const cfgPath = (ws: string, name: string) =>
  join(ws, ".workflows", "images", name, "build-config.json");

describe("create image — embedded skeleton (pure)", () => {
  it("renders valid JSON that round-trips", () => {
    const parsed = JSON.parse(imageConfigText());
    assert.deepEqual(parsed, IMAGE_SKELETON);
  });

  it("is arch-agnostic — NO arch field", () => {
    assert.ok(!("arch" in IMAGE_SKELETON), "skeleton must not pin arch");
    assert.doesNotMatch(imageConfigText(), /"arch"/);
  });

  it("is a bootable Alpine config with a non-empty rootfsPackages floor", () => {
    assert.equal(IMAGE_SKELETON.distro, "alpine");
    assert.ok(Array.isArray(IMAGE_SKELETON.alpine.rootfsPackages));
    assert.ok(IMAGE_SKELETON.alpine.rootfsPackages.length > 0);
    // The boot/work essentials must be present.
    for (const pkg of ["linux-virt", "rng-tools", "ca-certificates"]) {
      assert.ok(IMAGE_SKELETON.alpine.rootfsPackages.includes(pkg), `expected ${pkg}`);
    }
  });
});

describe("runCreateImage (integration, real temp dir)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "pi-wf-create-image-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("writes the build-config and it is valid, arch-agnostic JSON", async () => {
    const code = await runCreateImage(["godot"], ws);
    assert.equal(code, 0);
    const p = cfgPath(ws, "godot");
    assert.ok(existsSync(p), "build-config written");

    const parsed = JSON.parse(await readFile(p, "utf-8"));
    assert.ok(!("arch" in parsed), "no arch field");
    assert.equal(parsed.distro, "alpine");
    assert.ok(Array.isArray(parsed.alpine.rootfsPackages) && parsed.alpine.rootfsPackages.length > 0);
  });

  it("applies the slug to the directory name", async () => {
    await runCreateImage(["My Image"], ws);
    assert.ok(existsSync(cfgPath(ws, "my-image")), "slugged path used");
  });

  it("the generated image is selectable via resolveImageConfig", async () => {
    await runCreateImage(["godot"], ws);
    assert.equal(resolveImageConfig("godot", ws), cfgPath(ws, "godot"));
  });

  it("does not clobber an existing build-config without --force", async () => {
    await mkdir(join(ws, ".workflows", "images", "godot"), { recursive: true });
    const original = '{"_mine":true}';
    await writeFile(cfgPath(ws, "godot"), original);
    await assert.rejects(() => runCreateImage(["godot"], ws), (e) => e instanceof UserFacingError);
    assert.equal(await readFile(cfgPath(ws, "godot"), "utf-8"), original, "preserved");
  });

  it("overwrites with --force", async () => {
    await mkdir(join(ws, ".workflows", "images", "godot"), { recursive: true });
    await writeFile(cfgPath(ws, "godot"), '{"_mine":true}');
    const code = await runCreateImage(["godot", "--force"], ws);
    assert.equal(code, 0);
    const parsed = JSON.parse(await readFile(cfgPath(ws, "godot"), "utf-8"));
    assert.equal(parsed.distro, "alpine"); // skeleton, not the old file
  });

  it("dry-run writes nothing", async () => {
    const code = await runCreateImage(["godot", "--dry-run"], ws);
    assert.equal(code, 0);
    assert.equal(existsSync(cfgPath(ws, "godot")), false);
  });
});
