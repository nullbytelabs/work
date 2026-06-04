import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentOutputs, type LoadedAgent } from "../src/agent/index.ts";

// Build a minimal LoadedAgent with just the output names we want to test; the
// other fields don't affect `agentOutputs`.
function agentWith(outputs: string[]): LoadedAgent {
  return { name: "t", instructions: "x", task: "", inputs: {}, outputs };
}

describe("agentOutputs", () => {
  // (a) Single-output prose → first output gets the whole text (unchanged
  // back-compat: this is the original behavior for every existing agent).
  it("single output: whole trimmed text becomes the first output", () => {
    const a = agentWith(["summary"]);
    assert.deepEqual(agentOutputs(a, "  a one-sentence summary  "), { summary: "a one-sentence summary" });
  });

  it("single output: JSON-looking text is kept verbatim (no splitting with <2 outputs)", () => {
    const a = agentWith(["summary"]);
    assert.deepEqual(agentOutputs(a, '{"summary":"x"}'), { summary: '{"summary":"x"}' });
  });

  it("zero declared outputs: falls back to the synthetic 'output' key", () => {
    const a = agentWith([]);
    assert.deepEqual(agentOutputs(a, "hello"), { output: "hello" });
  });

  // (b) 2+ outputs + JSON object → each declared output mapped.
  it("multi-output: maps each declared key from a JSON object", () => {
    const a = agentWith(["severity", "root_cause", "confidence"]);
    const text = JSON.stringify({ severity: "high", root_cause: "null deref", confidence: 0.9 });
    assert.deepEqual(agentOutputs(a, text), {
      severity: "high",
      root_cause: "null deref",
      confidence: "0.9", // scalar coerced via String
    });
  });

  it("multi-output: ignores undeclared JSON keys", () => {
    const a = agentWith(["severity"]);
    // Two declared so we're on the multi-output path; only `severity` is read.
    a.outputs.push("confidence");
    const text = JSON.stringify({ severity: "low", confidence: 0.1, extra: "ignored", note: 123 });
    assert.deepEqual(agentOutputs(a, text), { severity: "low", confidence: "0.1" });
  });

  it("multi-output: declared-but-missing key becomes \"\"", () => {
    const a = agentWith(["severity", "root_cause", "confidence"]);
    const text = JSON.stringify({ severity: "high" });
    assert.deepEqual(agentOutputs(a, text), { severity: "high", root_cause: "", confidence: "" });
  });

  it("multi-output: non-scalar values are JSON-stringified", () => {
    const a = agentWith(["files", "meta"]);
    const text = JSON.stringify({ files: ["a.ts", "b.ts"], meta: { lines: 10 } });
    assert.deepEqual(agentOutputs(a, text), {
      files: '["a.ts","b.ts"]',
      meta: '{"lines":10}',
    });
  });

  it("multi-output: null and boolean scalars coerce via String", () => {
    const a = agentWith(["a", "b"]);
    const text = JSON.stringify({ a: null, b: true });
    assert.deepEqual(agentOutputs(a, text), { a: "null", b: "true" });
  });

  // (c) 2+ outputs but non-JSON text → fallback to first-output-gets-all.
  it("multi-output fallback: non-JSON text → whole text on the first output", () => {
    const a = agentWith(["severity", "root_cause"]);
    assert.deepEqual(agentOutputs(a, "  not json at all  "), { severity: "not json at all" });
  });

  it("multi-output fallback: malformed JSON → whole text on the first output", () => {
    const a = agentWith(["severity", "root_cause"]);
    assert.deepEqual(agentOutputs(a, '{"severity": '), { severity: '{"severity":' });
  });

  // (d) 2+ outputs + JSON array/number/string/null → fallback (not an object).
  it("multi-output fallback: JSON array → whole text on the first output", () => {
    const a = agentWith(["severity", "root_cause"]);
    assert.deepEqual(agentOutputs(a, "[1, 2, 3]"), { severity: "[1, 2, 3]" });
  });

  it("multi-output fallback: JSON number → whole text on the first output", () => {
    const a = agentWith(["severity", "root_cause"]);
    assert.deepEqual(agentOutputs(a, "42"), { severity: "42" });
  });

  it("multi-output fallback: JSON null → whole text on the first output", () => {
    const a = agentWith(["severity", "root_cause"]);
    assert.deepEqual(agentOutputs(a, "null"), { severity: "null" });
  });

  it("multi-output fallback: JSON string literal → whole text on the first output", () => {
    const a = agentWith(["severity", "root_cause"]);
    assert.deepEqual(agentOutputs(a, '"just a string"'), { severity: '"just a string"' });
  });
});
