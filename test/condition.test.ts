import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCondition, ConditionError } from "../src/compiler/index.ts";

const T = (expr: string, ctx?: Parameters<typeof evaluateCondition>[1]) => evaluateCondition(expr, ctx);

describe("evaluateCondition — literals and truthiness", () => {
  it("treats bare boolean literals as themselves", () => {
    assert.equal(T("true"), true);
    assert.equal(T("false"), false);
  });

  it("unwraps a ${{ }} wrapper", () => {
    assert.equal(T("${{ true }}"), true);
    assert.equal(T("${{ false }}"), false);
  });

  it("applies GHA-style truthiness to scalars", () => {
    assert.equal(T("'hello'"), true);
    assert.equal(T("''"), false);
    assert.equal(T("1"), true);
    assert.equal(T("0"), false);
    assert.equal(T("null"), false);
  });

  it("unescapes a doubled quote inside a string literal (GHA-style ''→')", () => {
    // The literal 'a''b' is the 3-char string a'b — not two adjacent strings.
    assert.equal(T("inputs.s == 'a''b'", { inputs: { s: "a'b" } }), true);
    assert.equal(T("inputs.s == 'a''b'", { inputs: { s: "ab" } }), false);
  });
});

describe("evaluateCondition — operators", () => {
  it("compares with == and != (loose, numeric-aware)", () => {
    assert.equal(T("1 == 1"), true);
    assert.equal(T("1 == 2"), false);
    assert.equal(T("'a' == 'a'"), true);
    assert.equal(T("'a' != 'b'"), true);
    assert.equal(T("'20' == 20"), true); // numeric coercion
  });

  it("supports && || ! and parentheses with correct precedence", () => {
    assert.equal(T("true && false"), false);
    assert.equal(T("true || false"), true);
    assert.equal(T("!false"), true);
    assert.equal(T("true && false || true"), true);
    assert.equal(T("true && (false || false)"), false);
    assert.equal(T("!(1 == 1)"), false);
  });
});

describe("evaluateCondition — contexts", () => {
  it("reads inputs, matrix, needs, and steps", () => {
    const ctx = {
      inputs: { release: "staging" },
      matrix: { node: 20 },
      needs: { build: { result: "success", outputs: { dist: "./out" } } },
      steps: { compile: { result: "success", outputs: { ok: "yes" } } },
    };
    assert.equal(T("inputs.release == 'staging'", ctx), true);
    assert.equal(T("matrix.node == 20", ctx), true);
    assert.equal(T("needs.build.result == 'success'", ctx), true);
    assert.equal(T("needs.build.outputs.dist == './out'", ctx), true);
    assert.equal(T("steps.compile.outputs.ok == 'yes'", ctx), true);
  });

  it("returns false for a missing context member rather than throwing", () => {
    assert.equal(T("inputs.ghost == 'x'", { inputs: {} }), false);
    assert.equal(T("inputs.ghost", { inputs: {} }), false);
  });

  it("errors on an unknown context root", () => {
    assert.throws(() => T("github.event_name == 'push'"), (e) => e instanceof ConditionError);
  });

  it("errors when matrix is referenced without a matrix context", () => {
    assert.throws(() => T("matrix.node == 20"), (e) => e instanceof ConditionError && /matrix context/.test(e.message));
  });
});

describe("evaluateCondition — status functions", () => {
  it("reflects the provided status", () => {
    const ok = { status: { success: true, failure: false } };
    const bad = { status: { success: false, failure: true } };
    assert.equal(T("success()", ok), true);
    assert.equal(T("success()", bad), false);
    assert.equal(T("failure()", bad), true);
    assert.equal(T("always()", bad), true);
    assert.equal(T("cancelled()", bad), false);
  });

  it("defaults to success when no status is supplied", () => {
    assert.equal(T("success()"), true);
    assert.equal(T("failure()"), false);
  });

  it("composes status functions with conditions", () => {
    const ctx = { status: { success: false, failure: true }, needs: { a: { result: "failure", outputs: {} } } };
    assert.equal(T("always() && needs.a.result == 'failure'", ctx), true);
  });

  it("errors on an unknown function", () => {
    assert.throws(() => T("contains('abc', 'a')"), (e) => e instanceof ConditionError);
  });
});

describe("evaluateCondition — malformed input", () => {
  it("rejects an empty condition", () => {
    assert.throws(() => T("${{  }}"), (e) => e instanceof ConditionError);
  });
  it("rejects an unterminated string", () => {
    assert.throws(() => T("'oops"), (e) => e instanceof ConditionError);
  });
  it("rejects a dangling operator", () => {
    assert.throws(() => T("true &&"), (e) => e instanceof ConditionError);
  });
});
