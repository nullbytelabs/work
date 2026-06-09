import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { resolveWorkflowLayout, resolveWorkflowRef } from "../src/project.ts";
import { useSharedRuntime, vmTestSkip } from "./_support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(HERE, "e2e");
// The e2e tier: every example runs on a REAL gondolin micro-VM (not the host
// double the other suites use), so this is the QEMU-dependent layer.
const runtime = useSharedRuntime({ realTargets: true });

// Inputs to supply for examples that declare required inputs (others default).
const EXAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  "input-validation": { release: "staging", id: "3cd7a864-f023-5a35-9db1-39a1be5bdcca" },
};

// Examples that reach the *external* network (clone a repo, download Node). They
// boot a real VM AND hit github.com / nodejs.org, so they're skipped by default to
// keep the suite hermetic; run them with WORK_TEST_NETWORK=1.
const NETWORK_EXAMPLES = new Set(["checkout", "install-node"]);
const RUN_NETWORK = process.env["WORK_TEST_NETWORK"] === "1";

// Examples that build a custom `work:<image>` (a real `gondolin build` — slow, and
// fetches apk packages), skipped by default like the network examples. Run with
// WORK_TEST_IMAGES=1.
const IMAGE_EXAMPLES = new Set(["work-base-image"]);
const RUN_IMAGES = process.env["WORK_TEST_IMAGES"] === "1";

/** Skip reason for an example that needs an opt-in (network / image build), else false. */
function exampleSkip(name: string): string | false {
  if (NETWORK_EXAMPLES.has(name) && !RUN_NETWORK) return "external network (set WORK_TEST_NETWORK=1)";
  if (IMAGE_EXAMPLES.has(name) && !RUN_IMAGES) return "builds a custom image (set WORK_TEST_IMAGES=1)";
  return false;
}

/** Every workflow file an example folder contributes: a root `workflow.yaml`, or
 *  every `.workflows/*.yaml` (a project may ship several pipelines, e.g. ci + review). */
function workflowFiles(name: string): string[] {
  const root = join(EXAMPLES, name, "workflow.yaml");
  if (existsSync(root)) return [root];
  const wfDir = join(EXAMPLES, name, ".workflows");
  if (existsSync(wfDir)) {
    return readdirSync(wfDir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => join(wfDir, f))
      .sort();
  }
  return [];
}

interface Example {
  /** The example folder name (keys `EXAMPLE_INPUTS`). */
  name: string;
  /** Display label — `folder` for a single workflow, `folder/file.yaml` for a multi-pipeline project. */
  label: string;
  /** Absolute path to the workflow file. */
  file: string;
}

// One entry per workflow file: a `.workflows/` project with several pipelines
// (agent-project ships `ci.yaml` + `review.yaml`) contributes one each.
const examples: Example[] = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d): Example[] => {
    const files = workflowFiles(d.name);
    return files.map((file) => ({
      name: d.name,
      label: files.length > 1 ? `${d.name}/${basename(file)}` : d.name,
      file,
    }));
  })
  .sort((a, b) => a.label.localeCompare(b.label));

function compilePlan(file: string, name: string) {
  const yaml = readFileSync(file, "utf-8");
  const layout = resolveWorkflowLayout(file);
  // Resolver-aware exactly like the CLI, so reusable-workflow examples (a `uses:`
  // job referencing a sibling `.workflows/*.yaml`) compile and inline.
  return compile(parseWorkflow(yaml), {
    inputs: EXAMPLE_INPUTS[name] ?? {},
    resolveWorkflow: resolveWorkflowRef,
    _fromDir: layout.workflowDir,
    _chain: [layout.file],
    _depth: 0,
  });
}

/** Run a workflow, staging its checkout exactly as the CLI does (via the shared layout resolver). */
async function runExample(file: string, name: string) {
  const plan = compilePlan(file, name);
  const layout = resolveWorkflowLayout(file);
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

// Every example runs on a real gondolin micro-VM (the guest ships
// sh/bash/node/npm/python3, so every step language runs in the sandbox). This is
// the QEMU tier — it self-skips without QEMU (or under WORK_SKIP_VM, the non-qemu
// `test:unit` target). The full `npm test` boots VMs wherever QEMU is installed.
describe("examples — every workflow runs to success", { skip: vmTestSkip() }, () => {
  for (const ex of examples) {
    it(`runs ${ex.label}`, { skip: exampleSkip(ex.name) }, async () => {
      const result = await runExample(ex.file, ex.name);
      assert.equal(result.status, "success", `${ex.label} should succeed`);
    });
  }
});

describe("examples — DAG shape", () => {
  it("fan-out-fan-in compiles to the expected topological order", () => {
    const plan = compilePlan(join(EXAMPLES, "fan-out-fan-in", "workflow.yaml"), "fan-out-fan-in");
    assert.deepEqual(plan.jobOrder, ["prepare", "lint", "typecheck", "unit", "report"]);
  });
});
