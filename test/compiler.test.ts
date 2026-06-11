import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile, DEFAULT_RUNS_ON, MACHINE_TYPES, WorkflowCompileError } from "../src/compiler/index.ts";

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
  });

  it("compiles a job named like an Object prototype property without a false collision", () => {
    // Guards the `Object.hasOwn` fix in addJob — a plain `in` check would see the
    // inherited `toString` and throw a bogus "job id collision".
    const p = plan(`name: w\njobs:\n  toString:\n    steps: [{ run: "true" }]`);
    assert.ok(Object.hasOwn(p.jobs, "toString"));
    assert.deepEqual(p.jobOrder, ["toString"]);
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

  it("rejects runs-on: local with a hard compile error (host execution removed)", () => {
    assert.throws(
      () => plan(`name: w\njobs:\n  legacy:\n    runs-on: local\n    steps: [{ run: "true" }]`),
      (e) => e instanceof WorkflowCompileError && /"runs-on: local" has been removed/.test(e.message),
    );
  });

  it("rejects an unknown runs-on", () => {
    assert.throws(
      () => plan(`name: w\njobs:\n  a:\n    runs-on: mars\n    steps: [{ run: "true" }]`),
      (e) => e instanceof WorkflowCompileError && /unknown runs-on "mars"/.test(e.message),
    );
  });

  it("warns on an implicit (omitted) runs-on, and is silent when gondolin is explicit", () => {
    const p = plan(`
name: w
jobs:
  implicit:
    steps: [{ run: "true" }]
  explicit:
    runs-on: gondolin
    steps: [{ run: "true" }]
`);
    const warnings = p.warnings ?? [];
    assert.equal(warnings.length, 1);
    assert.ok(warnings.some((w) => /"implicit".*no "runs-on" set/.test(w)));
    assert.ok(!warnings.some((w) => /"explicit"/.test(w)));
  });

  it("omits warnings entirely when every job sets runs-on: gondolin", () => {
    const p = plan(`name: w\njobs:\n  a:\n    runs-on: gondolin\n    steps: [{ run: "true" }]`);
    assert.equal(p.warnings, undefined);
  });

  it("warns once per base job, not once per matrix leg (implicit runs-on)", () => {
    const p = plan(`
name: w
jobs:
  build:
    strategy:
      matrix:
        node: [18, 20, 22]
    steps: [{ run: "true" }]
`);
    assert.equal((p.warnings ?? []).length, 1);
  });

  it("defaults to the medium machine when none is declared", () => {
    const p = plan(`name: w\njobs:\n  a:\n    steps: [{ run: "true" }]`);
    assert.deepEqual(p.jobs["a"]!.machine, MACHINE_TYPES.medium);
  });

  it("resolves a named machine type from the catalog", () => {
    const p = plan(`name: w\njobs:\n  a:\n    machine: large\n    steps: [{ run: "true" }]`);
    assert.deepEqual(p.jobs["a"]!.machine, MACHINE_TYPES.large);
  });

  it("resolves a custom machine, inheriting the unset dimension from the default", () => {
    const p = plan(`
name: w
jobs:
  a:
    machine: { cpus: 8 }
    steps: [{ run: "true" }]
`);
    assert.deepEqual(p.jobs["a"]!.machine, { cpus: 8, memory: MACHINE_TYPES.medium!.memory });
  });

  it("rejects an unknown named machine type", () => {
    assert.throws(
      () => plan(`name: w\njobs:\n  a:\n    machine: ludicrous\n    steps: [{ run: "true" }]`),
      (e) => e instanceof WorkflowCompileError && /unknown machine type "ludicrous"/.test(e.message),
    );
  });

  it("rejects a non-positive cpu count and a malformed size", () => {
    assert.throws(
      () => plan(`name: w\njobs:\n  a:\n    machine: { cpus: 0 }\n    steps: [{ run: "true" }]`),
      (e) => e instanceof WorkflowCompileError && /machine\.cpus/.test(e.message),
    );
    assert.throws(
      () => plan(`name: w\njobs:\n  a:\n    machine: { memory: "lots" }\n    steps: [{ run: "true" }]`),
      (e) => e instanceof WorkflowCompileError && /machine\.memory/.test(e.message),
    );
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

describe("compile — conditionals", () => {
  it("carries a step-level if onto the planned step", () => {
    const p = plan(`
name: w
jobs:
  a:
    steps:
      - run: x
        if: \${{ inputs.flag == 'yes' }}
`);
    assert.equal(p.jobs["a"]!.steps[0]!.if, "${{ inputs.flag == 'yes' }}");
  });

  it("carries a job-level if onto every leg", () => {
    const p = plan(`
name: w
jobs:
  a:
    if: success()
    steps: [{ run: x }]
`);
    assert.equal(p.jobs["a"]!.if, "success()");
  });
});

describe("compile — matrix expansion", () => {
  it("expands a single axis into one leg per value", () => {
    const p = plan(`
name: w
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22, 24]
    steps:
      - run: test node \${{ matrix.node }}
`);
    assert.deepEqual(p.jobOrder, ["test::node-20", "test::node-22", "test::node-24"]);
    assert.equal(p.jobs["test::node-20"]!.title, "test (node=20)");
    assert.equal(p.jobs["test::node-20"]!.steps[0]!.run, "test node 20");
    assert.deepEqual(p.jobs["test::node-22"]!.matrix, { node: 22 });
  });

  it("takes the cartesian product of multiple axes", () => {
    const p = plan(`
name: w
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
        os: [linux, mac]
    steps: [{ run: "true" }]
`);
    assert.deepEqual(p.jobOrder.sort(), [
      "test::node-20_os-linux",
      "test::node-20_os-mac",
      "test::node-22_os-linux",
      "test::node-22_os-mac",
    ]);
  });

  it("prunes cells listed in exclude", () => {
    const p = plan(`
name: w
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
        os: [linux, mac]
        exclude:
          - { node: 22, os: mac }
    steps: [{ run: "true" }]
`);
    assert.ok(!("test::node-22_os-mac" in p.jobs));
    assert.equal(Object.keys(p.jobs).length, 3);
  });

  it("extends a matching cell via include", () => {
    const p = plan(`
name: w
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
        include:
          - { node: 22, experimental: true }
    steps:
      - run: echo \${{ matrix.experimental }}
        env: { X: "\${{ matrix.experimental }}" }
`);
    // The extended leg's id reflects the added key, and matrix.* resolves.
    assert.equal(p.jobs["test::node-22_experimental-true"]!.steps[0]!.env["X"], "true");
    // The non-matching leg has no `experimental` key (resolves to empty).
    assert.equal(p.jobs["test::node-20"]!.matrix!["experimental"], undefined);
    assert.equal(p.jobs["test::node-20"]!.steps[0]!.env["X"], "");
  });

  it("appends a standalone include cell that matches nothing", () => {
    const p = plan(`
name: w
jobs:
  test:
    strategy:
      matrix:
        node: [20]
        include:
          - { node: 99, label: edge }
    steps: [{ run: "true" }]
`);
    assert.ok("test::node-99_label-edge" in p.jobs);
    assert.deepEqual(p.jobs["test::node-99_label-edge"]!.matrix, { node: 99, label: "edge" });
  });

  it("converges dependents across all matrix legs", () => {
    const p = plan(`
name: w
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
    steps: [{ run: "true" }]
  report:
    needs: test
    steps: [{ run: "true" }]
`);
    assert.deepEqual(p.jobs["report"]!.needs.sort(), ["test::node-20", "test::node-22"]);
  });

  it("defers steps.<id>.logs / .outcome / .exitCode to runtime (left intact in the plan)", () => {
    const p = plan(`
name: w
jobs:
  a:
    outputs:
      l: "\${{ steps.tool.logs }}"
      o: "\${{ steps.tool.outcome }}"
      c: "\${{ steps.tool.exitCode }}"
    steps:
      - id: tool
        run: npm run lint
`);
    // Like steps.<id>.outputs.*, the built-ins resolve in the runtime, so the
    // compiler must leave the expressions untouched rather than erroring on them.
    assert.deepEqual(p.jobs["a"]!.outputs, {
      l: "${{ steps.tool.logs }}",
      o: "${{ steps.tool.outcome }}",
      c: "${{ steps.tool.exitCode }}",
    });
  });

  it("resolves matrix.* in run, env, and outputs", () => {
    const p = plan(`
name: w
jobs:
  test:
    strategy:
      matrix:
        node: [20]
    env: { NODE: "\${{ matrix.node }}" }
    outputs: { used: "\${{ matrix.node }}" }
    steps:
      - run: "true"
`);
    const leg = p.jobs["test::node-20"]!;
    assert.equal(leg.steps[0]!.env["NODE"], "20");
    assert.deepEqual(leg.outputs, { used: "20" });
  });
});
