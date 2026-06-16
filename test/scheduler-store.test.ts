/**
 * The scheduler against its REAL durable store (`ScheduleRepository` on an in-memory
 * PGLite engine — no QEMU). Proves the `work.schedules` round-trip and that `tick`
 * drives it: seed → fire a due slot → persist the advance.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAbsurdEngine, type AbsurdEngine } from "../src/runtime/index.ts";
import { ScheduleRepository } from "../src/persistence/schedules.ts";
import { tick, seedBaselines } from "../src/scheduler/index.ts";

const ms = (iso: string) => Date.parse(iso);
const HOURLY = "0 * * * *";

describe("ScheduleRepository + tick (real PGLite store)", () => {
  let engine: AbsurdEngine;
  let store: ScheduleRepository;

  before(async () => {
    engine = await createAbsurdEngine({}); // in-memory, no dataDir
    store = new ScheduleRepository(engine);
    await store.ensureSchema();
  });

  after(async () => {
    await engine.close();
  });

  it("round-trips lastFired / record through the durable table", async () => {
    assert.equal(await store.lastFired("deploy", HOURLY), null);
    await store.record("deploy", HOURLY, ms("2026-06-15T10:00:00Z"));
    assert.equal(await store.lastFired("deploy", HOURLY), ms("2026-06-15T10:00:00Z"));
    await store.record("deploy", HOURLY, ms("2026-06-15T11:00:00Z")); // upsert
    assert.equal(await store.lastFired("deploy", HOURLY), ms("2026-06-15T11:00:00Z"));
  });

  it("drives tick: seeds the baseline, then fires a due slot and persists the advance", async () => {
    const fires: string[] = [];
    let nowMs = ms("2026-06-15T12:30:00Z");
    const deps = {
      listScheduled: () => [{ workflow: "report", cron: HOURLY }],
      store,
      clock: { now: () => nowMs },
      dispatch: (f: { workflow: string; cron: string; runId: string; slot: number }) => {
        fires.push(f.runId);
      },
    };

    await seedBaselines(deps); // baseline = 12:30, no fire
    assert.equal(fires.length, 0);
    assert.equal(await store.lastFired("report", HOURLY), ms("2026-06-15T12:30:00Z"));

    nowMs = ms("2026-06-15T13:05:00Z"); // 13:00 slot has now elapsed
    await tick(deps);
    assert.deepEqual(fires, ["cron:report:2026-06-15T13:00:00.000Z"]);
    assert.equal(await store.lastFired("report", HOURLY), ms("2026-06-15T13:00:00Z"));
  });
});
