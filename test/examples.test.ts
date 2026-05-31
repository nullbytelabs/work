import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { DirectRuntime } from "../src/runtime/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(HERE, "e2e");

const hasPython3 = spawnSync("python3", ["--version"]).status === 0;

/** Run an example file end-to-end on the local target; return its result. */
async function runExample(file: string) {
  const yaml = await readFile(join(EXAMPLES, file), "utf-8");
  const plan = compile(parseWorkflow(yaml));
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-ex-"));
  try {
    return await new DirectRuntime().run(plan, { workRoot });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

// Local-only examples (those without a gondolin job) should run green here.
const LOCAL_EXAMPLES: { file: string; needsPython?: boolean }[] = [
  { file: "hello-world-local.yaml" },
  { file: "pipeline-steps.yaml" },
  { file: "fan-out-fan-in.yaml" },
  { file: "matrix-style.yaml" },
  { file: "generated-script.yaml" },
  { file: "inline-polyglot.yaml", needsPython: true },
];

describe("examples — local runs succeed", () => {
  for (const ex of LOCAL_EXAMPLES) {
    const skip = ex.needsPython && !hasPython3 ? "python3 not on PATH" : false;
    it(`runs ${ex.file}`, { skip }, async () => {
      const result = await runExample(ex.file);
      assert.equal(result.status, "success", `${ex.file} should succeed`);
    });
  }
});

describe("examples — DAG shape", () => {
  it("fan-out-fan-in compiles to the expected topological order", async () => {
    const yaml = await readFile(join(EXAMPLES, "fan-out-fan-in.yaml"), "utf-8");
    const plan = compile(parseWorkflow(yaml));
    assert.deepEqual(plan.jobOrder, ["prepare", "lint", "typecheck", "unit", "report"]);
  });

  it("matrix-style runs every build-* sibling before aggregate", async () => {
    const yaml = await readFile(join(EXAMPLES, "matrix-style.yaml"), "utf-8");
    const plan = compile(parseWorkflow(yaml));
    const aggregateIdx = plan.jobOrder.indexOf("aggregate");
    for (const j of ["build-node18", "build-node20", "build-node22"]) {
      assert.ok(plan.jobOrder.indexOf(j) < aggregateIdx, `${j} must precede aggregate`);
    }
    assert.equal(aggregateIdx, plan.jobOrder.length - 1);
  });
});
