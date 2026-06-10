/**
 * `resume <id>` / `rerun <id>` — recover a past run by id, pulling its workflow +
 * inputs from the shared history. Here we pin the resolution + error paths (no VM):
 * a missing id, a missing run-id argument, and a run whose workflow is gone. The
 * happy path (actually resuming/re-running) rides the same run path covered by the
 * startRun resume tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAbsurdEngine } from "../src/runtime/index.ts";
import { RunRepository } from "../src/persistence/runs.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "work.mjs");

function cli(ws: string, ...args: string[]) {
  return spawnSync(BIN, ["--workspace", ws, ...args], { encoding: "utf8" });
}

describe("work resume / rerun — recovery resolution", () => {
  it("errors clearly on a missing id, a missing arg, and a vanished workflow", async () => {
    const ws = await mkdtemp(join(tmpdir(), "pi-wf-recover-"));
    await mkdir(join(ws, ".workflows"), { recursive: true });
    try {
      // A run recorded against a workflow that no longer exists in this workspace.
      const engine = await createAbsurdEngine({ dataDir: join(ws, ".workflows", "db") });
      const repo = new RunRepository(engine);
      await repo.ensureSchema();
      await repo.insert({ id: "ghost-run", name: "vanished", status: "interrupted", trigger: "dispatch", startedAt: Date.now() });
      await engine.close();

      const noSuch = cli(ws, "resume", "does-not-exist");
      assert.equal(noSuch.status, 2);
      assert.match(noSuch.stderr, /no run "does-not-exist" found in history/);

      const noArg = cli(ws, "rerun");
      assert.equal(noArg.status, 2);
      assert.match(noArg.stderr, /rerun requires a run id/);

      // Resolves the id → workflow name from history, then fails to find the
      // workflow (a clean UserFacingError → exit 1, like `run vanished` would).
      const gone = cli(ws, "resume", "ghost-run");
      assert.equal(gone.status, 1);
      assert.match(gone.stderr, /no workflow named "vanished"/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
