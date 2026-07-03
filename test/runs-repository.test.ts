/**
 * `RunRepository.setStatus` write semantics. A run retried under the SAME id (the
 * web console's "retry failed jobs") moves failure → running → success, and the
 * durable row must not keep the prior *failed* attempt's error/finish time —
 * otherwise the history + replay show a `success` run carrying a stale error.
 * setStatus SETs (not coalesce-merges) finished_at + error, so an omitted field
 * clears.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunRepository } from "../src/persistence/runs.ts";
import { createAbsurdEngine } from "../src/runtime/index.ts";

describe("RunRepository.setStatus — set-not-merge semantics", () => {
  it("a failure→running→success retry clears the prior attempt's error and finish time", async () => {
    const engine = await createAbsurdEngine();
    try {
      const runs = new RunRepository(engine);
      await runs.ensureSchema();
      await runs.insert({ id: "r1", name: "ci", status: "running", trigger: "dispatch", startedAt: 1000 });

      // First attempt fails with an error + finish time.
      await runs.setStatus("r1", "failure", { finishedAt: 2000, error: "boom on attempt 1" });
      let row = await runs.get("r1");
      assert.equal(row?.status, "failure");
      assert.equal(row?.error, "boom on attempt 1");
      assert.equal(row?.finishedAt, 2000);

      // Retry flips back to running with no opts — prior finish/error must clear.
      await runs.setStatus("r1", "running");
      row = await runs.get("r1");
      assert.equal(row?.status, "running");
      assert.equal(row?.error, undefined, "stale error must be cleared on re-run");
      assert.equal(row?.finishedAt, undefined, "stale finish time must be cleared on re-run");

      // The retry succeeds (no error passed) — the row must NOT resurrect the old error.
      await runs.setStatus("r1", "success", { finishedAt: 3000 });
      row = await runs.get("r1");
      assert.equal(row?.status, "success");
      assert.equal(row?.error, undefined, "a success row must never carry a prior failure's error");
      assert.equal(row?.finishedAt, 3000);
    } finally {
      await engine.close();
    }
  });
});
