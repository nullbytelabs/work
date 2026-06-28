import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init/index.ts";
import { CONFIG_FILENAME } from "../src/scaffold/templates.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";

describe("runInit (integration, real temp dir)", () => {
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), "pi-wf-init-"));
  });
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  it("scaffolds the default project: hello-world workflow, and NO presumed config", async () => {
    const code = await runInit([], proj);
    assert.equal(code, 0);
    assert.ok(existsSync(join(proj, ".workflows", "hello-world.yaml")));
    // A plain shell workflow has no agent step, so init must not foist a
    // provider/model work.json onto it.
    assert.equal(existsSync(join(proj, CONFIG_FILENAME)), false);
    // The generated workflow compiles.
    const yaml = await readFile(join(proj, ".workflows", "hello-world.yaml"), "utf-8");
    assert.doesNotThrow(() => compile(parseWorkflow(yaml)));
  });

  it("agent-action init writes a work.json skeleton (the one template that needs a model)", async () => {
    const code = await runInit(["--from-template", "agent-action"], proj);
    assert.equal(code, 0);
    assert.ok(existsSync(join(proj, ".workflows", "agent-action.yaml")));
    const cfg = join(proj, CONFIG_FILENAME);
    assert.ok(existsSync(cfg));
    const text = await readFile(cfg, "utf-8");
    assert.match(text, /\/\//); // self-documenting: carries comments
    assert.match(text, /<provider>/); // placeholders, not a presumed vendor
    assert.doesNotMatch(text, /fireworks|kimi/); // no vendor opinion baked in
  });

  it("does NOT write the skill unless --include-skill is passed", async () => {
    await runInit([], proj);
    assert.equal(existsSync(join(proj, ".claude", "skills", "work-workflows", "SKILL.md")), false);
    assert.equal(existsSync(join(proj, ".agents", "skills", "work-workflows", "SKILL.md")), false);
  });

  it("writes the skill at both editor locations with --include-skill", async () => {
    await runInit(["--include-skill"], proj);
    const claude = join(proj, ".claude", "skills", "work-workflows", "SKILL.md");
    const amp = join(proj, ".agents", "skills", "work-workflows", "SKILL.md");
    assert.ok(existsSync(claude) && existsSync(amp));
    const body = await readFile(claude, "utf-8");
    assert.match(body, /^name: work-workflows$/m); // frontmatter present
    assert.match(body, /description:/);
  });

  it("is idempotent: a re-run changes nothing and still exits 0", async () => {
    await runInit([], proj);
    const before = await readFile(join(proj, ".workflows", "hello-world.yaml"), "utf-8");
    const code = await runInit([], proj);
    assert.equal(code, 0);
    const after = await readFile(join(proj, ".workflows", "hello-world.yaml"), "utf-8");
    assert.equal(after, before);
  });

  it("never overwrites an existing config, even with --force", async () => {
    const original = '{"providers":{},"models":{},"_mine":true}';
    await runInit(["--from-template", "agent-action"], proj); // creates config
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(proj, CONFIG_FILENAME), original);
    await runInit(["--from-template", "agent-action", "--force"], proj);
    assert.equal(await readFile(join(proj, CONFIG_FILENAME), "utf-8"), original);
  });

  it("--dry-run writes nothing", async () => {
    const code = await runInit(["--dry-run"], proj);
    assert.equal(code, 0);
    assert.equal(existsSync(join(proj, ".workflows", "hello-world.yaml")), false);
    assert.equal(existsSync(join(proj, CONFIG_FILENAME)), false);
  });

  it("--from-template agent-action scaffolds the composite action", async () => {
    await runInit(["--from-template", "agent-action"], proj);
    assert.ok(existsSync(join(proj, ".workflows", "agent-action.yaml")));
    assert.ok(existsSync(join(proj, ".workflows", "actions", "agent-action", "prompt.md")));
  });
});

describe("runInit --global (writes the XDG global config)", () => {
  let xdg: string;
  let prevXdg: string | undefined;
  beforeEach(async () => {
    xdg = await mkdtemp(join(tmpdir(), "pi-wf-xdg-"));
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = xdg;
  });
  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await rm(xdg, { recursive: true, force: true });
  });

  it("writes work.json under $XDG_CONFIG_HOME/work and does NOT touch the project", async () => {
    const proj = await mkdtemp(join(tmpdir(), "pi-wf-gproj-"));
    try {
      const code = await runInit(["--global"], proj);
      assert.equal(code, 0);
      assert.ok(existsSync(join(xdg, "work", "work.json")));
      assert.equal(existsSync(join(proj, ".workflows")), false);
      assert.equal(existsSync(join(proj, CONFIG_FILENAME)), false);
    } finally {
      await rm(proj, { recursive: true, force: true });
    }
  });

  it("is idempotent and never clobbers an existing global config", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(xdg, "work"), { recursive: true });
    const mine = '{"providers":{},"models":{},"_mine":true}';
    await writeFile(join(xdg, "work", "work.json"), mine);
    const code = await runInit(["--global"], "/tmp");
    assert.equal(code, 0);
    assert.equal(await (await import("node:fs/promises")).readFile(join(xdg, "work", "work.json"), "utf-8"), mine);
  });

  it("--dry-run writes nothing", async () => {
    await runInit(["--global", "--dry-run"], "/tmp");
    assert.equal(existsSync(join(xdg, "work", "work.json")), false);
  });
});
