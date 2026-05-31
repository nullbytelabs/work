import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkflowLayout } from "../src/project.ts";

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
