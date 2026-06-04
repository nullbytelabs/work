/**
 * Durable web history end-to-end: a run dispatched through the HTTP API on a
 * server with a `dataDir` is recorded durably, so a *fresh* server booted on the
 * same dataDir still lists it (web-ui-research.md §8, Phase 1). The server boots
 * its own persistent PGLite engine here; runs still use the host-process target
 * double, so no VM is needed.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTargetFactory } from "./_support.ts";
import { startWebServer, type WebServerHandle } from "../src/web/index.ts";

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
  workspace = await mkdtemp(join(tmpdir(), "pi-wf-persist-"));
  await mkdir(join(workspace, ".workflows"), { recursive: true });
  await writeFile(join(workspace, ".workflows", "echo.yaml"), ECHO);
  dataDir = join(workspace, ".workflows", "db");
});
after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/** Read an SSE stream until run-end (or timeout). */
async function awaitRunEnd(base: string, runId: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/runs/${runId}/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("event: run-end")) {
        controller.abort();
        return;
      }
    }
  } catch {
    /* aborted after run-end, or timed out — the assertion below covers correctness */
  } finally {
    clearTimeout(timer);
  }
}

describe("durable web history", () => {
  it("a run dispatched on one server is still listed by a fresh server on the same dataDir", async () => {
    // First server: dispatch a run and let it finish.
    let s1: WebServerHandle | undefined;
    let runId: string;
    try {
      s1 = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
      const base = `http://127.0.0.1:${s1.port}`;
      const r = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Work-Token": s1.token },
        body: JSON.stringify({ name: "echo", inputs: {} }),
      });
      assert.equal(r.status, 202);
      runId = ((await r.json()) as { runId: string }).runId;
      await awaitRunEnd(base, runId, 20_000);

      const hist = (await (await fetch(`${base}/api/runs`)).json()) as { id: string; status: string }[];
      assert.equal(hist.find((h) => h.id === runId)?.status, "success");
    } finally {
      if (s1) await s1.close(); // releases the dataDir so a fresh engine can open it
    }

    // Fresh server, same dataDir — the earlier run must still be there.
    const s2 = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
    try {
      const hist = (await (await fetch(`http://127.0.0.1:${s2.port}/api/runs`)).json()) as { id: string; name: string; status: string }[];
      const rec = hist.find((h) => h.id === runId);
      assert.ok(rec, "the run from the previous server should survive the restart");
      assert.equal(rec!.status, "success");
      assert.equal(rec!.name, "echo");
    } finally {
      await s2.close();
    }
  });
});
