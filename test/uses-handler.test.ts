import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine, type UsesHandler } from "../src/runtime/index.ts";
import { hostTargetFactory } from "./_support.ts";

// Exercises the core's generic uses-handler contract with a NON-agent handler,
// proving the runtime is agent-agnostic: dispatch by scheme + output flow.
describe("uses-handler dispatch (core contract)", () => {
  let engine: AbsurdEngine;
  before(async () => {
    engine = await createAbsurdEngine();
  });
  after(async () => {
    await engine.close();
  });

  async function run(yaml: string, handlers: UsesHandler[]) {
    const plan = compile(parseWorkflow(yaml));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-uses-"));
    let output = "";
    try {
      const result = await new AbsurdRuntime({ engine, usesHandlers: handlers, makeTarget: hostTargetFactory }).run(plan, {
        workRoot,
        hooks: { onOutput: (_j, _s, c) => (output += c.text) },
      });
      return { result, output };
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  }

  it("dispatches a uses step to the handler for its scheme; outputs flow on", async () => {
    const fake: UsesHandler = {
      scheme: "fake",
      async run(ctx) {
        return { status: "success", outputs: { echoed: String(ctx.with["msg"] ?? "") } };
      },
    };
    const { result, output } = await run(
      `
name: u
jobs:
  go:
    runs-on: gondolin
    steps:
      - id: f
        uses: fake/thing
        with: { msg: "hello" }
      - env:
          GOT: \${{ steps.f.outputs.echoed }}
        run: echo "got=$GOT"
`,
      [fake],
    );
    assert.equal(result.status, "success");
    assert.match(output, /got=hello/);
  });

  it("fails (with a clear message) when no handler is registered for the scheme", async () => {
    const { result } = await run(
      `
name: u
jobs:
  go:
    runs-on: gondolin
    steps:
      - uses: nope/thing
`,
      [],
    );
    assert.equal(result.status, "failure");
    assert.match(result.jobs[0]!.steps[0]!.stderr, /no handler registered/);
  });
});
