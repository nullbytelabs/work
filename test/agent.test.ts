import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadAgent, buildAgentPrompt, agentOutputs, parseAgentUses } from "../src/agent/index.ts";
import { UserFacingError } from "../src/errors.ts";

describe("agent packages", () => {
  it("parses uses: agent/<name>[@ref]", () => {
    assert.deepEqual(parseAgentUses("agent/summarize"), { name: "summarize" });
    assert.deepEqual(parseAgentUses("agent/summarize@v2"), { name: "summarize", ref: "v2" });
    assert.throws(() => parseAgentUses("docker/foo"), UserFacingError);
  });

  it("loads the built-in summarize package from src/agents/", async () => {
    const a = await loadAgent("summarize");
    assert.equal(a.name, "summarize");
    assert.match(a.instructions, /summar/i);
    assert.match(a.task, /\{\{\s*input\s*\}\}/);
    assert.equal(a.inputs["input"]!.required, true);
    assert.deepEqual(a.outputs, ["summary"]);
  });

  it("errors on an unknown agent package", async () => {
    await assert.rejects(() => loadAgent("does-not-exist"), UserFacingError);
  });

  it("binds inputs into the task template and maps the first output", async () => {
    const a = await loadAgent("summarize");
    assert.equal(buildAgentPrompt(a, { input: "hello world" }), "Summarize the following:\n\nhello world");
    assert.deepEqual(agentOutputs(a, "  a summary  "), { summary: "a summary" });
  });
});
