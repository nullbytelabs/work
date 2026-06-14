import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slug } from "../src/scaffold/slug.ts";
import { scaffoldFiles, workflowPath, CONFIG_FILENAME, TEMPLATES } from "../src/scaffold/templates.ts";
import { runCreate } from "../src/scaffold/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { UserFacingError } from "../src/errors.ts";

describe("slug", () => {
  it("passes through a valid slug", () => {
    assert.equal(slug("deploy"), "deploy");
    assert.equal(slug("build-and-test"), "build-and-test");
  });
  it("lowercases and collapses non-alphanumerics to single hyphens", () => {
    assert.equal(slug("My Deploy!!"), "my-deploy");
    assert.equal(slug("  Foo   Bar  "), "foo-bar");
    assert.equal(slug("a__b--c"), "a-b-c");
  });
  it("trims leading/trailing separators", () => {
    assert.equal(slug("-_release_-"), "release");
  });
  it("throws when nothing valid remains", () => {
    assert.throws(() => slug("!!!"), UserFacingError);
    assert.throws(() => slug(""), UserFacingError);
  });
});

describe("scaffoldFiles — hello-world", () => {
  it("emits exactly one workflow file with the slug baked in", () => {
    const files = scaffoldFiles({ name: "deploy", template: "hello-world" });
    assert.deepEqual([...files.keys()], [".workflows/deploy.yaml"]);
    const yaml = files.get(".workflows/deploy.yaml")!;
    assert.match(yaml, /^name: deploy$/m);
    assert.match(yaml, /^ {2}deploy:$/m); // job id is the slug
    assert.match(yaml, /runs-on: gondolin/);
    assert.doesNotMatch(yaml, /\{\{name\}\}/); // no unrendered placeholders
  });
});

describe("scaffoldFiles — agent-action", () => {
  it("emits the workflow, composite action (wrapping work/agent), and a starter config", () => {
    const files = scaffoldFiles({ name: "review", template: "agent-action" });
    assert.deepEqual(
      [...files.keys()].sort(),
      [
        ".workflows/actions/review/action.yaml",
        ".workflows/actions/review/prompt.md",
        ".workflows/review.yaml",
        CONFIG_FILENAME,
      ].sort(),
    );
    assert.match(files.get(".workflows/review.yaml")!, /uses: action\/review/);
    // The action is a composite that wraps the work/agent primitive with a prompt.
    const action = files.get(".workflows/actions/review/action.yaml")!;
    assert.match(action, /using: composite/);
    assert.match(action, /uses: work\/agent/);
    assert.match(action, /promptFile:/);
    assert.doesNotMatch(action, /instructions/);
    assert.ok(files.get(".workflows/actions/review/prompt.md")!.trim().length > 0);
    // work.json is valid JSON and parses as a config object.
    const cfg = JSON.parse(files.get(CONFIG_FILENAME)!);
    assert.equal(cfg.defaultModel, "kimi");
    assert.equal(cfg.providers.fireworks.apiKey, "$FIREWORKS_API_KEY"); // $ENV ref, never a literal secret
  });
});

describe("generated workflows compile through the real pipeline", () => {
  for (const template of TEMPLATES) {
    it(`${template} parses, compiles, and emits no warnings`, () => {
      const files = scaffoldFiles({ name: "sample", template });
      const yaml = files.get(workflowPath("sample"))!;
      const plan = compile(parseWorkflow(yaml));
      assert.equal(plan.warnings, undefined); // runs-on is explicit, so no nudges
    });
  }
});

describe("runCreate (integration, real temp dir)", () => {
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), "pi-wf-create-"));
  });
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  it("writes the hello-world scaffold and is idempotent on re-run with --force", async () => {
    const code = await runCreate(["workflow", "deploy"], proj);
    assert.equal(code, 0);
    assert.ok(existsSync(join(proj, ".workflows", "deploy.yaml")));
    // The written file is itself valid.
    const yaml = await readFile(join(proj, ".workflows", "deploy.yaml"), "utf-8");
    assert.doesNotThrow(() => compile(parseWorkflow(yaml)));

    // --force re-run overwrites cleanly (exit 0).
    assert.equal(await runCreate(["workflow", "deploy", "--force"], proj), 0);
  });

  it("refuses a filename collision without --force", async () => {
    await runCreate(["workflow", "deploy"], proj);
    await assert.rejects(() => runCreate(["workflow", "deploy"], proj), (e) => e instanceof UserFacingError);
  });

  it("refuses a duplicate name: declared in another file", async () => {
    await mkdir(join(proj, ".workflows"), { recursive: true });
    await writeFile(join(proj, ".workflows", "other.yaml"), "name: deploy\njobs:\n  a: { steps: [{ run: 'true' }] }\n");
    await assert.rejects(() => runCreate(["workflow", "deploy"], proj), (e) => e instanceof UserFacingError);
  });

  it("dry-run writes nothing", async () => {
    const code = await runCreate(["workflow", "deploy", "--dry-run"], proj);
    assert.equal(code, 0);
    assert.equal(existsSync(join(proj, ".workflows", "deploy.yaml")), false);
  });

  it("never overwrites an existing work.json, even with --force", async () => {
    const cfgPath = join(proj, CONFIG_FILENAME);
    const original = '{"providers":{},"models":{},"defaultModel":null,"_mine":true}';
    await writeFile(cfgPath, original);
    await runCreate(["workflow", "review", "--template", "agent-action", "--force"], proj);
    assert.equal(await readFile(cfgPath, "utf-8"), original); // preserved
  });

  it("rejects the bare form (clean break): create <name> needs the workflow noun", async () => {
    // `create deploy` is no longer a workflow shorthand — it's an unknown resource.
    await assert.rejects(() => runCreate(["deploy"], proj), (e) => e instanceof UserFacingError);
    // And the file is never written as a side effect.
    assert.equal(existsSync(join(proj, ".workflows", "deploy.yaml")), false);
  });

  it("lets a workflow be named after a resource noun now that the grammar is explicit", async () => {
    assert.equal(await runCreate(["workflow", "image"], proj), 0);
    assert.ok(existsSync(join(proj, ".workflows", "image.yaml")));
  });
});
