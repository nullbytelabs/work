import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dueSlot, nextFire, tick, slotRunId, scheduleKey } from "../src/scheduler/index.ts";
import type { ScheduleStore, ScheduledItem } from "../src/scheduler/index.ts";

const ms = (iso: string) => Date.parse(iso);
const HOURLY = "0 * * * *"; // top of every hour
const DAILY_9 = "0 9 * * *"; // 09:00 daily

describe("dueSlot — latest elapsed cron slot in (since, now]", () => {
  it("returns null when no slot has elapsed since `since`", () => {
    // last fire 10:00, now 10:30 — next slot (11:00) hasn't arrived
    assert.equal(dueSlot(HOURLY, ms("2026-06-15T10:00:00Z"), ms("2026-06-15T10:30:00Z")), null);
  });

  it("returns the slot once one has elapsed", () => {
    const slot = dueSlot(HOURLY, ms("2026-06-15T10:00:00Z"), ms("2026-06-15T11:05:00Z"));
    assert.equal(new Date(slot!).toISOString(), "2026-06-15T11:00:00.000Z");
  });

  it("skips by default — returns only the LATEST slot when several elapsed", () => {
    // down from 10:00 to 13:05: slots 11:00, 12:00, 13:00 elapsed → fire only 13:00
    const slot = dueSlot(HOURLY, ms("2026-06-15T10:00:00Z"), ms("2026-06-15T13:05:00Z"));
    assert.equal(new Date(slot!).toISOString(), "2026-06-15T13:00:00.000Z");
  });

  it("evaluates in UTC regardless of host timezone (GHA parity)", () => {
    const slot = dueSlot(DAILY_9, ms("2026-06-15T00:00:00Z"), ms("2026-06-15T10:00:00Z"));
    assert.equal(new Date(slot!).toISOString(), "2026-06-15T09:00:00.000Z");
  });

  it("is exclusive of `since` — a slot equal to `since` is not re-returned", () => {
    // since == 11:00 exactly (already fired); now 11:30 — nothing new due
    assert.equal(dueSlot(HOURLY, ms("2026-06-15T11:00:00Z"), ms("2026-06-15T11:30:00Z")), null);
  });

  it("returns a stable slot across different `now` values in the same window", () => {
    const a = dueSlot(HOURLY, ms("2026-06-15T10:00:00Z"), ms("2026-06-15T11:05:00Z"));
    const b = dueSlot(HOURLY, ms("2026-06-15T10:00:00Z"), ms("2026-06-15T11:55:00Z"));
    assert.equal(a, b); // same canonical slot → same idempotency key
  });
});

describe("nextFire — next scheduled instant after a reference", () => {
  it("computes the next slot strictly after `after`", () => {
    const next = nextFire(HOURLY, ms("2026-06-15T10:30:00Z"));
    assert.equal(new Date(next!).toISOString(), "2026-06-15T11:00:00.000Z");
  });
});

describe("slotRunId / scheduleKey", () => {
  it("derives a stable, slot-canonical run id", () => {
    assert.equal(slotRunId("deploy", ms("2026-06-15T11:00:00Z")), "cron:deploy:2026-06-15T11:00:00.000Z");
  });
  it("keys (workflow, cron) distinctly", () => {
    assert.notEqual(scheduleKey("a", HOURLY), scheduleKey("b", HOURLY));
    assert.notEqual(scheduleKey("a", HOURLY), scheduleKey("a", DAILY_9));
  });
});

// A trivial in-memory store + fake clock to drive tick() deterministically.
class MemStore implements ScheduleStore {
  private readonly m = new Map<string, number>();
  async lastFired(key: string): Promise<number | null> {
    return this.m.has(key) ? this.m.get(key)! : null;
  }
  async record(key: string, slot: number): Promise<void> {
    this.m.set(key, slot);
  }
  peek(key: string): number | null {
    return this.m.has(key) ? this.m.get(key)! : null;
  }
}

function harness(items: ScheduledItem[]) {
  const store = new MemStore();
  const fires: Array<{ workflow: string; cron: string; runId: string; slot: number }> = [];
  let nowMs = 0;
  const deps = {
    listScheduled: () => items,
    store,
    dispatch: (f: { workflow: string; cron: string; runId: string; slot: number }) => {
      fires.push(f);
    },
    clock: { now: () => nowMs },
  };
  return { store, fires, deps, setNow: (iso: string) => (nowMs = ms(iso)) };
}

describe("tick — evaluate + dispatch due schedules", () => {
  it("seeds a never-seen schedule to now and does not fire retroactively", async () => {
    const h = harness([{ workflow: "deploy", cron: HOURLY }]);
    h.setNow("2026-06-15T10:30:00Z");
    await tick(h.deps);
    assert.equal(h.fires.length, 0);
    assert.equal(h.store.peek(scheduleKey("deploy", HOURLY)), ms("2026-06-15T10:30:00Z"));
  });

  it("fires once a slot elapses after the baseline, with a slot-derived runId", async () => {
    const h = harness([{ workflow: "deploy", cron: HOURLY }]);
    await h.store.record(scheduleKey("deploy", HOURLY), ms("2026-06-15T10:00:00Z"));
    h.setNow("2026-06-15T11:05:00Z");
    await tick(h.deps);
    assert.equal(h.fires.length, 1);
    assert.deepEqual(h.fires[0], {
      workflow: "deploy",
      cron: HOURLY,
      runId: "cron:deploy:2026-06-15T11:00:00.000Z",
      slot: ms("2026-06-15T11:00:00Z"),
    });
    assert.equal(h.store.peek(scheduleKey("deploy", HOURLY)), ms("2026-06-15T11:00:00Z"));
  });

  it("does not re-fire the same slot on a later tick in the same window", async () => {
    const h = harness([{ workflow: "deploy", cron: HOURLY }]);
    await h.store.record(scheduleKey("deploy", HOURLY), ms("2026-06-15T10:00:00Z"));
    h.setNow("2026-06-15T11:05:00Z");
    await tick(h.deps);
    h.setNow("2026-06-15T11:45:00Z");
    await tick(h.deps);
    assert.equal(h.fires.length, 1); // still just the 11:00 fire
  });

  it("skips by default after a gap — one fire for the latest slot, baseline jumps forward", async () => {
    const h = harness([{ workflow: "deploy", cron: HOURLY }]);
    await h.store.record(scheduleKey("deploy", HOURLY), ms("2026-06-15T10:00:00Z"));
    h.setNow("2026-06-15T13:05:00Z");
    await tick(h.deps);
    assert.equal(h.fires.length, 1);
    assert.equal(h.fires[0]!.slot, ms("2026-06-15T13:00:00Z"));
    assert.equal(h.store.peek(scheduleKey("deploy", HOURLY)), ms("2026-06-15T13:00:00Z"));
  });

  it("evaluates multiple schedules independently in one tick", async () => {
    const h = harness([
      { workflow: "deploy", cron: HOURLY },
      { workflow: "report", cron: DAILY_9 },
    ]);
    await h.store.record(scheduleKey("deploy", HOURLY), ms("2026-06-15T10:00:00Z"));
    await h.store.record(scheduleKey("report", DAILY_9), ms("2026-06-15T00:00:00Z"));
    h.setNow("2026-06-15T11:05:00Z");
    await tick(h.deps);
    const wfs = h.fires.map((f) => f.workflow).sort();
    assert.deepEqual(wfs, ["deploy", "report"]); // hourly 11:00 + daily 09:00 both due
  });
});
