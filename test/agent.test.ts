import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent, buildAgentPrompt, agentOutputs, parseAgentUses } from "../src/agent/index.ts";
import { UserFacingError } from "../src/errors.ts";

// Agent packages are workflow-local; the agent-project example ships one in
// its `.workflows/agents/` (like a GitHub Actions local action).
const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(HERE, "e2e", "agent-project", ".workflows", "agents");

describe("agent packages", () => {
  it("parses uses: agent/<name>[@ref]", () => {
    assert.deepEqual(parseAgentUses("agent/summarize"), { name: "summarize" });
    assert.deepEqual(parseAgentUses("agent/summarize@v2"), { name: "summarize", ref: "v2" });
    assert.throws(() => parseAgentUses("docker/foo"), UserFacingError);
  });

  it("loads a project-local summarize package from <project>/agents/", async () => {
    const a = await loadAgent("summarize", AGENTS_DIR);
    assert.equal(a.name, "summarize");
    assert.match(a.instructions, /summar/i);
    // Workspace-aware: the agent reads the checkout itself, so it declares no
    // inputs and its task carries no `{{ … }}` placeholders.
    assert.deepEqual(a.inputs, {});
    assert.doesNotMatch(a.task, /\{\{/);
    assert.deepEqual(a.outputs, ["summary"]);
  });

  it("errors on an unknown agent package", async () => {
    await assert.rejects(() => loadAgent("does-not-exist", AGENTS_DIR), UserFacingError);
  });

  it("uses a placeholderless task verbatim and maps the first output", async () => {
    const a = await loadAgent("summarize", AGENTS_DIR);
    // No placeholders → the task prompt is the task.md text as-authored.
    assert.equal(buildAgentPrompt(a, {}), a.task);
    assert.deepEqual(agentOutputs(a, "  a summary  "), { summary: "a summary" });
  });
});
