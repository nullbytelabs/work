import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine } from "../src/runtime/index.ts";
import { loadAction, createActionUsesHandler } from "../src/actions/index.ts";
import { hostTargetFactory } from "./_support.ts";

// JS actions: a project-owned `action.yaml` (runs: node) + a `main` script run
// in-guest with the INPUT_* / $WORK_OUTPUT ABI. loadAction is unit-tested; the
// handler is exercised end-to-end through the runtime on the HostTarget double
// (which runs `node` for real), so the whole stage→run→capture path is covered.

/** Write a JS action package into `<base>/actions/<name>/`. */
async function writeAction(base: string, name: string, manifest: string, main: string): Promise<string> {
  const dir = join(base, "actions", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "action.yaml"), manifest);
  await writeFile(join(dir, "index.mjs"), main);
  return join(base, "actions");
}

describe("loadAction (manifest)", () => {
  it("parses a node action (inputs/outputs/main)", async () => {
    const base = await mkdtemp(join(tmpdir(), "act-"));
    try {
      const actionsDir = await writeAction(
        base,
        "echo",
        `name: echo\ninputs:\n  target: { type: string, default: /workspace }\noutputs:\n  summary: { description: the echo }\nruns:\n  using: node\n  main: index.mjs\n`,
        "",
      );
      const action = await loadAction("echo", actionsDir);
      assert.equal(action.name, "echo");
      assert.equal(action.main, "index.mjs");
      assert.deepEqual(action.outputs, ["summary"]);
      assert.ok("target" in action.inputs);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects composite actions (not yet supported)", async () => {
    const base = await mkdtemp(join(tmpdir(), "act-"));
    try {
      const actionsDir = await writeAction(base, "c", `name: c\nruns:\n  using: composite\n  steps: []\n`, "");
      await assert.rejects(() => loadAction("c", actionsDir), /composite actions are not yet supported/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects an unknown action", async () => {
    const base = await mkdtemp(join(tmpdir(), "act-"));
    try {
      await assert.rejects(() => loadAction("missing", join(base, "actions")), /unknown action "missing"/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("action/<name> handler (end-to-end on the host double)", () => {
  let engine: AbsurdEngine;
  before(async () => {
    engine = await createAbsurdEngine();
  });
  after(async () => {
    await engine.close();
  });

  async function run(yaml: string, actionsDir: string) {
    const plan = compile(parseWorkflow(yaml));
    const workRoot = await mkdtemp(join(tmpdir(), "act-run-"));
    let output = "";
    try {
      const result = await new AbsurdRuntime({
        engine,
        usesHandlers: [createActionUsesHandler({ actionsDir })],
        makeTarget: hostTargetFactory,
      }).run(plan, { workRoot, hooks: { onOutput: (_j, _s, c) => (output += c.text) } });
      return { result, output };
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  }

  it("binds with: to INPUT_* env, runs the script, and surfaces declared outputs", async () => {
    const base = await mkdtemp(join(tmpdir(), "act-"));
    try {
      const actionsDir = await writeAction(
        base,
        "echo",
        `name: echo\ninputs:\n  target: { type: string, default: /workspace }\noutputs:\n  summary: {}\nruns:\n  using: node\n  main: index.mjs\n`,
        `import { appendFileSync } from "node:fs";\n` +
          `appendFileSync(process.env.WORK_OUTPUT, \`summary=\${process.env.INPUT_TARGET}\\n\`);\n`,
      );
      const { result, output } = await run(
        `
name: a
jobs:
  go:
    runs-on: gondolin
    steps:
      - id: r
        uses: action/echo
        with: { target: "pkg/core" }
      - env:
          GOT: \${{ steps.r.outputs.summary }}
        run: echo "got=$GOT"
`,
        actionsDir,
      );
      assert.equal(result.status, "success");
      assert.match(output, /got=pkg\/core/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails the step (cleanly) on an undeclared input", async () => {
    const base = await mkdtemp(join(tmpdir(), "act-"));
    try {
      const actionsDir = await writeAction(
        base,
        "echo",
        `name: echo\ninputs:\n  target: {}\nruns:\n  using: node\n  main: index.mjs\n`,
        `/* noop */\n`,
      );
      const { result } = await run(
        `
name: a
jobs:
  go:
    runs-on: gondolin
    steps:
      - uses: action/echo
        with: { bogus: "x" }
`,
        actionsDir,
      );
      assert.equal(result.status, "failure");
      assert.match(result.jobs[0]!.steps[0]!.stderr, /unknown input "bogus"/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
