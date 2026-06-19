/**
 * #2 — `--web` boot reconciliation. A server killed mid-run leaves its `work.runs`
 * row stuck at `running` (a zombie) and nothing re-drives it. The intended
 * behavior: a fresh server booted on the same dataDir reconciles such rows —
 * re-dispatching each interrupted run (same runId, so the durable journal resumes
 * it) and driving it to a terminal status instead of leaving it `running` forever.
 *
 * Modeled deterministically: we seed a `running` row directly (as a prior crashed
 * server would have left it), then boot a server and assert reconciliation drives
 * it to `success`. Uses the host-process target double (no VM).
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTargetFactory } from "./_support.ts";
import { startWebServer } from "../src/web/index.ts";
import { createAbsurdEngine } from "../src/runtime/index.ts";
import { RunRepository } from "../src/persistence/runs.ts";

const ECHO = `name: echo
jobs:
  say:
    runs-on: gondolin
    steps:
      - name: greet
        run: echo hello
`;

let workspace: string;
let dataDir: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pi-wf-webresume-"));
  await mkdir(join(workspace, ".workflows"), { recursive: true });
  await writeFile(join(workspace, ".workflows", "echo.yaml"), ECHO);
  dataDir = join(workspace, ".workflows", "db");
});
after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("web boot reconciliation", () => {
  it("resumes a run left 'running' by a crashed server", async () => {
    // Seed a zombie `running` row, as a server killed mid-run would have left it.
    const seed = await createAbsurdEngine({ dataDir });
    try {
      const runs = new RunRepository(seed);
      await runs.ensureSchema();
      await runs.insert({ id: "zombie-1", name: "echo", status: "running", trigger: "dispatch", startedAt: Date.now() });
    } finally {
      await seed.close(); // release the dataDir so the server can open it
    }

    // Boot a fresh server on the same dataDir. Reconciliation should pick up the
    // zombie and re-dispatch it; close() drains the in-flight run to completion.
    const server = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
    await server.close();

    // The interrupted run must now be terminal, not stuck 'running'.
    const check = await createAbsurdEngine({ dataDir });
    try {
      const runs = new RunRepository(check);
      await runs.ensureSchema();
      const row = await runs.get("zombie-1");
      assert.ok(row, "the seeded run should still exist");
      assert.equal(row!.status, "success", "the interrupted run should be resumed to a terminal status on boot");
    } finally {
      await check.close();
    }
  });

  it("marks an interrupted run failed when its workflow can no longer be resolved", async () => {
    const seed = await createAbsurdEngine({ dataDir });
    try {
      const runs = new RunRepository(seed);
      await runs.ensureSchema();
      // A run recorded against a workflow that isn't in this workspace anymore.
      await runs.insert({ id: "zombie-gone", name: "deleted-workflow", status: "running", trigger: "dispatch", startedAt: Date.now() });
    } finally {
      await seed.close();
    }

    const server = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
    await server.close();

    const check = await createAbsurdEngine({ dataDir });
    try {
      const runs = new RunRepository(check);
      await runs.ensureSchema();
      const row = await runs.get("zombie-gone");
      assert.equal(row!.status, "failure", "an unresolvable interrupted run must be marked failed, not left running");
    } finally {
      await check.close();
    }
  });

  // Regression: boot reconciliation must see EVERY non-terminal run, not just the
  // newest 200 — a long job started many runs ago would otherwise be a stranded
  // zombie. listNonTerminal() ignores the list() page cap.
  it("listNonTerminal returns all non-terminal runs regardless of the 200-row page cap", async () => {
    const engine = await createAbsurdEngine({ dataDir });
    try {
      const runs = new RunRepository(engine);
      await runs.ensureSchema();
      // An old running zombie, then 250 terminal rows newer than it.
      await runs.insert({ id: "old-zombie", name: "echo", status: "running", trigger: "dispatch", startedAt: 1 });
      for (let i = 0; i < 250; i++) {
        await runs.insert({ id: `done-${i}`, name: "echo", status: "success", trigger: "dispatch", startedAt: 100 + i });
      }
      const nonTerminal = await runs.listNonTerminal();
      assert.ok(nonTerminal.some((r) => r.id === "old-zombie"), "the >200-old zombie must still be seen");
      assert.ok(nonTerminal.every((r) => r.status !== "success"), "only non-terminal rows are returned");
      // list()'s default page would have hidden it behind the 250 newer terminal rows.
      const page = await runs.list();
      assert.ok(!page.some((r) => r.id === "old-zombie"), "the default list() page does NOT include it (why listNonTerminal exists)");
    } finally {
      await engine.close();
    }
  });

  // Regression: a webhook run's trigger `event` payload must be persisted alongside
  // its inputs, so a resume/rerun recompiles with the same `${{ event.* }}` instead
  // of dropping event-gated jobs / interpolating empty.
  it("persists and restores the trigger event payload", async () => {
    const engine = await createAbsurdEngine({ dataDir });
    try {
      const runs = new RunRepository(engine);
      await runs.ensureSchema();
      const event = { action: "opened", number: 42, pull_request: { title: "Fix" } };
      await runs.insert({ id: "evt-1", name: "echo", status: "running", trigger: "webhook", startedAt: Date.now(), inputs: { a: "1" }, event });
      const row = await runs.get("evt-1");
      assert.deepEqual(row!.event, event, "the trigger event must round-trip through the store");
      assert.deepEqual(row!.inputs, { a: "1" });
      // A run with no event leaves the column null/absent.
      await runs.insert({ id: "evt-none", name: "echo", status: "running", trigger: "dispatch", startedAt: Date.now() });
      const none = await runs.get("evt-none");
      assert.equal(none!.event, undefined, "a non-webhook run has no event");
    } finally {
      await engine.close();
    }
  });
});
