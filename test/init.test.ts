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

  it("scaffolds the default project: hello-world workflow + config", async () => {
    const code = await runInit([], proj);
    assert.equal(code, 0);
    assert.ok(existsSync(join(proj, ".workflows", "hello-world.yaml")));
    assert.ok(existsSync(join(proj, CONFIG_FILENAME)));
    // The generated workflow compiles.
    const yaml = await readFile(join(proj, ".workflows", "hello-world.yaml"), "utf-8");
    assert.doesNotThrow(() => compile(parseWorkflow(yaml)));
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
    await runInit([], proj); // creates config
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(proj, CONFIG_FILENAME), original);
    await runInit(["--force"], proj);
    assert.equal(await readFile(join(proj, CONFIG_FILENAME), "utf-8"), original);
  });

  it("--dry-run writes nothing", async () => {
    const code = await runInit(["--dry-run"], proj);
    assert.equal(code, 0);
    assert.equal(existsSync(join(proj, ".workflows", "hello-world.yaml")), false);
    assert.equal(existsSync(join(proj, CONFIG_FILENAME)), false);
  });

  it("--from-template agent-action scaffolds the agent package", async () => {
    await runInit(["--from-template", "agent-action"], proj);
    assert.ok(existsSync(join(proj, ".workflows", "agent-action.yaml")));
    assert.ok(existsSync(join(proj, ".workflows", "agents", "agent-action", "instructions.md")));
  });
});
