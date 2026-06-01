import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionPlan, PlannedJob } from "../src/compiler/index.ts";
import { emitGraph, isGraphFormat, GRAPH_FORMATS } from "../src/graph/index.ts";

function job(id: string, needs: string[], steps = 1): PlannedJob {
  return {
    id,
    runsOn: "gondolin",
    needs,
    steps: Array.from({ length: steps }, (_, i) => ({ name: `${id}/${i}`, env: {} })),
  };
}

/** prepare -> {lint, unit} -> report. */
function diamond(): ExecutionPlan {
  return {
    name: "diamond",
    jobs: {
      prepare: job("prepare", [], 2),
      lint: job("lint", ["prepare"], 1),
      unit: job("unit", ["prepare"], 3),
      report: job("report", ["lint", "unit"], 1),
    },
    jobOrder: ["prepare", "lint", "unit", "report"],
  };
}

describe("isGraphFormat", () => {
  it("accepts the four known formats and rejects others", () => {
    for (const f of GRAPH_FORMATS) assert.ok(isGraphFormat(f));
    assert.equal(isGraphFormat("svg"), false);
    assert.equal(isGraphFormat(""), false);
  });
});

describe("emitGraph: mermaid", () => {
  const out = emitGraph(diamond(), "mermaid");
  it("is a flowchart with a node per job and synthetic ids", () => {
    assert.match(out, /^flowchart TD/);
    assert.match(out, /n0\["prepare<br\/>gondolin · 2 steps"\]/);
    assert.match(out, /n1\["lint<br\/>gondolin · 1 step"\]/); // singular
  });
  it("emits an edge per dependency", () => {
    assert.match(out, /n0 --> n1/); // prepare -> lint
    assert.match(out, /n0 --> n2/); // prepare -> unit
    assert.match(out, /n1 --> n3/); // lint -> report
    assert.match(out, /n2 --> n3/); // unit -> report
  });
});

describe("emitGraph: dot", () => {
  const out = emitGraph(diamond(), "dot");
  it("is a digraph with rankdir and labelled nodes", () => {
    assert.match(out, /^digraph "diamond" \{/);
    assert.match(out, /rankdir=TB;/);
    assert.match(out, /"unit" \[label="unit\\ngondolin · 3 steps"\];/);
  });
  it("emits directed edges", () => {
    assert.match(out, /"prepare" -> "lint";/);
    assert.match(out, /"unit" -> "report";/);
  });
});

describe("emitGraph: json", () => {
  it("is parseable and carries shape + levels", () => {
    const parsed = JSON.parse(emitGraph(diamond(), "json"));
    assert.equal(parsed.name, "diamond");
    assert.deepEqual(parsed.jobOrder, ["prepare", "lint", "unit", "report"]);
    assert.equal(parsed.jobs.prepare.level, 0);
    assert.equal(parsed.jobs.report.level, 2);
    assert.deepEqual(parsed.jobs.report.needs, ["lint", "unit"]);
    assert.equal(parsed.jobs.unit.steps, 3);
  });
});

/** A plan with named/uses steps to exercise step expansion. */
function withSteps(): ExecutionPlan {
  return {
    name: "ci",
    jobs: {
      verify: {
        id: "verify",
        runsOn: "gondolin",
        needs: [],
        steps: [
          { name: "verify/0", title: "install dependencies", env: {}, run: "npm i" },
          { name: "verify/read", id: "read", title: "capture source", env: {}, run: "cat x" },
        ],
      },
      review: {
        id: "review",
        runsOn: "gondolin",
        needs: ["verify"],
        steps: [{ name: "review/summary", id: "summary", title: "review with agent", env: {}, uses: "agent/summarize" }],
      },
    },
    jobOrder: ["verify", "review"],
  };
}

describe("emitGraph: steps option", () => {
  it("ascii lists ordered steps with uses ref and id tag", () => {
    const out = emitGraph(withSteps(), "ascii", { steps: true });
    assert.match(out, /1\. install dependencies/);
    assert.match(out, /2\. capture source {2}\[read\]/);
    assert.match(out, /1\. review with agent {2}→ uses agent\/summarize {2}\[summary\]/);
  });

  it("json adds a stepList with kind/uses/id", () => {
    const parsed = JSON.parse(emitGraph(withSteps(), "json", { steps: true }));
    assert.deepEqual(parsed.jobs.verify.stepList[0], { name: "install dependencies", kind: "run" });
    assert.deepEqual(parsed.jobs.verify.stepList[1], { name: "capture source", kind: "run", id: "read" });
    assert.deepEqual(parsed.jobs.review.stepList[0], {
      name: "review with agent",
      kind: "uses",
      uses: "agent/summarize",
      id: "summary",
    });
  });

  it("mermaid renders steps as first-class subgraph nodes", () => {
    const out = emitGraph(withSteps(), "mermaid", { steps: true });
    assert.match(out, /subgraph n0\["verify · gondolin"\]/);
    assert.match(out, /n0_s1\["1\. install dependencies"\]/);
    assert.match(out, /n0_s1 --> n0_s2/); // ordered chain
    // uses step gets the stadium shape and uses ref
    assert.match(out, /n1_s1\(\["1\. review with agent.*uses agent\/summarize.*"\]\)/);
    assert.match(out, /n0 --> n1/); // job dependency between subgraphs
  });

  it("dot renders steps as clustered nodes with cluster-to-cluster edges", () => {
    const out = emitGraph(withSteps(), "dot", { steps: true });
    assert.match(out, /compound=true;/);
    assert.match(out, /subgraph cluster_0 \{/);
    assert.match(out, /j0s1 \[label="1\. install dependencies"\];/);
    assert.match(out, /j0s1 -> j0s2;/); // ordered chain
    assert.match(out, /fillcolor="#eaf2ff"/); // uses step styled
    assert.match(out, /j0s2 -> j1s1 \[ltail=cluster_0, lhead=cluster_1\];/);
  });

  it("omits step detail by default", () => {
    assert.doesNotMatch(emitGraph(withSteps(), "ascii"), /install dependencies/);
    assert.ok(!("stepList" in JSON.parse(emitGraph(withSteps(), "json")).jobs.verify));
  });
});

describe("emitGraph: ascii", () => {
  const out = emitGraph(diamond(), "ascii");
  it("groups jobs by level and pluralizes steps", () => {
    assert.match(out, /diamond {2}\(4 jobs, 3 levels\)/);
    assert.match(out, /level 0:/);
    assert.match(out, /• prepare {2}.*2 steps/);
    assert.match(out, /• lint {5}.*1 step\b/); // singular
  });
  it("annotates upstream dependencies", () => {
    assert.match(out, /• report {3}.*← lint, unit/);
  });
});
