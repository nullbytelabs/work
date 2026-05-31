import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile, WorkflowCompileError, resolveInputs, interpolate } from "../src/compiler/index.ts";

/** Compile a workflow with provided inputs and return the first step of a job. */
function step0(yaml: string, inputs?: Record<string, unknown>) {
  const plan = compile(parseWorkflow(yaml), inputs ? { inputs } : {});
  const firstJob = plan.jobs[plan.jobOrder[0]!]!;
  return firstJob.steps[0]!;
}

describe("inputs — resolveInputs", () => {
  it("applies defaults and lets provided values override", () => {
    const decl = { name: { default: "world" } };
    assert.deepEqual(resolveInputs(decl, {}), { name: "world" });
    assert.deepEqual(resolveInputs(decl, { name: "josh" }), { name: "josh" });
  });

  it("errors on a missing required input", () => {
    assert.throws(
      () => resolveInputs({ token: { required: true } }, {}),
      (e) => e instanceof WorkflowCompileError && /required input "token"/.test(e.message),
    );
  });

  it("errors on an unknown provided input", () => {
    assert.throws(
      () => resolveInputs({ name: {} }, { nope: 1 }),
      (e) => e instanceof WorkflowCompileError && /unknown input "nope"/.test(e.message),
    );
  });

  it("accepts values whose JSON type matches the declaration", () => {
    assert.deepEqual(resolveInputs({ n: { type: "number" } }, { n: 42 }), { n: 42 });
    assert.deepEqual(resolveInputs({ b: { type: "boolean" } }, { b: true }), { b: true });
    assert.deepEqual(resolveInputs({ s: { type: "string" } }, { s: "x" }), { s: "x" });
  });

  it("strictly rejects mismatched JSON types (no coercion)", () => {
    const bad: [Record<string, { type: "string" | "number" | "boolean" }>, Record<string, unknown>, RegExp][] = [
      [{ n: { type: "number" } }, { n: "42" }, /must be a number \(got string\)/], // numeric string NOT accepted
      [{ n: { type: "number" } }, { n: "abc" }, /must be a number/],
      [{ b: { type: "boolean" } }, { b: "true" }, /must be a boolean \(got string\)/],
      [{ s: { type: "string" } }, { s: 5 }, /must be a string \(got number\)/],
    ];
    for (const [decl, provided, re] of bad) {
      assert.throws(
        () => resolveInputs(decl, provided),
        (e) => e instanceof WorkflowCompileError && re.test(e.message),
        `${JSON.stringify(provided)} should be rejected`,
      );
    }
  });

  it("defaults an optional, unprovided input by type", () => {
    assert.deepEqual(resolveInputs({ a: {}, b: { type: "number" }, c: { type: "boolean" } }, {}), {
      a: "",
      b: 0,
      c: false,
    });
  });
});

describe("inputs — required / options / pattern / format", () => {
  it("requires a value when required and unprovided", () => {
    assert.throws(
      () => resolveInputs({ r: { required: true } }, {}),
      (e) => e instanceof WorkflowCompileError && /required input "r"/.test(e.message),
    );
    assert.deepEqual(resolveInputs({ r: { required: true } }, { r: "x" }), { r: "x" });
  });

  it("accepts a value in options and rejects one that isn't", () => {
    const decl = { env: { options: ["dev", "staging", "prod"] } };
    assert.deepEqual(resolveInputs(decl, { env: "staging" }), { env: "staging" });
    assert.throws(
      () => resolveInputs(decl, { env: "qa" }),
      (e) => e instanceof WorkflowCompileError && /must be one of: dev, staging, prod/.test(e.message),
    );
  });

  it("enforces a regex pattern (e.g. a UUID — no built-in format needed)", () => {
    const uuid = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
    const decl = { id: { pattern: uuid } };
    assert.deepEqual(resolveInputs(decl, { id: "3cd7a864-f023-5a35-9db1-39a1be5bdcca" }), {
      id: "3cd7a864-f023-5a35-9db1-39a1be5bdcca",
    });
    assert.throws(
      () => resolveInputs(decl, { id: "not-a-uuid" }),
      (e) => e instanceof WorkflowCompileError && /does not match required pattern/.test(e.message),
    );
  });

  it("does NOT validate an absent optional input (pattern/options skipped)", () => {
    // id is optional, unprovided, no default → resolves to "" without a pattern error.
    assert.deepEqual(resolveInputs({ id: { pattern: "^x$" } }, {}), { id: "" });
    assert.deepEqual(resolveInputs({ env: { options: ["a", "b"] } }, {}), { env: "" });
  });
});

describe("inputs — interpolate", () => {
  it("substitutes ${{ inputs.x }} (dot and bracket forms)", () => {
    const inputs = { name: "josh" };
    assert.equal(interpolate("hi ${{ inputs.name }}", { inputs }), "hi josh");
    assert.equal(interpolate("hi ${{ inputs['name'] }}", { inputs }), "hi josh");
  });

  it("throws on an undeclared input reference", () => {
    assert.throws(
      () => interpolate("${{ inputs.ghost }}", { inputs: { name: "x" } }),
      (e) => e instanceof WorkflowCompileError && /undeclared input "ghost"/.test(e.message),
    );
  });

  it("throws on an unsupported expression", () => {
    assert.throws(
      () => interpolate("${{ matrix.node }}", { inputs: {} }),
      (e) => e instanceof WorkflowCompileError && /unsupported expression/.test(e.message),
    );
  });

  it("leaves needs/steps expressions intact when that context is absent (deferred)", () => {
    assert.equal(interpolate("${{ needs.a.outputs.x }}", { inputs: {} }), "${{ needs.a.outputs.x }}");
    assert.equal(interpolate("${{ steps.s.outputs.y }}", { inputs: {} }), "${{ steps.s.outputs.y }}");
  });

  it("resolves needs/steps when that context is provided", () => {
    assert.equal(interpolate("${{ needs.a.outputs.x }}", { needs: { a: { outputs: { x: "X" } } } }), "X");
    assert.equal(interpolate("${{ steps.s.outputs.y }}", { steps: { s: { outputs: { y: "Y" } } } }), "Y");
  });

  it("leaves shell ${VAR} and $(...) untouched", () => {
    assert.equal(interpolate('echo "${HOME} $(date)"', { inputs: {} }), 'echo "${HOME} $(date)"');
  });
});

describe("inputs — through compile()", () => {
  const yaml = `
name: w
inputs:
  name:
    default: world
jobs:
  a:
    runs-on: local
    steps:
      - env:
          NAME: \${{ inputs.name }}
        run: echo "hi \${{ inputs.name }}"
`;

  it("interpolates into both env values and run, using the default", () => {
    const s = step0(yaml);
    assert.equal(s.env["NAME"], "world");
    assert.equal(s.run, 'echo "hi world"');
  });

  it("uses the provided value", () => {
    const s = step0(yaml, { name: "josh" });
    assert.equal(s.env["NAME"], "josh");
    assert.equal(s.run, 'echo "hi josh"');
  });

  it("rejects referencing an input that isn't declared", () => {
    const bad = `name: w\njobs:\n  a:\n    steps:\n      - run: echo \${{ inputs.missing }}`;
    assert.throws(() => compile(parseWorkflow(bad)), WorkflowCompileError);
  });

  const numYaml = `
name: w
inputs:
  age: { type: number, default: 36 }
jobs:
  a:
    runs-on: local
    steps:
      - env:
          AGE: \${{ inputs.age }}
        run: echo \${{ inputs.age }}
`;

  it("interpolates a numeric input and stringifies it", () => {
    assert.equal(step0(numYaml).env["AGE"], "36");
    assert.equal(step0(numYaml).run, "echo 36");
    assert.equal(step0(numYaml, { age: 40 }).env["AGE"], "40");
  });

  it("rejects a wrong-typed input through compile()", () => {
    assert.throws(
      () => compile(parseWorkflow(numYaml), { inputs: { age: "old" } }),
      (e) => e instanceof WorkflowCompileError && /input "age" must be a number/.test(e.message),
    );
  });
});
