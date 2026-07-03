/**
 * The clean-error contract: every workflow-authoring error is a `UserFacingError`,
 * so the CLI's `main()` prints it as a clean `work: <msg>` (never a stack trace)
 * even on a path that doesn't catch the concrete type — the behavior is structural,
 * not per-call-site. The concrete subtypes must STILL be distinguishable, because
 * `sendCompileError` (400 vs 500) and the runtime's condition handling branch on them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UserFacingError, formatUserFacing } from "../src/errors.ts";
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

describe("error contract — structured path / hint / docs", () => {
  it("path is prefixed onto the message AND exposed as a field", () => {
    const e = new WorkflowCompileError("references needs.build.*", { path: "jobs.deploy" });
    assert.equal(e.path, "jobs.deploy");
    assert.equal(e.message, "jobs.deploy: references needs.build.*");
  });

  it("carries hint + docs as fields (for the web JSON + agent consumers)", () => {
    const e = new WorkflowCompileError("unknown input \"x\"", {
      path: "inputs",
      hint: "declared inputs: foo",
      docs: "https://example/docs",
    });
    assert.equal(e.hint, "declared inputs: foo");
    assert.equal(e.docs, "https://example/docs");
  });

  it("formatUserFacing renders message, then hint: and see: lines only when present", () => {
    const bare = new UserFacingError("boom");
    assert.equal(formatUserFacing(bare), "boom");

    const full = new WorkflowCompileError("references needs.build.*", {
      path: "jobs.deploy",
      hint: "reference a specific leg",
      docs: "https://example/docs",
    });
    assert.equal(
      formatUserFacing(full),
      "jobs.deploy: references needs.build.*\n  hint: reference a specific leg\n  see:  https://example/docs",
    );

    // hint without docs → no `see:` line.
    const hintOnly = new ConditionError("bad", { hint: "did you mean &&?" });
    assert.equal(formatUserFacing(hintOnly), "bad\n  hint: did you mean &&?");
  });

  it("existing single-arg construction still works (backward compatible)", () => {
    const e = new WorkflowCompileError("just a message");
    assert.equal(e.message, "just a message");
    assert.equal(e.path, undefined);
    assert.equal(formatUserFacing(e), "just a message");
  });
});
