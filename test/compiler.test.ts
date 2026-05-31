import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile, DEFAULT_RUNS_ON, WorkflowCompileError } from "../src/compiler/index.ts";

function plan(yaml: string) {
  return compile(parseWorkflow(yaml));
}

describe("compile — env layering", () => {
  it("layers workflow <- job <- step, later wins", () => {
    const p = plan(`
name: w
env: { A: "wf", B: "wf", C: "wf" }
jobs:
  a:
    env: { B: "job", C: "job" }
    steps:
      - run: "true"
        env: { C: "step" }
`);
    assert.deepEqual(p.jobs["a"]!.steps[0]!.env, { A: "wf", B: "job", C: "step" });
  });

  it("gives an empty env when nothing is declared", () => {
    const p = plan(`name: w\njobs:\n  a:\n    steps: [{ run: "true" }]`);
    assert.deepEqual(p.jobs["a"]!.steps[0]!.env, {});
  });
});

describe("compile — defaults and naming", () => {
  it("applies the default runs-on", () => {
    const p = plan(`name: w\njobs:\n  a:\n    steps: [{ run: "true" }]`);
    assert.equal(p.jobs["a"]!.runsOn, DEFAULT_RUNS_ON);
    assert.equal(DEFAULT_RUNS_ON, "local");
  });

  it("takes runs-on from each job, falling back to the default when omitted", () => {
    const p = plan(`
name: w
jobs:
  uses-default:
    steps: [{ run: "true" }]
  explicit:
    runs-on: gondolin
    steps: [{ run: "true" }]
`);
    assert.equal(p.jobs["uses-default"]!.runsOn, DEFAULT_RUNS_ON);
    assert.equal(p.jobs["explicit"]!.runsOn, "gondolin");
  });

  it("names steps <job>/<index> by default and <job>/<id> when id is set", () => {
    const p = plan(`
name: w
jobs:
  build:
    steps:
      - run: a
      - id: compile
        run: b
`);
    assert.equal(p.jobs["build"]!.steps[0]!.name, "build/0");
    assert.equal(p.jobs["build"]!.steps[1]!.name, "build/compile");
  });
});

describe("compile — job ordering", () => {
  it("orders independent jobs deterministically (alphabetical)", () => {
    const p = plan(`
name: w
jobs:
  zebra:
    steps: [{ run: "true" }]
  alpha:
    steps: [{ run: "true" }]
`);
    assert.deepEqual(p.jobOrder, ["alpha", "zebra"]);
  });

  it("respects needs in the topological order", () => {
    const p = plan(`
name: w
jobs:
  deploy:
    needs: [test]
    steps: [{ run: "true" }]
  test:
    needs: [build]
    steps: [{ run: "true" }]
  build:
    steps: [{ run: "true" }]
`);
    assert.deepEqual(p.jobOrder, ["build", "test", "deploy"]);
  });

  it("detects dependency cycles", () => {
    assert.throws(
      () =>
        plan(`
name: w
jobs:
  a:
    needs: [b]
    steps: [{ run: "true" }]
  b:
    needs: [a]
    steps: [{ run: "true" }]
`),
      (e) => e instanceof WorkflowCompileError && /cycle/.test(e.message),
    );
  });
});
