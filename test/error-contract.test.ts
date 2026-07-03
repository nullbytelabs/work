/**
 * The clean-error contract: every workflow-authoring error is a `UserFacingError`,
 * so the CLI's `main()` prints it as a clean `work: <msg>` (never a stack trace)
 * even on a path that doesn't catch the concrete type — the behavior is structural,
 * not per-call-site. The concrete subtypes must STILL be distinguishable, because
 * `sendCompileError` (400 vs 500) and the runtime's condition handling branch on them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UserFacingError } from "../src/errors.ts";
import { WorkflowCompileError, ConditionError } from "../src/compiler/index.ts";
import { parseWorkflow, WorkflowParseError } from "../src/spec/index.ts";

describe("error contract — authoring errors are UserFacingError", () => {
  it("all three authoring-error classes extend UserFacingError", () => {
    assert.ok(new WorkflowParseError("x") instanceof UserFacingError);
    assert.ok(new WorkflowCompileError("x") instanceof UserFacingError);
    assert.ok(new ConditionError("x") instanceof UserFacingError);
  });

  it("preserves concrete identity + name (the catches that branch on subtype still work)", () => {
    const p = new WorkflowParseError("bad", "jobs.build");
    assert.ok(p instanceof WorkflowParseError);
    assert.equal(p.name, "WorkflowParseError");
    assert.equal(p.message, "jobs.build: bad"); // path prefix preserved
    assert.equal(p.path, "jobs.build");

    const c = new WorkflowCompileError("nope");
    assert.ok(c instanceof WorkflowCompileError);
    assert.equal(c.name, "WorkflowCompileError");

    const cond = new ConditionError("huh");
    assert.ok(cond instanceof ConditionError);
    assert.equal(cond.name, "ConditionError");
  });

  it("a real parse failure is a UserFacingError (so main() prints it clean)", () => {
    assert.throws(
      () => parseWorkflow("name: w\njobs: {}\n"),
      (e) => e instanceof UserFacingError && e instanceof WorkflowParseError,
    );
  });
});
