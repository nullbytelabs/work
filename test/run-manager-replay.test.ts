/**
 * The read-side companion to event persistence: a run that exists in `work.runs` but has
 * NO persisted event frames (recorded before event persistence, or any frameless run)
 * must still be viewable — `replayStoredStatus` surfaces its terminal status as a minimal
 * run-init + run-end, instead of the detail view hanging on "Running" (or a 404).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a minimal ServerResponse double. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../src/web/run-manager.ts";
import { RunRepository } from "../src/persistence/runs.ts";
import { RunEventRepository } from "../src/persistence/run-events.ts";
import { createAbsurdEngine } from "../src/runtime/index.ts";

function fakeRes() {
  const chunks: string[] = [];
  const res: any = {
    writeHead() {
      return res;
    },
    flushHeaders() {},
    write(s: string) {
      chunks.push(s);
      return true;
    },
    end() {},
  };
  return { res, chunks };
}

describe("RunManager.replayStoredStatus (frameless historical run)", () => {
  it("replays a stored terminal status as run-init + run-end", async () => {
    const engine = await createAbsurdEngine();
    try {
      const runStore = new RunRepository(engine);
      await runStore.ensureSchema();
      await runStore.insert({ id: "old-run", name: "ci", status: "success", trigger: "dispatch", startedAt: Date.now() });
      const rm = new RunManager({ engine, runStore }); // no eventStore → no frames

      const { res, chunks } = fakeRes();
      assert.equal(await rm.replayStoredStatus("old-run", res), true);
      const sse = chunks.join("");
      assert.match(sse, /event: run-init/, "emits run-init");
      assert.match(sse, /event: run-end/, "emits run-end");
      assert.match(sse, /"status":"success"/, "carries the stored terminal status");

      // An unknown run → false, and the response is left untouched (so the caller 404s).
      const miss = fakeRes();
      assert.equal(await rm.replayStoredStatus("nope", miss.res), false);
      assert.equal(miss.chunks.length, 0);
    } finally {
      await engine.close();
    }
  });
});

describe("RunManager.replayHistorical (persisted frames)", () => {
  it("synthesizes a terminal run-end when the stored frames lack one", async () => {
    const engine = await createAbsurdEngine();
    try {
      const runStore = new RunRepository(engine);
      const eventStore = new RunEventRepository(engine);
      await runStore.ensureSchema();
      await eventStore.ensureSchema();
      // A run whose row is terminal but whose persisted frames stop mid-stream — the
      // run-end append never landed (fire-and-forget dropped at shutdown).
      await runStore.insert({ id: "cut-run", name: "ci", status: "failure", trigger: "dispatch", startedAt: Date.now() });
      await runStore.setStatus("cut-run", "failure", { finishedAt: Date.now(), error: "boom" });
      await eventStore.append("cut-run", 0, { event: "run-init", data: { runId: "cut-run" } });
      await eventStore.append("cut-run", 1, { event: "job-start", data: { runId: "cut-run" } });

      const rm = new RunManager({ engine, runStore, eventStore });
      const { res, chunks } = fakeRes();
      assert.equal(await rm.replayHistorical("cut-run", res), true);
      const sse = chunks.join("");
      assert.match(sse, /event: run-init/, "replays the stored frames");
      assert.match(sse, /event: run-end/, "synthesizes the missing terminal frame");
      assert.match(sse, /"status":"failure"/, "carries the run row's terminal status");
      assert.match(sse, /"error":"boom"/, "carries the recorded error");
      // Exactly one run-end — a real one wouldn't be doubled.
      assert.equal(sse.match(/event: run-end/g)?.length, 1);
    } finally {
      await engine.close();
    }
  });

  it("does not add a second run-end when the frames already terminate", async () => {
    const engine = await createAbsurdEngine();
    try {
      const eventStore = new RunEventRepository(engine);
      await eventStore.ensureSchema();
      await eventStore.append("done-run", 0, { event: "run-init", data: { runId: "done-run" } });
      await eventStore.append("done-run", 1, { event: "run-end", data: { runId: "done-run", status: "success" } });

      const rm = new RunManager({ engine, eventStore }); // no runStore
      const { res, chunks } = fakeRes();
      assert.equal(await rm.replayHistorical("done-run", res), true);
      const sse = chunks.join("");
      assert.equal(sse.match(/event: run-end/g)?.length, 1, "the single stored run-end is left as-is");
    } finally {
      await engine.close();
    }
  });
});
