/**
 * Durable run history — the `RunRepository` over the engine's `query` seam, and
 * the headline property: run records survive an engine restart on the same
 * `dataDir` (web-ui-research.md §8). Uses the real PGLite engine (no VM).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbsurdEngine, SILENT_LOG } from "../src/runtime/index.ts";
import { RunRepository } from "../src/persistence/runs.ts";

describe("RunRepository", () => {
  it("inserts, updates status, lists newest-first, and gets by id", async () => {
    const engine = await createAbsurdEngine({ log: SILENT_LOG });
    try {
      const repo = new RunRepository(engine);
      await repo.ensureSchema();

      await repo.insert({ id: "a", name: "ci", status: "running", trigger: "dispatch", startedAt: 1000, inputs: { who: "ada" } });
      await repo.insert({ id: "b", name: "incident", status: "running", trigger: "webhook", startedAt: 2000 });
      await repo.setStatus("a", "success", { finishedAt: 1500 });

      const list = await repo.list();
      assert.deepEqual(list.map((r) => r.id), ["b", "a"]); // newest-first by started_at
      const a = await repo.get("a");
      assert.equal(a?.status, "success");
      assert.equal(a?.finishedAt, 1500);
      assert.deepEqual(a?.inputs, { who: "ada" });
      assert.equal(a?.trigger, "dispatch");
      assert.equal((await repo.get("b"))?.trigger, "webhook");
    } finally {
      await engine.close();
    }
  });

  it("persists across an engine restart on the same dataDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-db-"));
    try {
      const e1 = await createAbsurdEngine({ dataDir: dir, log: SILENT_LOG });
      const r1 = new RunRepository(e1);
      await r1.ensureSchema();
      await r1.insert({ id: "survivor", name: "ci", status: "running", trigger: "dispatch", startedAt: 4242 });
      await r1.setStatus("survivor", "success", { finishedAt: 5000 });
      await e1.close();

      // Reopen the same dataDir in a fresh engine — the row must still be there.
      const e2 = await createAbsurdEngine({ dataDir: dir, log: SILENT_LOG });
      try {
        const r2 = new RunRepository(e2);
        await r2.ensureSchema(); // idempotent
        const got = await r2.get("survivor");
        assert.equal(got?.status, "success");
        assert.equal(got?.name, "ci");
        assert.equal(got?.finishedAt, 5000);
      } finally {
        await e2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
