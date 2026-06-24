/**
 * `work runs` — the CLI history command. Lists the shared `.workflows/db` store
 * (both CLI and web write it), newest-first, with a `--status` filter so you can
 * pick out what needs resuming. Driven as a subprocess against a seeded store.
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

async function seed(ws: string): Promise<void> {
  const engine = await createAbsurdEngine({ dataDir: join(ws, ".workflows", "db") });
  const repo = new RunRepository(engine);
  await repo.ensureSchema();
  const now = Date.now();
  await repo.insert({ id: "run-success-0001", name: "ci", status: "success", trigger: "dispatch", startedAt: now - 9000 });
  await repo.insert({ id: "run-interrupt-02", name: "review", status: "interrupted", trigger: "dispatch", startedAt: now - 2000 });
  await engine.close();
}

function runs(ws: string, ...extra: string[]) {
  return spawnSync(BIN, ["--workspace", ws, "runs", ...extra], { encoding: "utf8" });
}

describe("work runs", () => {
  it("lists history newest-first, filters by status, and errors on a bad status", async () => {
    const ws = await mkdtemp(join(tmpdir(), "pi-wf-cliruns-"));
    await mkdir(join(ws, ".workflows"), { recursive: true });
    try {
      // Empty store → friendly note.
      assert.match(runs(ws).stdout, /no runs yet/);

      await seed(ws);

      // Full list: both runs, newest first (interrupted is newer), with a resume hint.
      const all = runs(ws);
      assert.equal(all.status, 0);
      assert.match(all.stdout, /review\s+interrupted/);
      assert.match(all.stdout, /ci\s+success/);
      assert.ok(all.stdout.indexOf("review") < all.stdout.indexOf("ci"), "newest (review) listed first");
      assert.match(all.stdout, /resume one with:.*--resume run-interrupt-02/);

      // Filtered: only the interrupted run.
      const filtered = runs(ws, "--status", "interrupted");
      assert.match(filtered.stdout, /review\s+interrupted/);
      assert.doesNotMatch(filtered.stdout, /success/);

      // Bad status → exit 2 with a clear message.
      const bad = runs(ws, "--status", "nope");
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /--status must be one of/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("--full widens the ID column to the complete run id, and is scoped to `runs`", async () => {
    const ws = await mkdtemp(join(tmpdir(), "pi-wf-cliruns-full-"));
    await mkdir(join(ws, ".workflows"), { recursive: true });
    try {
      await seed(ws);

      // Default: the ID column is truncated to the 8-char prefix.
      const short = runs(ws);
      assert.match(short.stdout, /run-succ\s+ci/);
      assert.doesNotMatch(short.stdout, /run-success-0001/);

      // --full: the complete id is printed (copy-pasteable into workflows).
      const full = runs(ws, "--full");
      assert.equal(full.status, 0);
      assert.match(full.stdout, /run-success-0001\s+ci/);
      assert.match(full.stdout, /run-interrupt-02\s+review/);
      assert.match(full.stdout, /resume one with:.*--resume run-interrupt-02/);

      // --full composes with --status.
      const filtered = runs(ws, "--full", "--status", "success");
      assert.match(filtered.stdout, /run-success-0001\s+ci/);
      assert.doesNotMatch(filtered.stdout, /review/);

      // Scoped to `runs`: rejected on other commands.
      const misplaced = spawnSync(BIN, ["--workspace", ws, "graph", "x.yaml", "--full"], { encoding: "utf8" });
      assert.equal(misplaced.status, 2);
      assert.match(misplaced.stderr, /--full only applies to `runs`/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
