/**
 * Retry slot reservation — the anti-zombie invariant behind `POST /api/runs/:id/retry`.
 *
 * The retry endpoint irreversibly clears a run's failed jobs from the durable journal
 * (they can't be restored) BEFORE dispatching the re-run. If the dispatch then shed at
 * capacity (429), the run would be left corrupted: journal cleared, status 'running',
 * nothing relaunched. So `postRetry` reserves a slot up front (`tryReserve`) — this
 * verifies the reservation actually holds capacity against a concurrent dispatch and is
 * handed back cleanly on `releaseReservation` (the empty-retry / error paths).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../src/web/run-manager.ts";
import type { ExecutionPlan } from "../src/compiler/index.ts";
import { createAbsurdEngine } from "../src/runtime/index.ts";

/** A minimal plan; a shed dispatch returns before ever reading it. */
const PLAN: ExecutionPlan = { name: "x", jobs: {}, jobOrder: [], inputs: {} };

describe("RunManager — retry slot reservation", () => {
  it("holds the last slot so a concurrent dispatch sheds, and frees it on release", async () => {
    const engine = await createAbsurdEngine();
    try {
      // One slot, no queue — the tight case the review cites (maxQueuedRuns: 0).
      const rm = new RunManager({ engine, maxConcurrentRuns: 1, maxQueuedRuns: 0 });

      // Reserve the only slot, exactly as postRetry does before touching the journal.
      assert.equal(rm.tryReserve(), true);

      // A fresh dispatch now sheds (the slot is spoken for) — and, crucially, sheds
      // WITHOUT launching, so no run is created behind the reservation's back.
      assert.equal(rm.dispatch({ name: "other", layout: {}, plan: PLAN }).accepted, false);

      // A second reservation also fails — capacity can't be oversubscribed.
      assert.equal(rm.tryReserve(), false);

      // Handing the slot back (the 409 / error path) frees capacity again.
      rm.releaseReservation();
      assert.equal(rm.tryReserve(), true);
    } finally {
      await engine.close();
    }
  });
});
