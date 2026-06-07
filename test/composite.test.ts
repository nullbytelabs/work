import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine, type UsesHandler, type UsesContext } from "../src/runtime/index.ts";
import { loadAction, loadBuiltinAction, createActionUsesHandler, type SubUsesDispatch } from "../src/actions/index.ts";
import { hostTargetFactory } from "./_support.ts";

// Composite actions (runs.using: composite): a step bundle run as one checkpoint.
// loadAction parsing is unit-tested; the runner is exercised end-to-end on the
// HostTarget (real `node`/shell), including an inner `uses:` sub-step dispatched
// through the sub-uses router and intra-action input/step interpolation.

async function writeAction(base: string, name: string, manifest: string): Promise<string> {
  const dir = join(base, "actions", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "action.yaml"), manifest);
  return join(base, "actions");
}

const GREET = `name: greet
inputs:
  who: { type: string, default: world }
outputs:
  message:
    value: \${{ steps.shape.outputs.greeting }}
  echoed:
    value: \${{ steps.echo.outputs.out }}
runs:
  using: composite
  steps:
    - id: shape
      run: echo "greeting=hi \${{ inputs.who }}" >> "$WORK_OUTPUT"
    - id: echo
      uses: probe/thing
      with:
        msg: \${{ steps.shape.outputs.greeting }}
`;

describe("loadAction (composite)", () => {
  it("parses composite steps and output value mappings", async () => {
    const base = await mkdtemp(join(tmpdir(), "comp-"));
    try {
      const actionsDir = await writeAction(base, "greet", GREET);
      const action = await loadAction("greet", actionsDir);
      assert.equal(action.kind, "composite");
      assert.equal(action.steps?.length, 2);
      assert.equal(action.steps?.[0]?.run !== undefined, true);
      assert.equal(action.steps?.[1]?.uses, "probe/thing");
      assert.deepEqual(action.outputValues, {
        message: "${{ steps.shape.outputs.greeting }}",
        echoed: "${{ steps.echo.outputs.out }}",
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("the built-in work/checkout and work/install-node are composite actions", async () => {
    const checkout = await loadBuiltinAction("checkout");
    assert.equal(checkout.kind, "composite");
    assert.ok(checkout.steps && checkout.steps.length >= 1);
    assert.ok("repo" in checkout.inputs);
    const node = await loadBuiltinAction("install-node");
    assert.equal(node.kind, "composite");
    assert.ok("version" in node.inputs);
  });
});

describe("composite action handler (end-to-end on the host double)", () => {
  let engine: AbsurdEngine;
  before(async () => {
    engine = await createAbsurdEngine();
  });
  after(async () => {
    await engine.close();
  });

  it("runs run+uses steps, threads inputs/step outputs, maps declared outputs", async () => {
    const base = await mkdtemp(join(tmpdir(), "comp-"));
    try {
      const actionsDir = await writeAction(base, "greet", GREET);

      // A fake sub-uses handler the dispatcher routes "probe/*" to.
      const handlers: UsesHandler[] = [];
      const dispatch: SubUsesDispatch = (subCtx: UsesContext) => {
        const h = handlers.find((x) => x.scheme === subCtx.uses.split("/", 1)[0]);
        return h ? h.run(subCtx) : Promise.resolve({ status: "failure", stderr: "no handler" });
      };
      const probe: UsesHandler = {
        scheme: "probe",
        async run(ctx) {
          return { status: "success", outputs: { out: `ECHO:${String(ctx.with["msg"] ?? "")}` } };
        },
      };
      handlers.push(probe, createActionUsesHandler({ actionsDir, dispatch }));

      const plan = compile(
        parseWorkflow(`
name: c
jobs:
  go:
    runs-on: gondolin
    steps:
      - id: g
        uses: action/greet
        with: { who: composite }
      - env:
          MSG: \${{ steps.g.outputs.message }}
          ECHOED: \${{ steps.g.outputs.echoed }}
        run: echo "msg=$MSG | echoed=$ECHOED"
`),
      );
      const workRoot = await mkdtemp(join(tmpdir(), "comp-run-"));
      let output = "";
      try {
        const result = await new AbsurdRuntime({ engine, usesHandlers: handlers, makeTarget: hostTargetFactory }).run(plan, {
          workRoot,
          hooks: { onOutput: (_j, _s, c) => (output += c.text) },
        });
        assert.equal(result.status, "success");
        // inputs.who interpolated into the run: step; steps.shape.outputs threaded
        // into the uses: sub-step's with:; both outputs mapped and surfaced.
        assert.match(output, /msg=hi composite \| echoed=ECHO:hi composite/);
      } finally {
        await rm(workRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
