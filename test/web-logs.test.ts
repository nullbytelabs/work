/**
 * Durable per-run *log* replay + re-run, end-to-end over HTTP (web-ui-research.md
 * §8, Phase 2 + Phase 3). A run dispatched on a server with a `dataDir` has its
 * full SSE frame stream persisted, so a *fresh* server booted on the same dataDir
 * can replay that finished run's `run-init` + step-output + `run-end` even though
 * the run is no longer live in memory. And `POST /api/runs/:id/rerun`
 * re-dispatches a past run with its stored inputs. Runs use the host-process
 * target double, so no VM is needed.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTargetFactory } from "./_support.ts";
import { startWebServer } from "../src/web/index.ts";

// Prints a known marker line so the replayed step-output can be asserted on.
const ECHO = `name: echo
jobs:
  say:
    runs-on: gondolin
    steps:
      - name: greet
        run: echo HELLO-LOG
`;

let workspace: string;
let dataDir: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pi-wf-logs-"));
  await mkdir(join(workspace, ".workflows"), { recursive: true });
  await writeFile(join(workspace, ".workflows", "echo.yaml"), ECHO);
  dataDir = join(workspace, ".workflows", "db");
});
after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/** Collect SSE frames from a stream until run-end (or timeout), as parsed events. */
async function collectUntilRunEnd(
  base: string,
  runId: string,
  timeoutMs: number,
): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  try {
    const res = await fetch(`${base}/api/runs/${runId}/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line; parse each complete block.
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data) {
          frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          if (event === "run-end") { controller.abort(); return frames; }
        }
      }
    }
  } catch {
    /* aborted after run-end or timed out — assertions cover correctness */
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

async function dispatch(base: string, token: string, name: string): Promise<string> {
  const r = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Work-Token": token },
    body: JSON.stringify({ name, inputs: {} }),
  });
  assert.equal(r.status, 202);
  return ((await r.json()) as { runId: string }).runId;
}

describe("durable run-log replay + re-run", () => {
  it("a finished run's full SSE log replays from a fresh server on the same dataDir", async () => {
    // First server: dispatch, run to completion (this persists every frame).
    let runId: string;
    const s1 = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
    try {
      const base = `http://127.0.0.1:${s1.port}`;
      runId = await dispatch(base, s1.token, "echo");
      const live = await collectUntilRunEnd(base, runId, 20_000);
      assert.equal(live.find((f) => f.event === "run-end")?.data["status"], "success");
    } finally {
      await s1.close(); // release the dataDir for a fresh engine
    }

    // Fresh server, same dataDir — the run is no longer live in memory, so the
    // events endpoint must replay it from the durable event store.
    const s2 = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
    try {
      const base = `http://127.0.0.1:${s2.port}`;
      const frames = await collectUntilRunEnd(base, runId, 20_000);

      assert.ok(frames.some((f) => f.event === "run-init"), "replay includes run-init");
      const output = frames.filter((f) => f.event === "step-output");
      assert.ok(
        output.some((f) => String(f.data["text"]).includes("HELLO-LOG")),
        "replay includes the step-output line containing HELLO-LOG",
      );
      const end = frames.find((f) => f.event === "run-end");
      assert.ok(end, "replay includes run-end");
      assert.equal(end!.data["status"], "success");
    } finally {
      await s2.close();
    }
  });

  it("POST /api/runs/:id/rerun re-dispatches a past run and the new run completes + appears in history", async () => {
    let firstId: string;
    const s1 = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
    try {
      const base = `http://127.0.0.1:${s1.port}`;
      firstId = await dispatch(base, s1.token, "echo");
      await collectUntilRunEnd(base, firstId, 20_000);
    } finally {
      await s1.close();
    }

    // Fresh server: re-run the past run (resolved from durable history), then
    // verify the *new* run finishes and is itself listed in history.
    const s2 = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
    try {
      const base = `http://127.0.0.1:${s2.port}`;
      const r = await fetch(`${base}/api/runs/${firstId}/rerun`, {
        method: "POST",
        headers: { "X-Work-Token": s2.token },
      });
      assert.equal(r.status, 202);
      const newId = ((await r.json()) as { runId: string }).runId;
      assert.notEqual(newId, firstId);

      const frames = await collectUntilRunEnd(base, newId, 20_000);
      assert.equal(frames.find((f) => f.event === "run-end")?.data["status"], "success");

      const hist = (await (await fetch(`${base}/api/runs`)).json()) as { id: string; name: string; status: string }[];
      const rec = hist.find((h) => h.id === newId);
      assert.ok(rec, "the re-run should appear in history");
      assert.equal(rec!.name, "echo");
      assert.equal(rec!.status, "success");
    } finally {
      await s2.close();
    }
  });

  it("an unknown run id over the events endpoint is a clean JSON 404", async () => {
    const s = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/runs/does-not-exist/events`);
      // No live run and no persisted frames → the response is untouched, so the
      // server still answers with a JSON 404 (legacy behavior preserved).
      assert.equal(res.status, 404);
      await res.text();
    } finally {
      await s.close();
    }
  });
});
