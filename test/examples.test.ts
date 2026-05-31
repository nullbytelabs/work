import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { useSharedRuntime } from "./_support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(HERE, "e2e");
const runtime = useSharedRuntime();

const hasPython3 = spawnSync("python3", ["--version"]).status === 0;
const RUN_VM = process.env["PI_WF_TEST_GONDOLIN"] === "1";

// Examples needing a runtime not guaranteed in the local/CI environment.
const NEEDS_PYTHON = new Set(["inline-polyglot"]);

// Inputs to supply for examples that declare required inputs (others default).
const EXAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  "input-validation": { release: "staging", id: "3cd7a864-f023-5a35-9db1-39a1be5bdcca" },
};

/** Every e2e test is a folder containing a workflow.yaml (+ optional fixtures). */
const examples = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(EXAMPLES, d.name, "workflow.yaml")))
  .map((d) => d.name)
  .sort();

function compilePlan(name: string) {
  const yaml = readFileSync(join(EXAMPLES, name, "workflow.yaml"), "utf-8");
  return compile(parseWorkflow(yaml), { inputs: EXAMPLE_INPUTS[name] ?? {} });
}

/** Run an example's workflow, staging its folder into the workspace (as the CLI does). */
async function runExample(name: string) {
  const plan = compilePlan(name);
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-ex-"));
  try {
    return await runtime.run(plan, {
      workRoot,
      workspaceSource: join(EXAMPLES, name),
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

// Each example is classified by its compiled `runs-on`: any job on gondolin
// gates the whole example behind PI_WF_TEST_GONDOLIN (needs Node >= 23.6 + QEMU).
// This adapts automatically as examples move between local and gondolin.
describe("examples — every workflow runs to success", () => {
  for (const name of examples) {
    const plan = compilePlan(name);
    const usesGondolin = Object.values(plan.jobs).some((j) => j.runsOn === "gondolin");
    const skip = usesGondolin
      ? RUN_VM
        ? false
        : "set PI_WF_TEST_GONDOLIN=1 (needs Node >= 23.6 + QEMU)"
      : NEEDS_PYTHON.has(name) && !hasPython3
        ? "python3 not on PATH"
        : false;

    it(`runs ${name}`, { skip }, async () => {
      const result = await runExample(name);
      assert.equal(result.status, "success", `${name} should succeed`);
    });
  }
});

describe("examples — DAG shape", () => {
  it("fan-out-fan-in compiles to the expected topological order", () => {
    const plan = compilePlan("fan-out-fan-in");
    assert.deepEqual(plan.jobOrder, ["prepare", "lint", "typecheck", "unit", "report"]);
  });
});
