/**
 * A persistent run records the SAME durable record regardless of front-end: not just
 * the `work.runs` history row, but the per-run SSE event stream (`work.run_events`) the
 * web detail view replays. Before this, only web-dispatched runs persisted frames, so a
 * completed CLI run showed a perpetual "Running" page in web. Here we drive a CLI-style
 * `startRun` (owned persistent engine, no web RunManager) and confirm its event stream
 * lands in the shared db, replayable by anyone.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- frame `data` is the loose SSE payload. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { startRun } from "../src/run.ts";
import { createAbsurdEngine } from "../src/runtime/index.ts";
import { RunEventRepository } from "../src/persistence/run-events.ts";
import { hostTargetFactory } from "./_support.ts";

const WORKFLOW = `
name: ev
jobs:
  build:
    steps:
      - name: hello
        run: echo hi
`;

describe("CLI run event persistence", () => {
  it("a persistent run records its full event stream to work.run_events", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ev-db-"));
    const workdir = await mkdtemp(join(tmpdir(), "ev-wr-"));
    const runId = "ev-run-1";
    const plan = compile(parseWorkflow(WORKFLOW));
    try {
      const res = await startRun({ plan, runId, dataDir, workdir, makeTarget: hostTargetFactory });
      assert.equal(res.status, "success");

      // Reopen the same db (startRun closed its engine) and read the persisted frames —
      // exactly what the web server's `replayHistorical` reads.
      const engine = await createAbsurdEngine({ dataDir });
      try {
        const events = new RunEventRepository(engine);
        await events.ensureSchema();
        assert.ok(await events.has(runId), "the run has a persisted event stream");
        const frames = await events.list(runId);
        const names = frames.map((f) => f.event);
        assert.ok(names.includes("run-init"), "run-init (the DAG) persisted");
        assert.ok(names.includes("step-end"), "step frames persisted");
        assert.ok(names.includes("run-end"), "run-end (terminal status) persisted");
        const end = frames.find((f) => f.event === "run-end");
        assert.equal((end?.data as any)?.status, "success", "run-end carries the terminal status");
      } finally {
        await engine.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
