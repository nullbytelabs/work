import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionPlan, PlannedJob } from "../src/compiler/index.ts";
import { levelize } from "../src/tui/levels.ts";
import { RunStore } from "../src/tui/store.ts";
import { renderBoard, truncVisible } from "../src/tui/render.ts";

const ANSI = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
const strip = (s: string): string => s.replace(ANSI, "");

function job(id: string, needs: string[], steps = 1): PlannedJob {
  return {
    id,
    runsOn: "gondolin",
    needs,
    steps: Array.from({ length: steps }, (_, i) => ({ name: `${id}/${i}`, env: {} })),
  };
}

/** A diamond DAG: prepare -> {lint, unit, typecheck} -> report. */
function diamond(): ExecutionPlan {
  const jobs: Record<string, PlannedJob> = {
    prepare: job("prepare", [], 2),
    lint: job("lint", ["prepare"]),
    unit: job("unit", ["prepare"]),
    typecheck: job("typecheck", ["prepare"]),
    report: job("report", ["lint", "unit", "typecheck"]),
  };
  return { name: "diamond", jobs, jobOrder: ["prepare", "lint", "unit", "typecheck", "report"] };
}

describe("levelize", () => {
  it("assigns dependency depth over the needs DAG", () => {
    const { level, byLevel } = levelize(diamond());
    assert.equal(level.get("prepare"), 0);
    assert.equal(level.get("lint"), 1);
    assert.equal(level.get("unit"), 1);
    assert.equal(level.get("typecheck"), 1);
    assert.equal(level.get("report"), 2);
    assert.deepEqual(byLevel[0], ["prepare"]);
    assert.deepEqual(byLevel[1]!.sort(), ["lint", "typecheck", "unit"]);
    assert.deepEqual(byLevel[2], ["report"]);
  });

  it("treats every root as level 0", () => {
    const plan: ExecutionPlan = {
      name: "two-roots",
      jobs: { a: job("a", []), b: job("b", []) },
      jobOrder: ["a", "b"],
    };
    const { level } = levelize(plan);
    assert.equal(level.get("a"), 0);
    assert.equal(level.get("b"), 0);
  });
});

describe("RunStore", () => {
  it("orders by level then id and starts all jobs pending", () => {
    const store = new RunStore(diamond(), levelize(diamond()));
    assert.deepEqual(
      store.snapshot().map((j) => j.id),
      ["prepare", "lint", "typecheck", "unit", "report"],
    );
    assert.ok(store.snapshot().every((j) => j.phase === "pending"));
  });

  it("tracks phase, step progress, current step and a revision per hook", () => {
    const store = new RunStore(diamond(), levelize(diamond()));
    const r0 = store.revision();
    store.onJobStart("lint");
    assert.equal(store.states.get("lint")!.phase, "running");
    assert.ok(store.states.get("lint")!.startedAt !== undefined);
    assert.ok(store.revision() > r0);

    store.onStepStart("lint", "lint/0");
    assert.equal(store.states.get("lint")!.currentStep, "0");

    store.onStepEnd("lint", { name: "lint/0", status: "success", exitCode: 0, stdout: "", stderr: "" });
    assert.equal(store.states.get("lint")!.doneSteps, 1);
    assert.equal(store.states.get("lint")!.currentStep, undefined);

    store.onJobEnd("lint", { id: "lint", status: "success", steps: [] });
    assert.equal(store.states.get("lint")!.phase, "success");
    assert.ok(store.states.get("lint")!.endedAt !== undefined);
  });

  it("buffers step markers and output for commit", () => {
    const store = new RunStore(diamond(), levelize(diamond()));
    store.onStepStart("unit", "unit/0");
    store.onOutput("unit", "unit/0", { stream: "stdout", text: "12 passed\n" });
    store.onOutput("unit", "unit/0", { stream: "stderr", text: "a warning" });
    store.onStepEnd("unit", { name: "unit/0", status: "success", exitCode: 0, stdout: "", stderr: "" });
    assert.deepEqual(store.states.get("unit")!.log, ["> 0", "    12 passed", "  ! a warning", "  (ok, exit 0)"]);
  });

  it("records failure status from onStepEnd/onJobEnd", () => {
    const store = new RunStore(diamond(), levelize(diamond()));
    store.onJobEnd("unit", { id: "unit", status: "failure", steps: [] });
    assert.equal(store.states.get("unit")!.phase, "failure");
  });
});

describe("renderBoard", () => {
  const opts = { color: false, spinner: "*", width: 100, now: 10_000, final: false };

  it("renders the header with state counts and a row per job", () => {
    const store = new RunStore(diamond(), levelize(diamond()));
    store.onJobStart("prepare");
    store.onJobEnd("prepare", { id: "prepare", status: "success", steps: [] });
    store.onJobStart("lint");
    const lines = renderBoard(store.name, store.snapshot(), opts);
    assert.match(lines[0]!, /workflow: diamond/);
    assert.match(lines[0]!, /✓1/); // one success
    assert.match(lines[0]!, /▶1/); // one running
    // prepare row shows the success glyph; report shows blocked-on.
    assert.ok(lines.some((l) => /✓ prepare/.test(l)));
    assert.ok(lines.some((l) => /blocked on lint, unit, typecheck/.test(l)));
  });

  it("indents rows by topological level", () => {
    const store = new RunStore(diamond(), levelize(diamond()));
    const lines = renderBoard(store.name, store.snapshot(), opts);
    const report = lines.find((l) => /report/.test(l))!;
    const prepare = lines.find((l) => /prepare/.test(l))!;
    // report (level 2) is indented further than prepare (level 0).
    assert.ok(report.search(/\S/) > prepare.search(/\S/));
  });

  it("shows the running step as a sub-line", () => {
    const store = new RunStore(diamond(), levelize(diamond()));
    store.onJobStart("unit");
    store.onStepStart("unit", "unit/build");
    const lines = renderBoard(store.name, store.snapshot(), opts);
    assert.ok(lines.some((l) => /› build/.test(l)));
  });
});

describe("truncVisible", () => {
  it("leaves short strings untouched", () => {
    assert.equal(truncVisible("hello", 80), "hello");
  });

  it("truncates by visible width, ignoring ANSI codes", () => {
    const colored = "\x1b[32mhello world\x1b[0m";
    const out = truncVisible(colored, 6);
    assert.ok(strip(out).length <= 6);
    assert.ok(out.includes("…"));
    // the colour code is preserved, not counted toward width.
    assert.ok(out.startsWith("\x1b[32m"));
  });
});
