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
