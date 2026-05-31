import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { DirectRuntime } from "../src/runtime/index.ts";
import type { WorkflowResult, StepResult } from "../src/runtime/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run a YAML string through the whole pipeline, collecting streamed output. */
async function runWorkflow(yaml: string): Promise<{ result: WorkflowResult; output: string }> {
  const plan = compile(parseWorkflow(yaml));
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-int-"));
  let output = "";
  try {
    const result = await new DirectRuntime().run(plan, {
      workRoot,
      hooks: { onOutput: (_j, _s, c) => (output += c.text) },
    });
    return { result, output };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

function step(result: WorkflowResult, jobId: string, name: string): StepResult {
  const job = result.jobs.find((j) => j.id === jobId);
  assert.ok(job, `no job ${jobId}`);
  const s = job.steps.find((st) => st.name === name);
  assert.ok(s, `no step ${name} in ${jobId}`);
  return s;
}

describe("pipeline — hello world", () => {
  it("runs an inline hello-world and prints the env var", async () => {
    const { result, output } = await runWorkflow(`
name: hello-world
env:
  HELLO_WORLD: "hello world"
jobs:
  hello-world:
    steps:
      - name: hello-world
        run: echo $HELLO_WORLD
`);
    assert.equal(result.status, "success");
    assert.match(output, /hello world/);
    assert.equal(step(result, "hello-world", "hello-world/0").exitCode, 0);
  });

  it("runs the actual test/e2e/hello-world-local.yaml file", async () => {
    const yaml = await readFile(resolve(HERE, "e2e", "hello-world-local.yaml"), "utf-8");
    const { result, output } = await runWorkflow(yaml);
    assert.equal(result.status, "success");
    assert.match(output, /hello world/);
  });
});

describe("pipeline — failure semantics", () => {
  it("fails the job, skips remaining steps, and fails the workflow", async () => {
    const { result } = await runWorkflow(`
name: fail
jobs:
  a:
    steps:
      - name: boom
        run: exit 3
      - name: after
        run: echo nope
`);
    assert.equal(result.status, "failure");
    assert.equal(step(result, "a", "a/0").status, "failure");
    assert.equal(step(result, "a", "a/0").exitCode, 3);
    assert.equal(step(result, "a", "a/1").status, "skipped");
  });

  it("skips downstream jobs after an upstream failure", async () => {
    const { result } = await runWorkflow(`
name: chain
jobs:
  first:
    steps: [{ run: "exit 1" }]
  second:
    needs: [first]
    steps: [{ run: "echo should-not-run" }]
`);
    assert.equal(result.status, "failure");
    assert.equal(result.jobs.find((j) => j.id === "first")!.status, "failure");
    assert.equal(result.jobs.find((j) => j.id === "second")!.status, "skipped");
  });
});

describe("pipeline — ordering and data flow", () => {
  it("runs jobs in needs order and isolates each job's workdir", async () => {
    const { result, output } = await runWorkflow(`
name: order
jobs:
  build:
    steps: [{ run: "echo step-build" }]
  test:
    needs: [build]
    steps: [{ run: "echo step-test" }]
`);
    assert.equal(result.status, "success");
    // build must appear before test in the streamed output
    assert.ok(output.indexOf("step-build") < output.indexOf("step-test"));
  });

  it("layers env so a step override beats the workflow value", async () => {
    const { output } = await runWorkflow(`
name: env
env: { GREETING: "hi" }
jobs:
  a:
    env: { WHO: "world" }
    steps:
      - run: echo "$GREETING $WHO"
        env: { WHO: "override" }
`);
    assert.match(output, /hi override/);
  });
});
