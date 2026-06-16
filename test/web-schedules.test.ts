/**
 * `GET /api/schedules` — the status surface for `on: schedule` triggers, read
 * through the running host (never a separate DB-opener). Two paths:
 *   - injected engine (no `dataDir`): the scheduler isn't active, so `active` is
 *     false and `lastFired` is null, but declared schedules still list with a
 *     computed `nextFire`;
 *   - own persistent engine (`dataDir`): the scheduler boots and seeds a baseline,
 *     so `active` is true and each schedule reports a `lastFired` baseline.
 * Runs use the host-process target double, so no VM is needed.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbsurdEngine, type AbsurdEngine } from "../src/runtime/index.ts";
import { hostTargetFactory } from "./_support.ts";
import { startWebServer, type WebServerHandle } from "../src/web/index.ts";

// One scheduled workflow (every 5 minutes) and one plain workflow with no
// trigger — only the scheduled one should appear in /api/schedules.
const SCHEDULED = `name: nightly
on:
  schedule:
    - cron: '*/5 * * * *'
jobs:
  tick:
    runs-on: gondolin
    steps:
      - name: noop
        run: echo tick
`;

const PLAIN = `name: plain
jobs:
  say:
    runs-on: gondolin
    steps:
      - name: hi
        run: echo hi
`;

interface ScheduleRow {
  workflow: string;
  cron: string;
  lastFired: number | null;
  nextFire: number | null;
}
interface SchedulesResponse {
  active: boolean;
  schedules: ScheduleRow[];
}

let workspace: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pi-wf-sched-"));
  const wfDir = join(workspace, ".workflows");
  await mkdir(wfDir, { recursive: true });
  await writeFile(join(wfDir, "nightly.yaml"), SCHEDULED);
  await writeFile(join(wfDir, "plain.yaml"), PLAIN);
});
after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("GET /api/schedules", () => {
  it("lists declared schedules but reports inactive without a dataDir", async () => {
    const engine: AbsurdEngine = await createAbsurdEngine();
    let server: WebServerHandle | undefined;
    try {
      server = await startWebServer({ workspace, port: 0, engine, makeTarget: hostTargetFactory });
      const r = await fetch(`http://127.0.0.1:${server.port}/api/schedules`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as SchedulesResponse;
      assert.equal(body.active, false);
      assert.equal(body.schedules.length, 1);
      const row = body.schedules[0]!;
      assert.equal(row.workflow, "nightly");
      assert.equal(row.cron, "*/5 * * * *");
      assert.equal(row.lastFired, null); // no store ⇒ no baseline
      assert.equal(typeof row.nextFire, "number"); // still computable from the cron
      assert.ok(row.nextFire! > Date.now());
    } finally {
      if (server) await server.close();
      await engine.close();
    }
  });

  it("reports active with a seeded baseline when the host owns a dataDir", async () => {
    const dataDir = join(workspace, ".workflows", "db");
    let server: WebServerHandle | undefined;
    try {
      server = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
      const r = await fetch(`http://127.0.0.1:${server.port}/api/schedules`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as SchedulesResponse;
      assert.equal(body.active, true);
      assert.equal(body.schedules.length, 1);
      const row = body.schedules[0]!;
      assert.equal(row.workflow, "nightly");
      assert.equal(typeof row.lastFired, "number"); // seeded at boot
      assert.ok(row.nextFire! > row.lastFired!); // next slot is strictly after the baseline
    } finally {
      if (server) await server.close();
    }
  });
});
