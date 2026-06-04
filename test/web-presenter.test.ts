/**
 * `WebPresenter` frame translation — the headline being step *display labels*.
 *
 * A step's stable name is `<job>/<id-or-index>` (e.g. `verify/0`) — the runtime's
 * durable checkpoint key and the client's correlation key. The author's `name:`
 * ("install dependencies") lives in `PlannedStep.title`. The browser must SHOW the
 * title, not the stable key — so every step frame (and the `run-init` seed) carries
 * `title` resolved from the plan, while keeping `stepName` as the stable key.
 *
 * Regression: step rows used to render `verify/0`, `verify/1`, … because the hooks
 * emitted the stable name as the label.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { WebPresenter, type Frame } from "../src/web/web-presenter.ts";

const YAML = `
name: ci
jobs:
  verify:
    steps:
      - name: install dependencies
        run: echo install
      - name: check main.ts is valid
        run: echo check
      - name: smoke test (npm start)
        run: echo smoke
`;

describe("WebPresenter step labels", () => {
  it("emits the author name: as the title on run-init and every step frame, keyed by the stable name", () => {
    const plan = compile(parseWorkflow(YAML), {});
    const frames: Frame[] = [];
    const p = new WebPresenter("run-1", (f) => frames.push(f));

    p.start(plan);

    // run-init seeds steps with the stable name AND the human title.
    const init = frames.find((f) => f.event === "run-init");
    assert.ok(init, "run-init emitted");
    const steps = (init!.data.jobs as Record<string, { steps: { name: string; title: string }[] }>).verify.steps;
    assert.deepEqual(
      steps.map((s) => s.name),
      ["verify/0", "verify/1", "verify/2"],
      "stable names preserved as the correlation key",
    );
    assert.deepEqual(
      steps.map((s) => s.title),
      ["install dependencies", "check main.ts is valid", "smoke test (npm start)"],
      "human titles surfaced for display",
    );

    // Live frames resolve the title from the stable name the hooks carry.
    p.hooks.onStepStart!("verify", "verify/1");
    p.hooks.onOutput!("verify", "verify/1", { stream: "stdout", text: "hi" });
    p.hooks.onStepEnd!("verify", { name: "verify/1", status: "success", exitCode: 0, stdout: "", stderr: "" });

    for (const ev of ["step-start", "step-output", "step-end"]) {
      const f = frames.find((fr) => fr.event === ev);
      assert.ok(f, `${ev} emitted`);
      assert.equal(f!.data.stepName, "verify/1", `${ev} keeps the stable stepName`);
      assert.equal(f!.data.title, "check main.ts is valid", `${ev} carries the human title`);
    }
  });

  it("falls back to the stable name when a step has no author name:", () => {
    const plan = compile(parseWorkflow("name: x\njobs:\n  j:\n    steps:\n      - run: echo hi\n"), {});
    const frames: Frame[] = [];
    const p = new WebPresenter("run-2", (f) => frames.push(f));
    p.start(plan);
    p.hooks.onStepStart!("j", "j/0");
    const f = frames.find((fr) => fr.event === "step-start");
    assert.equal(f!.data.title, "j/0", "no name: → title falls back to the stable key");
  });
});
