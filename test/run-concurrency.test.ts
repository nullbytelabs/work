/**
 * RunManager concurrency bound — under a burst of triggers the manager must run
 * up to `maxConcurrentRuns`, queue up to `maxQueuedRuns` more, and shed the rest
 * with a non-accepted result (the HTTP layer returns 429). This guards against an
 * alert storm spawning unbounded gondolin VMs (webhook §7 / §12 #4).
 *
 * `dispatch` is synchronous and starts the run on a later microtask, so three
 * back-to-back dispatches see a frozen `active` count — the running/queued/shed
 * split is fully deterministic. We then let the event loop drain and confirm the
 * queued run actually executes once the first frees its slot.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAbsurdEngine, type AbsurdEngine } from "../src/runtime/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { hostTargetFactory } from "./_support.ts";
import { RunManager } from "../src/web/run-manager.ts";

const ECHO = `name: echo
jobs:
  say:
    runs-on: gondolin
    steps:
      - name: greet
        run: echo hi
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let engine: AbsurdEngine;
before(async () => {
  engine = await createAbsurdEngine();
});
after(async () => {
  await engine.close();
});

async function waitTerminal(rm: RunManager, ids: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = ids.every((id) => {
      const s = rm.get(id)?.status;
      return s === "success" || s === "failure";
    });
    if (done) return;
    await sleep(20);
  }
  throw new Error("timed out waiting for runs to finish");
}

describe("RunManager concurrency bound", () => {
  it("runs up to the limit, queues the next, and sheds past the queue cap", async () => {
    const rm = new RunManager({ engine, makeTarget: hostTargetFactory, maxConcurrentRuns: 1, maxQueuedRuns: 1 });
    const plan = compile(parseWorkflow(ECHO));
    const d = () => rm.dispatch({ name: "echo", layout: {}, plan });

    // Three synchronous dispatches — `active` can't change between them.
    const r1 = d();
    const r2 = d();
    const r3 = d();

    assert.equal(r1.accepted, true);
    assert.equal(r2.accepted, true);
    assert.equal(r3.accepted, false); // queue full → shed (→ 429)
    if (!r1.accepted || !r2.accepted) return assert.fail("r1/r2 should be accepted");

    assert.equal(r1.record.status, "running"); // took the only slot
    assert.equal(r2.record.status, "queued"); // waiting for it

    // Let the loop drain: r1 finishes, frees the slot, r2 dequeues and runs.
    await waitTerminal(rm, [r1.record.id, r2.record.id], 20_000);
    assert.equal(rm.get(r1.record.id)!.status, "success");
    assert.equal(rm.get(r2.record.id)!.status, "success");

    // Both accepted runs are in history; the shed one never got a record.
    assert.equal((await rm.list()).length, 2);

    // Drain before the shared engine closes (in after()) so no run's worker is
    // left polling an ended pool.
    await rm.whenIdle();
  });
});
