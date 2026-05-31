import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkflowLayout, findWorkflowByName } from "../src/project.ts";
import { UserFacingError } from "../src/errors.ts";

describe("resolveWorkflowLayout", () => {
  it("treats a workflow in .workflows/ as living in a project: checkout = parent", () => {
    const l = resolveWorkflowLayout("/repo/.workflows/main.yaml");
    assert.equal(l.file, "/repo/.workflows/main.yaml");
    assert.equal(l.workflowDir, "/repo/.workflows"); // agents resolve here (.workflows/agents)
    assert.equal(l.workspaceSource, "/repo"); // the project root is the checkout
  });

  it("treats a standalone workflow file's own folder as both checkout and workflow dir", () => {
    const l = resolveWorkflowLayout("/repo/examples/hello/workflow.yaml");
    assert.equal(l.workflowDir, "/repo/examples/hello");
    assert.equal(l.workspaceSource, "/repo/examples/hello");
  });

  it("resolves relative paths to absolute", () => {
    const l = resolveWorkflowLayout("./a/b/workflow.yaml");
    assert.ok(l.file.startsWith("/"), "file should be absolute");
    assert.ok(l.workflowDir.startsWith("/"), "workflowDir should be absolute");
  });
});

describe("findWorkflowByName", () => {
  let project: string;
  before(async () => {
    project = await mkdtemp(join(tmpdir(), "pi-wf-byname-"));
    await mkdir(join(project, ".workflows", "agents", "x"), { recursive: true });
    await writeFile(join(project, ".workflows", "main.yaml"), "name: ci\njobs:\n  a: { steps: [{ run: 'true' }] }\n");
    await writeFile(join(project, ".workflows", "release.yml"), "name: release\njobs:\n  a: { steps: [{ run: 'true' }] }\n");
    // Decoy files that must NOT be treated as pipelines:
    await writeFile(join(project, ".workflows", "notes.txt"), "name: ci\n"); // not YAML
    await writeFile(join(project, ".workflows", "agents", "x", "agent.yaml"), "name: ci\n"); // in a subdir
  });
  after(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it("resolves a workflow by its name: field, with the project root as checkout", async () => {
    const l = await findWorkflowByName(project, "ci");
    assert.ok(l.file.endsWith("/.workflows/main.yaml"));
    assert.equal(l.workspaceSource, project); // checkout is the project root
    assert.equal(l.workflowDir, join(project, ".workflows"));
  });

  it("matches the declared name, not the filename (release.yml -> name: release)", async () => {
    const l = await findWorkflowByName(project, "release");
    assert.ok(l.file.endsWith("/.workflows/release.yml"));
  });

  it("errors with the available names when the name is unknown", async () => {
    await assert.rejects(() => findWorkflowByName(project, "nope"), (e: Error) => {
      assert.ok(e instanceof UserFacingError);
      assert.match(e.message, /no workflow named "nope"/);
      assert.match(e.message, /available: ci, release/); // ignores notes.txt and the agents/ subdir
      return true;
    });
  });

  it("errors when there is no .workflows directory", async () => {
    const empty = await mkdtemp(join(tmpdir(), "pi-wf-empty-"));
    try {
      await assert.rejects(() => findWorkflowByName(empty, "ci"), /no \.workflows\/ directory/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("reports ambiguity when two files declare the same name", async () => {
    const dup = await mkdtemp(join(tmpdir(), "pi-wf-dup-"));
    try {
      await mkdir(join(dup, ".workflows"), { recursive: true });
      await writeFile(join(dup, ".workflows", "a.yaml"), "name: ci\njobs:\n  a: { steps: [{ run: 'true' }] }\n");
      await writeFile(join(dup, ".workflows", "b.yaml"), "name: ci\njobs:\n  a: { steps: [{ run: 'true' }] }\n");
      await assert.rejects(() => findWorkflowByName(dup, "ci"), /ambiguous/);
    } finally {
      await rm(dup, { recursive: true, force: true });
    }
  });
});
