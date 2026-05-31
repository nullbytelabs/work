import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAbsurdEngine, ABSURD_SCHEMA_VERSION, SILENT_LOG, type AbsurdEngine } from "../src/runtime/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("absurd engine (PGLite-backed)", () => {
  let engine: AbsurdEngine;
  before(async () => {
    // Silent logger: the retry test intentionally fails a step once, and we
    // don't want Absurd's expected-failure log spamming the test output.
    engine = await createAbsurdEngine({ log: SILENT_LOG });
  });
  after(async () => {
    await engine.close();
  });

  it("applies the pinned schema and reports its version", async () => {
    assert.equal(ABSURD_SCHEMA_VERSION, "0.4.0");
  });

  it("memoizes completed steps across a task retry (durable checkpointing)", async () => {
    const app = engine.app;
    let firstRuns = 0;
    let secondAttempts = 0;

    app.registerTask({ name: "retry-demo", queue: "default", defaultMaxAttempts: 3 }, async (_p, ctx) => {
      const a = await ctx.step("first", async () => {
        firstRuns++;
        return 21;
      });
      const b = await ctx.step("second", async () => {
        secondAttempts++;
        if (secondAttempts === 1) throw new Error("transient boom"); // fail attempt 1
        return a * 2;
      });
      return { a, b };
    });

    const { taskID } = await app.spawn(
      "retry-demo",
      {},
      { queue: "default", maxAttempts: 3, retryStrategy: { kind: "fixed", baseSeconds: 0 } },
    );

    let snap = await app.fetchTaskResult(taskID);
    for (let i = 0; i < 200; i++) {
      if (snap && (snap.state === "completed" || snap.state === "failed" || snap.state === "cancelled")) break;
      await app.workBatch("w", 60, 1);
      snap = await app.fetchTaskResult(taskID);
      await sleep(10);
    }

    assert.equal(snap?.state, "completed", `expected completion, got ${JSON.stringify(snap)}`);
    assert.deepEqual((snap as { result: unknown }).result, { a: 21, b: 42 });
    // The crux: the first step's checkpoint persisted through the failed run, so
    // it was NOT recomputed on the retry.
    assert.equal(firstRuns, 1, "first step should run once (memoized across retry)");
    assert.ok(secondAttempts >= 2, "second step should have retried");
  });
});
