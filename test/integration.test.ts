import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import type { WorkflowResult, StepResult } from "../src/runtime/index.ts";
import type { ExecutionTarget, RunResult } from "../src/targets/index.ts";
import { useSharedRuntime } from "./_support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const runtime = useSharedRuntime();

// Actions are workflow-local; point inline action tests at the agent-project's
// `.workflows/` so `uses: action/summarize` resolves to its composite action
// (`.workflows/actions/summarize`). AGENT_PROJECT is the project root.
const AGENT_PROJECT = resolve(HERE, "e2e", "agent-project");
const AGENT_WORKFLOWS = join(AGENT_PROJECT, ".workflows");

/** Run a YAML string through the whole pipeline (durably), collecting output. */
async function runWorkflow(
  yaml: string,
  workspaceSource?: string,
): Promise<{ result: WorkflowResult; output: string }> {
  const plan = compile(parseWorkflow(yaml));
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-int-"));
  let output = "";
  try {
    const result = await runtime.run(plan, {
      workRoot,
      ...(workspaceSource ? { workspaceSource } : {}),
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
  // (Running the committed example files end-to-end is covered by examples.test.ts.)
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
//   it("runs independent jobs in parallel (wall-clock beats serial)", async () => {
//     const t0 = Date.now();
//     const { result } = await runWorkflow(`
// name: parallel
// jobs:
//   a: { steps: [{ run: "sleep 0.4" }] }
//   b: { steps: [{ run: "sleep 0.4" }] }
//   c: { steps: [{ run: "sleep 0.4" }] }
// `);
//     const elapsed = Date.now() - t0;
//     assert.equal(result.status, "success");
//     // 3 × 0.4s serial = 1.2s; parallel should be well under. Generous margin.
//     assert.ok(elapsed < 1000, `expected parallel (<1000ms), took ${elapsed}ms`);
//   });

  it("passes a job output to a dependent via needs.<job>.outputs", async () => {
    const { output } = await runWorkflow(`
name: outputs
jobs:
  produce:
    runs-on: gondolin
    outputs:
      msg: \${{ steps.gen.outputs.msg }}
    steps:
      - id: gen
        run: printf 'msg=%s\\n' "hello-from-upstream" >> "$WORK_OUTPUT"
  consume:
    runs-on: gondolin
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
    runs-on: gondolin
    steps:
      - id: sum
        uses: work/agent
        with: { prompt: "x" }
`));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-trunc-"));
    let result: WorkflowResult;
    try {
      result = await runtime.run(plan, { workRoot, workspaceSource: AGENT_WORKFLOWS }, truncating);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
    const s = result.jobs[0]!.steps[0]!;
    assert.equal(s.status, "success");
    assert.match(s.stderr, /truncated \(finish_reason=length\)/);
  });

  it("surfaces an agent-step failure (error reaches both stderr and streamed output)", async () => {
    const boom = { run: async () => { throw new Error("kaboom from runner"); } };
    const plan = compile(parseWorkflow(`
name: f
jobs:
  go:
    runs-on: gondolin
    steps:
      - id: s
        uses: work/agent
        with: { prompt: "x" }
`));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-aerr-"));
    let result: WorkflowResult;
    let output = "";
    try {
      result = await runtime.run(plan, { workRoot, workspaceSource: AGENT_WORKFLOWS, hooks: { onOutput: (_j, _s, c) => (output += c.text) } }, boom);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
    const s = result.jobs[0]!.steps[0]!;
    assert.equal(result.status, "failure");
    assert.equal(s.status, "failure");
    assert.match(s.stderr, /kaboom from runner/);
    assert.match(output, /kaboom from runner/); // streamed so the CLI shows it
  });

  it("runs an agent step (mock runner) and exposes its summary output", async () => {
    const { result, output } = await runWorkflow(`
name: agent
jobs:
  go:
    runs-on: gondolin
    steps:
      - id: sum
        uses: work/agent
        with:
          prompt: "the text to summarize"
      - env:
          S: \${{ steps.sum.outputs.output }}
        run: echo "out=$S"
`, AGENT_WORKFLOWS);
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

// The real-world shape: a project keeps its pipeline + actions in `.workflows/`
// and the workflow operates on the PROJECT ROOT checkout. This proves the wiring
// offline (mock agent, no npm): checkout == project root, multiline `$WORK_OUTPUT`,
// and action resolution from `.workflows/actions/`.
describe("project layout (.workflows/): checkout is the project root", () => {
  it("stages the project root, captures multiline source, and resolves a .workflows agent", async () => {
    const plan = compile(parseWorkflow(`
name: layout
jobs:
  go:
    runs-on: gondolin
    steps:
      - name: checkout is the project root
        run: |
          test -f package.json && grep -q helloWorld main.ts && echo CHECKOUT_OK
      - id: read
        name: capture source (multiline)
        run: |
          {
            echo "source<<__EOF__"
            printf '%s\\n' "$(cat main.ts)"
            echo "__EOF__"
          } >> "$WORK_OUTPUT"
      - id: rev
        name: review with the project's own composite action
        uses: action/summarize
      - name: show
        env:
          R: \${{ steps.rev.outputs.summary }}
        run: echo "review=$R"
`));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-layout-"));
    let output = "";
    try {
      const result = await runtime.run(plan, {
        workRoot,
        workspaceSource: AGENT_PROJECT,
        workflowDir: join(AGENT_PROJECT, ".workflows"),
        hooks: { onOutput: (_j, _s, c) => (output += c.text) },
      });
      assert.equal(result.status, "success");
      assert.match(output, /CHECKOUT_OK/); // run steps see the project root checkout
      assert.match(output, /review=MOCK SUMMARY/); // composite action resolved from .workflows/actions/

      // The multiline source survived $WORK_OUTPUT heredoc capture intact.
      const src = result.jobs[0]!.steps.find((s) => s.outputs?.["source"])?.outputs?.["source"] ?? "";
      assert.match(src, /function helloWorld/);
      assert.match(src, /console\.log\(helloWorld\("Josh"\)\)/);
      assert.ok(src.includes("\n"), "captured source should be multiline");
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});

// A target whose run() rejects, to prove a *crash* (not a clean non-zero exit)
// still surfaces as a failure AND fires the presenter hooks, rather than throwing
// past onStepEnd/onJobEnd and leaving the TUI/web showing the job stuck "running".
class CrashingTarget implements ExecutionTarget {
  readonly kind = "crash";
  readonly workspacePath = "/tmp/crash";
  async provision(): Promise<void> {}
  run(): Promise<RunResult> {
    return Promise.reject(new Error("boom"));
  }
  async dispose(): Promise<void> {}
}
const crashingRuntime = useSharedRuntime({ makeTarget: () => new CrashingTarget() });

describe("pipeline — a crashing target still fires the presenter hooks", () => {
  it("a step whose target rejects → failure result, and onStepEnd + onJobEnd both fire", async () => {
    const plan = compile(parseWorkflow(`name: crash\njobs:\n  a:\n    steps:\n      - run: "true"`));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-crash-"));
    const stepEnds: string[] = [];
    const jobEnds: string[] = [];
    try {
      const result = await crashingRuntime.run(plan, {
        workRoot,
        hooks: {
          onStepEnd: (jobId, r) => stepEnds.push(`${jobId}:${r.status}`),
          onJobEnd: (jobId, r) => jobEnds.push(`${jobId}:${r.status}`),
        },
      });
      assert.equal(result.status, "failure");
      // A target crash interrupts the job, which fails the durable orchestrator
      // task (so the run stays resumable). The per-job failure is delivered through
      // the hooks — the contract that matters: the presenter isn't left showing the
      // job "running". (An interrupted run's WorkflowResult carries status only; the
      // job detail lives in the hooks + the journal, not the returned object.)
      assert.deepEqual(stepEnds, ["a:failure"]); // not stuck "running"
      assert.deepEqual(jobEnds, ["a:failure"]);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
