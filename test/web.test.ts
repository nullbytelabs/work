/**
 * Web UI (`work --web`) tests. We boot the server on an ephemeral port with an
 * injected shared engine + the `hostTargetFactory` double (from `_support.ts`),
 * so dispatched runs execute as host child processes — no gondolin VM needed.
 * Everything else is real: HTTP routes, the SSE stream, the CSRF/Host guards.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbsurdEngine, type AbsurdEngine } from "../src/runtime/index.ts";
import { hostTargetFactory } from "./_support.ts";
import { listWorkflows } from "../src/project.ts";
import { startWebServer, type WebServerHandle } from "../src/web/index.ts";

// A workspace with a `.workflows/` holding two trivial echo workflows: one with
// no inputs, one with typed inputs (string + number, both with defaults so a
// bare dispatch compiles).
const ECHO = `name: echo
jobs:
  say:
    runs-on: gondolin
    steps:
      - name: greet
        run: echo hello-from-echo
`;

const GREET = `name: greet
inputs:
  who:
    type: string
    default: world
    description: who to greet
  times:
    type: number
    default: 1
jobs:
  hello:
    runs-on: gondolin
    steps:
      - name: hi
        env:
          WHO: \${{ inputs.who }}
        run: echo "hi $WHO"
`;

let workspace: string;
let engine: AbsurdEngine;
let server: WebServerHandle;
let base: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pi-wf-web-"));
  const wfDir = join(workspace, ".workflows");
  await mkdir(wfDir, { recursive: true });
  await writeFile(join(wfDir, "echo.yaml"), ECHO);
  await writeFile(join(wfDir, "greet.yaml"), GREET);

  engine = await createAbsurdEngine();
  server = await startWebServer({ workspace, port: 0, engine, makeTarget: hostTargetFactory });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  if (server) await server.close();
  if (engine) await engine.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("listWorkflows", () => {
  it("returns the declared workflows sorted by name", async () => {
    const wfs = await listWorkflows(workspace);
    assert.deepEqual(wfs.map((w) => w.name), ["echo", "greet"]);
    assert.ok(wfs[0]!.file.endsWith("echo.yaml"));
    assert.ok(wfs[1]!.file.endsWith("greet.yaml"));
  });
});

describe("web server", () => {
  it("GET /api/workflows returns name+file pairs", async () => {
    const r = await fetch(`${base}/api/workflows`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { name: string; file: string }[];
    assert.deepEqual(body.map((w) => w.name), ["echo", "greet"]);
    for (const w of body) assert.equal(typeof w.file, "string");
  });

  it("GET /api/workflows/:name/form returns the InputSpec map", async () => {
    const r = await fetch(`${base}/api/workflows/greet/form`);
    assert.equal(r.status, 200);
    const form = (await r.json()) as Record<string, { type?: string; default?: unknown }>;
    assert.equal(form["who"]!.type, "string");
    assert.equal(form["who"]!.default, "world");
    assert.equal(form["times"]!.type, "number");
  });

  it("GET /api/workflows/:name/form is {} for a workflow with no inputs", async () => {
    const r = await fetch(`${base}/api/workflows/echo/form`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});
  });

  it("GET / serves the HTML shell with an embedded token", async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /work-token/);
    assert.match(html, new RegExp(server.token));
  });

  it("POST /api/runs without the token is 403", async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "echo", inputs: {} }),
    });
    assert.equal(r.status, 403);
  });

  it("POST /api/runs with a bad compile is 400 with the message inline", async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Work-Token": server.token },
      body: JSON.stringify({ name: "greet", inputs: { times: "not-a-number" } }),
    });
    assert.equal(r.status, 400);
    const body = (await r.json()) as { error: string };
    assert.match(body.error, /number/);
  });

  it("POST /api/runs with an oversized body is rejected (413), never dispatched", async () => {
    const big = "x".repeat(300 * 1024); // exceeds the 256 KiB cap
    let status = 0;
    try {
      const r = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Work-Token": server.token },
        body: JSON.stringify({ name: "echo", inputs: { blob: big } }),
      });
      status = r.status;
    } catch {
      status = -1; // the cap aborted the connection mid-stream — also acceptable
    }
    assert.ok(status === 413 || status === -1, `expected 413 or abort, got ${status}`);
  });

  it("rejects a forged Host header with 403", async () => {
    // Node's `fetch` (undici) forces the Host header to match the connection, so
    // we issue a raw `http.request` to forge it.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path: "/api/workflows", method: "GET", headers: { Host: "evil.example.com" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it("POST /api/runs with the token dispatches and the SSE stream yields run-init then run-end", async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Work-Token": server.token },
      body: JSON.stringify({ name: "echo", inputs: {} }),
    });
    assert.equal(r.status, 202);
    const { runId } = (await r.json()) as { runId: string };
    assert.equal(typeof runId, "string");

    // Read the SSE stream until we see run-end (or time out).
    const events = await collectSse(`${base}/api/runs/${runId}/events`, 20_000);
    const names = events.map((e) => e.event);
    assert.ok(names.includes("run-init"), `expected run-init, got ${names.join(",")}`);
    assert.ok(names.includes("run-end"), `expected run-end, got ${names.join(",")}`);

    const init = events.find((e) => e.event === "run-init")!;
    const initData = JSON.parse(init.data) as { jobOrder: string[]; jobs: Record<string, unknown> };
    assert.deepEqual(initData.jobOrder, ["say"]);

    const end = events.find((e) => e.event === "run-end")!;
    assert.equal((JSON.parse(end.data) as { status: string }).status, "success");

    // The run now shows up in history.
    const hist = (await (await fetch(`${base}/api/runs`)).json()) as { id: string; status: string }[];
    const rec = hist.find((h) => h.id === runId);
    assert.ok(rec, "run should appear in history");
    assert.equal(rec!.status, "success");
  });

  it("GET /api/runs/:id/events for an unknown run is 404", async () => {
    const r = await fetch(`${base}/api/runs/does-not-exist/events`);
    assert.equal(r.status, 404);
    // Drain the body so the socket can close.
    await r.text();
  });
});

/** Parsed SSE frame. */
interface SseEvent {
  event: string;
  data: string;
}

/**
 * Open an SSE stream, accumulate frames, and resolve once a `run-end` arrives
 * (or the timeout fires). Returns the frames seen so far.
 */
async function collectSse(url: string, timeoutMs: number): Promise<SseEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, { signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.startsWith(":")) continue; // heartbeat comment
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        events.push({ event, data });
        if (event === "run-end") {
          clearTimeout(timer);
          controller.abort();
          return events;
        }
      }
    }
  } catch (err) {
    // An abort after we got run-end is expected; otherwise rethrow.
    if (!events.some((e) => e.event === "run-end")) throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}
