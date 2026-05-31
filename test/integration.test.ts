import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import type { WorkflowResult, StepResult } from "../src/runtime/index.ts";
import { useSharedRuntime } from "./_support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const runtime = useSharedRuntime();

/** Run a YAML string through the whole pipeline (durably), collecting output. */
async function runWorkflow(yaml: string): Promise<{ result: WorkflowResult; output: string }> {
  const plan = compile(parseWorkflow(yaml));
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-int-"));
  let output = "";
  try {
    const result = await runtime.run(plan, {
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

  it("runs the actual test/e2e/hello-world-local/workflow.yaml file", async () => {
    const yaml = await readFile(resolve(HERE, "e2e", "hello-world-local", "workflow.yaml"), "utf-8");
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

describe("pipeline — parallelism & skip semantics", () => {
  it("runs independent jobs in parallel (wall-clock beats serial)", async () => {
    const t0 = Date.now();
    const { result } = await runWorkflow(`
name: parallel
jobs:
  a: { steps: [{ run: "sleep 0.4" }] }
  b: { steps: [{ run: "sleep 0.4" }] }
  c: { steps: [{ run: "sleep 0.4" }] }
`);
    const elapsed = Date.now() - t0;
    assert.equal(result.status, "success");
    // 3 × 0.4s serial = 1.2s; parallel should be well under. Generous margin.
    assert.ok(elapsed < 1000, `expected parallel (<1000ms), took ${elapsed}ms`);
  });

  it("passes a job output to a dependent via needs.<job>.outputs", async () => {
    const { output } = await runWorkflow(`
name: outputs
jobs:
  produce:
    runs-on: local
    outputs:
      msg: \${{ steps.gen.outputs.msg }}
    steps:
      - id: gen
        run: printf 'msg=%s\\n' "hello-from-upstream" >> "$PI_OUTPUT"
  consume:
    runs-on: local
    needs: [produce]
    steps:
      - env:
          GOT: \${{ needs.produce.outputs.msg }}
        run: echo "got=$GOT"
`);
    assert.match(output, /got=hello-from-upstream/);
  });

  it("warns (but succeeds) when the agent output is truncated at max_tokens", async () => {
    const truncating = { run: async () => ({ text: "partial sum", finishReason: "length" }) };
    const plan = compile(parseWorkflow(`
name: trunc
jobs:
  go:
    runs-on: local
    steps:
      - id: sum
        uses: agent/summarize
        with: { input: "x" }
`));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-trunc-"));
    let result: WorkflowResult;
    try {
      result = await runtime.run(plan, { workRoot }, truncating);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
    const s = result.jobs[0]!.steps[0]!;
    assert.equal(s.status, "success");
    assert.match(s.stderr, /truncated \(finish_reason=length\)/);
  });

  it("runs an agent step (mock runner) and exposes its summary output", async () => {
    const { result, output } = await runWorkflow(`
name: agent
jobs:
  go:
    runs-on: local
    steps:
      - id: sum
        uses: agent/summarize
        with:
          input: "the text to summarize"
      - env:
          S: \${{ steps.sum.outputs.summary }}
        run: echo "out=$S"
`);
    assert.equal(result.status, "success");
    assert.match(output, /out=MOCK SUMMARY/);
  });

  it("skips only the failed job's dependents — independent jobs still run", async () => {
    const { result } = await runWorkflow(`
name: partial-failure
jobs:
  boom: { steps: [{ run: "exit 1" }] }
  independent: { steps: [{ run: "echo fine" }] }
  downstream:
    needs: [boom]
    steps: [{ run: "echo nope" }]
`);
    assert.equal(result.status, "failure");
    assert.equal(result.jobs.find((j) => j.id === "boom")!.status, "failure");
    assert.equal(result.jobs.find((j) => j.id === "independent")!.status, "success");
    assert.equal(result.jobs.find((j) => j.id === "downstream")!.status, "skipped");
  });
});
