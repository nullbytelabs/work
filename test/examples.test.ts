import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { resolveWorkflowLayout } from "../src/project.ts";
import { useSharedRuntime } from "./_support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(HERE, "e2e");
// The e2e tier: every example runs on a REAL gondolin micro-VM (not the host
// double the other suites use), so this is the QEMU-dependent layer.
const runtime = useSharedRuntime({ realTargets: true });

// Inputs to supply for examples that declare required inputs (others default).
const EXAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  "input-validation": { release: "staging", id: "3cd7a864-f023-5a35-9db1-39a1be5bdcca" },
};

/** An example's workflow file: a root `workflow.yaml`, or a `.workflows/main.yaml` project. */
function workflowFile(name: string): string | undefined {
  const root = join(EXAMPLES, name, "workflow.yaml");
  if (existsSync(root)) return root;
  const project = join(EXAMPLES, name, ".workflows", "main.yaml");
  if (existsSync(project)) return project;
  return undefined;
}

/** Every e2e test is a folder with a workflow (root `workflow.yaml` or `.workflows/main.yaml`). */
const examples = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && workflowFile(d.name) !== undefined)
  .map((d) => d.name)
  .sort();

function compilePlan(name: string) {
  const yaml = readFileSync(workflowFile(name)!, "utf-8");
  return compile(parseWorkflow(yaml), { inputs: EXAMPLE_INPUTS[name] ?? {} });
}

/** Run an example, staging its checkout exactly as the CLI does (via the shared layout resolver). */
async function runExample(name: string) {
  const plan = compilePlan(name);
  const layout = resolveWorkflowLayout(workflowFile(name)!);
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-ex-"));
  try {
    return await runtime.run(plan, {
      workRoot,
      workspaceSource: layout.workspaceSource,
      workflowDir: layout.workflowDir,
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

// Every example runs unconditionally on a real gondolin micro-VM (the guest
// ships sh/bash/node/npm/python3, so every step language runs in the sandbox).
// CI provisions Node >= 23.6 + QEMU; some pipelines also install real npm deps.
describe("examples — every workflow runs to success", () => {
  for (const name of examples) {
    it(`runs ${name}`, async () => {
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
