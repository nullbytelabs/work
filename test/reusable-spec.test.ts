/**
 * Parse-layer tests for reusable workflows: the `steps`-xor-`uses` job rule, the
 * forbidden execution-shaped keys on a `uses:` job, and the `on: workflow_call`
 * trigger forms. Execution/inlining is covered in reusable.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow, WorkflowParseError } from "../src/spec/index.ts";

/** Parse and return the thrown WorkflowParseError (asserting one was thrown). */
function err(yaml: string): WorkflowParseError {
  try {
    parseWorkflow(yaml);
  } catch (e) {
    assert.ok(e instanceof WorkflowParseError, `expected WorkflowParseError, got ${e}`);
    return e;
  }
  throw new Error("expected parseWorkflow to throw");
}

describe("parse — uses: jobs (steps-xor-uses)", () => {
  it("accepts a job with uses + with", () => {
    const spec = parseWorkflow(`name: w\njobs:\n  build:\n    uses: workflow/build\n    with: { target: staging }`);
    const job = spec.jobs["build"]!;
    assert.equal(job.uses, "workflow/build");
    assert.deepEqual(job.with, { target: "staging" });
    assert.equal(job.steps, undefined);
  });

  it("accepts uses + needs + if + strategy", () => {
    const spec = parseWorkflow(
      `name: w\njobs:\n  a:\n    steps: [{ run: "true" }]\n  b:\n    needs: [a]\n    if: success()\n    uses: workflow/build`,
    );
    const b = spec.jobs["b"]!;
    assert.deepEqual(b.needs, ["a"]);
    assert.equal(b.if, "success()");
    assert.equal(b.uses, "workflow/build");
  });

  it("rejects a job that defines both steps and uses", () => {
    const e = err(`name: w\njobs:\n  a:\n    uses: workflow/x\n    steps: [{ run: "true" }]`);
    assert.match(e.message, /cannot define both/);
  });

  it("rejects a job that defines neither steps nor uses", () => {
    const e = err(`name: w\njobs:\n  a:\n    needs: []`);
    assert.match(e.message, /either "steps" or "uses"/);
  });

  it("rejects runs-on / machine / env / outputs on a uses job", () => {
    for (const bad of [
      "    runs-on: gondolin",
      "    machine: large",
      "    env: { X: y }",
      "    outputs: { v: x }",
    ]) {
      const e = err(`name: w\njobs:\n  a:\n    uses: workflow/x\n${bad}`);
      assert.match(e.message, /not allowed on a "uses" job/);
    }
  });

  it("rejects with on a steps job", () => {
    const e = err(`name: w\njobs:\n  a:\n    steps: [{ run: "true" }]\n    with: { x: 1 }`);
    assert.match(e.message, /only valid on a "uses" job/);
  });

  it("validates needs of a uses job against the job map", () => {
    const e = err(`name: w\njobs:\n  b:\n    needs: [ghost]\n    uses: workflow/x`);
    assert.match(e.message, /unknown job in needs/);
  });
});

describe("parse — on: workflow_call", () => {
  const wrap = (on: string) => `name: w\non:\n${on}\njobs:\n  a:\n    steps: [{ run: "true" }]`;

  it("accepts the string shorthand on: workflow_call", () => {
    const spec = parseWorkflow(`name: w\non: workflow_call\njobs:\n  a:\n    steps: [{ run: "true" }]`);
    assert.deepEqual(spec.on, { workflow_call: true });
  });

  it("accepts boolean true/false", () => {
    assert.deepEqual(parseWorkflow(wrap("  workflow_call: true")).on, { workflow_call: true });
    assert.deepEqual(parseWorkflow(wrap("  workflow_call: false")).on, { workflow_call: false });
  });

  it("accepts the mapping form with outputs", () => {
    const spec = parseWorkflow(wrap("  workflow_call:\n    outputs:\n      version: \"${{ jobs.compile.outputs.version }}\""));
    assert.deepEqual(spec.on, { workflow_call: { outputs: { version: "${{ jobs.compile.outputs.version }}" } } });
  });

  it("coexists with webhook under on:", () => {
    const spec = parseWorkflow(wrap("  webhook: true\n  workflow_call: true"));
    assert.deepEqual(spec.on, { webhook: true, workflow_call: true });
  });

  it("rejects a malformed workflow_call block", () => {
    assert.throws(() => parseWorkflow(wrap("  workflow_call: 42")), WorkflowParseError);
    assert.throws(() => parseWorkflow(wrap("  workflow_call:\n    outputs: 5")), WorkflowParseError);
    assert.throws(() => parseWorkflow(wrap("  workflow_call:\n    outputs:\n      v: \"\"")), WorkflowParseError);
  });
});
