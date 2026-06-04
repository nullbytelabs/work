/**
 * Durable per-run event log — the `RunEventRepository` over the engine's `query`
 * seam (web-ui-research.md §8, Phase 2). Mirrors `persistence-runs.test.ts`:
 * append/list/has ordering, and the headline property that a finished run's frame
 * stream survives an engine restart on the same `dataDir` (so a fresh server can
 * replay it). Uses the real PGLite engine (no VM).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbsurdEngine, SILENT_LOG } from "../src/runtime/index.ts";
import { RunEventRepository } from "../src/persistence/run-events.ts";

describe("RunEventRepository", () => {
  it("appends, lists in seq order, and reports presence by run", async () => {
    const engine = await createAbsurdEngine({ log: SILENT_LOG });
    try {
      const repo = new RunEventRepository(engine);
      await repo.ensureSchema();

      assert.equal(await repo.has("r1"), false);

      // Append out of seq order to prove `list` orders by seq, not insert time.
      await repo.append("r1", 2, { event: "run-end", data: { status: "success" } });
      await repo.append("r1", 0, { event: "run-init", data: { name: "echo" } });
      await repo.append("r1", 1, { event: "step-output", data: { text: "HELLO" } });
      // A different run's frames must not bleed into r1's stream.
      await repo.append("r2", 0, { event: "run-init", data: { name: "other" } });

      assert.equal(await repo.has("r1"), true);
      assert.equal(await repo.has("nope"), false);

      const frames = await repo.list("r1");
      assert.deepEqual(frames.map((f) => f.event), ["run-init", "step-output", "run-end"]);
      assert.deepEqual(frames[1]!.data, { text: "HELLO" });
      assert.equal((await repo.list("r2")).length, 1);
    } finally {
      await engine.close();
    }
  });

  it("ignores a duplicate (run_id, seq) append (on conflict do nothing)", async () => {
    const engine = await createAbsurdEngine({ log: SILENT_LOG });
    try {
      const repo = new RunEventRepository(engine);
      await repo.ensureSchema();
      await repo.append("r", 0, { event: "run-init", data: { v: 1 } });
      await repo.append("r", 0, { event: "run-init", data: { v: 2 } }); // same seq → ignored
      const frames = await repo.list("r");
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0]!.data, { v: 1 });
    } finally {
      await engine.close();
    }
  });

  it("persists frames across an engine restart on the same dataDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-events-"));
    try {
      const e1 = await createAbsurdEngine({ dataDir: dir, log: SILENT_LOG });
      const r1 = new RunEventRepository(e1);
      await r1.ensureSchema();
      await r1.append("survivor", 0, { event: "run-init", data: { name: "ci" } });
      await r1.append("survivor", 1, { event: "step-output", data: { text: "HELLO-LOG" } });
      await r1.append("survivor", 2, { event: "run-end", data: { status: "success" } });
      await e1.close();

      const e2 = await createAbsurdEngine({ dataDir: dir, log: SILENT_LOG });
      try {
        const r2 = new RunEventRepository(e2);
        await r2.ensureSchema(); // idempotent
        assert.equal(await r2.has("survivor"), true);
        const frames = await r2.list("survivor");
        assert.deepEqual(frames.map((f) => f.event), ["run-init", "step-output", "run-end"]);
        assert.equal(frames[1]!.data["text"], "HELLO-LOG");
      } finally {
        await e2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
