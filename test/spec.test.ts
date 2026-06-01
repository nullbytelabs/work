import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow, WorkflowParseError } from "../src/spec/index.ts";

describe("parseWorkflow — valid input", () => {
  it("parses the minimal hello-world shape", () => {
    const spec = parseWorkflow(`
name: hello-world
env:
  HELLO_WORLD: "hello world"
jobs:
  hello-world:
    steps:
      - name: hello-world
        run: echo $HELLO_WORLD
`);
    assert.equal(spec.name, "hello-world");
    assert.deepEqual(spec.env, { HELLO_WORLD: "hello world" });
    assert.deepEqual(Object.keys(spec.jobs), ["hello-world"]);
    const job = spec.jobs["hello-world"]!;
    assert.equal(job.steps.length, 1);
    assert.equal(job.steps[0]!.run, "echo $HELLO_WORLD");
  });

  it("coerces scalar env values to strings", () => {
    const spec = parseWorkflow(`
name: w
env:
  PORT: 8080
  DEBUG: true
jobs:
  a:
    steps:
      - run: "true"
`);
    assert.deepEqual(spec.env, { PORT: "8080", DEBUG: "true" });
  });

  it("accepts both runsOn and runs-on spellings", () => {
    const spec = parseWorkflow(`
name: w
jobs:
  a:
    runs-on: gondolin
    steps:
      - run: "true"
`);
    assert.equal(spec.jobs["a"]!.runsOn, "gondolin");
  });

  it("parses inputs (shorthand null + full declaration)", () => {
    const spec = parseWorkflow(`
name: w
inputs:
  name:
  count:
    type: number
    required: true
    default: 3
    description: how many
jobs:
  a:
    steps: [{ run: "true" }]
`);
    assert.deepEqual(spec.inputs?.["name"], {});
    assert.deepEqual(spec.inputs?.["count"], { type: "number", required: true, default: 3, description: "how many" });
  });

  it("parses scalar-shorthand inputs (inferred type + default)", () => {
    const spec = parseWorkflow(`
name: w
inputs:
  age: 36
  who: bob
jobs:
  a:
    steps: [{ run: "true" }]
`);
    assert.deepEqual(spec.inputs?.["age"], { type: "number", default: 36 });
    assert.deepEqual(spec.inputs?.["who"], { type: "string", default: "bob" });
  });

  it("normalizes a scalar needs into an array", () => {
    const spec = parseWorkflow(`
name: w
jobs:
  a:
    steps: [{ run: "true" }]
  b:
    needs: a
    steps: [{ run: "true" }]
`);
    assert.deepEqual(spec.jobs["b"]!.needs, ["a"]);
  });
});

describe("parseWorkflow — validation", () => {
  function err(yaml: string): WorkflowParseError {
    try {
      parseWorkflow(yaml);
    } catch (e) {
      assert.ok(e instanceof WorkflowParseError, `expected WorkflowParseError, got ${e}`);
      return e;
    }
    throw new Error("expected parseWorkflow to throw");
  }

  it("rejects missing name", () => {
    assert.match(err(`jobs:\n  a:\n    steps: [{ run: x }]`).message, /name/);
  });

  it("rejects missing jobs", () => {
    assert.match(err(`name: w`).message, /jobs/);
  });

  it("rejects a job with no steps", () => {
    const e = err(`name: w\njobs:\n  a:\n    steps: []`);
    assert.equal(e.path, "jobs.a.steps");
  });

  it("rejects a step that has neither run nor uses", () => {
    const e = err(`name: w\njobs:\n  a:\n    steps:\n      - name: noop`);
    assert.equal(e.path, "jobs.a.steps[0]");
    assert.match(e.message, /run.*uses/);
  });

  it("rejects a step that has both run and uses", () => {
    const e = err(`name: w\njobs:\n  a:\n    steps:\n      - run: x\n        uses: y`);
    assert.match(e.message, /cannot define both/);
  });

  it("rejects needs that points at an unknown job", () => {
    const e = err(`name: w\njobs:\n  a:\n    needs: ghost\n    steps: [{ run: x }]`);
    assert.equal(e.path, "jobs.a.needs");
    assert.match(e.message, /ghost/);
  });

  it("rejects a top-level runs-on (it is defined per job)", () => {
    const e = err(`name: w\nruns-on: gondolin\njobs:\n  a:\n    steps: [{ run: x }]`);
    assert.equal(e.path, "runs-on");
    assert.match(e.message, /per job/);
  });

  it("gives a helpful error when runs-on is misplaced inside the jobs map", () => {
    const e = err(`name: w\njobs:\n  runs-on: gondolin\n  a:\n    steps: [{ run: x }]`);
    assert.equal(e.path, "jobs.runs-on");
    assert.match(e.message, /individual job/);
  });

  it("parses a step-level conditional (if)", () => {
    const spec = parseWorkflow(`name: w\njobs:\n  a:\n    steps:\n      - run: x\n        if: \${{ inputs.flag == 'yes' }}`);
    assert.equal(spec.jobs["a"]!.steps[0]!.if, "${{ inputs.flag == 'yes' }}");
  });

  it("parses a job-level conditional (when, as an if synonym)", () => {
    const spec = parseWorkflow(`name: w\njobs:\n  a:\n    when: success()\n    steps: [{ run: x }]`);
    assert.equal(spec.jobs["a"]!.if, "success()");
  });

  it("rejects a step that declares both if and when", () => {
    const e = err(`name: w\njobs:\n  a:\n    steps:\n      - run: x\n        if: success()\n        when: failure()`);
    assert.equal(e.path, "jobs.a.steps[0]");
    assert.match(e.message, /either "if" or "when"/);
  });

  it("rejects an invalid input type", () => {
    const e = err(`name: w\ninputs:\n  x:\n    type: secret\njobs:\n  a:\n    steps: [{ run: "true" }]`);
    assert.equal(e.path, "inputs.x.type");
  });

  it("rejects an invalid regex pattern", () => {
    const e = err(`name: w\ninputs:\n  x:\n    pattern: "([unclosed"\njobs:\n  a:\n    steps: [{ run: "true" }]`);
    assert.equal(e.path, "inputs.x.pattern");
    assert.match(e.message, /not a valid regular expression/);
  });

  it("rejects pattern on a non-string input", () => {
    const e = err(`name: w\ninputs:\n  x:\n    type: number\n    pattern: "^[0-9]+$"\njobs:\n  a:\n    steps: [{ run: "true" }]`);
    assert.match(e.message, /pattern only applies to string/);
  });

  it("rejects invalid YAML with a clear message", () => {
    assert.match(err(`name: : :`).message, /invalid YAML/);
  });

  it("includes a path on nested errors", () => {
    const e = err(`name: w\njobs:\n  build:\n    steps:\n      - run: ok\n      - name: bad`);
    assert.equal(e.path, "jobs.build.steps[1]");
  });
});
