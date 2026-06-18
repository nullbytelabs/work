import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { combineRunHooks } from "../src/observability/index.ts";
import type { RunHooks } from "../src/runtime/index.ts";

// combineRunHooks fans one run's lifecycle events out to several consumers (the
// presenter + the telemetry emitter). A consumer throwing in a hook must never
// abort the other consumers or the run itself — telemetry must never take down a
// workflow. These tests pin that isolation.
describe("combineRunHooks — consumer isolation", () => {
  it("one consumer throwing in every hook never breaks the others or the caller", () => {
    const calls: string[] = [];
    const boom = () => {
      throw new Error("consumer boom");
    };
    const thrower: RunHooks = {
      onWorkflowStart: boom,
      onJobStart: boom,
      onStepStart: boom,
      onOutput: boom,
      onStepEnd: boom,
      onJobEnd: boom,
      onWorkflowEnd: boom,
    };
    const spy: RunHooks = {
      onWorkflowStart: () => calls.push("onWorkflowStart"),
      onJobStart: () => calls.push("onJobStart"),
      onStepStart: () => calls.push("onStepStart"),
      onOutput: () => calls.push("onOutput"),
      onStepEnd: () => calls.push("onStepEnd"),
      onJobEnd: () => calls.push("onJobEnd"),
      onWorkflowEnd: () => calls.push("onWorkflowEnd"),
    };

    // thrower FIRST: unguarded, its throw would abort the fan-out before the spy ran.
    const hooks = combineRunHooks(thrower, spy);

    // Typed casts without depending on each meta/result's field shape.
    const meta = {} as Parameters<NonNullable<RunHooks["onWorkflowStart"]>>[0];
    const stepRes = {} as Parameters<NonNullable<RunHooks["onStepEnd"]>>[1];
    const jobRes = {} as Parameters<NonNullable<RunHooks["onJobEnd"]>>[1];
    const wfRes = {} as Parameters<NonNullable<RunHooks["onWorkflowEnd"]>>[0];

    assert.doesNotThrow(() => {
      hooks.onWorkflowStart!(meta);
      hooks.onJobStart!("job");
      hooks.onStepStart!("job", "step");
      hooks.onOutput!("job", "step", { stream: "stdout", text: "x" });
      hooks.onStepEnd!("job", stepRes);
      hooks.onJobEnd!("job", jobRes);
      hooks.onWorkflowEnd!(wfRes);
    });

    // The spy received EVERY event despite the thrower failing on each.
    assert.deepEqual(calls, ["onWorkflowStart", "onJobStart", "onStepStart", "onOutput", "onStepEnd", "onJobEnd", "onWorkflowEnd"]);
  });

  it("forwards to every consumer in registration order; undefined consumers are skipped", () => {
    const order: string[] = [];
    const a: RunHooks = { onJobStart: () => order.push("a") };
    const b: RunHooks = { onJobStart: () => order.push("b") };
    combineRunHooks(a, undefined, b).onJobStart!("job");
    assert.deepEqual(order, ["a", "b"]);
  });
});
