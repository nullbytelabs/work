/**
 * `POST /api/runs/:id/retry` — the web console's "Retry failed jobs" action: re-run
 * only a prior `failure` run's failed jobs, under the SAME run id, reusing the jobs
 * that passed (the GitHub-Actions tactic, mirrored from the CLI's `work retry`).
 *
 * Booted on a persistent `dataDir` (so the server has the run/event stores the
 * endpoint needs) with the host-process target double — no VM. A `mixed` workflow
 * pairs an always-passing `ok` job with a `bad` job that fails until a marker file
 * appears; each job appends a byte to a per-job counter, so "did it re-run?" is
 * observable from outside. Asserts: the failed run retries to success with `ok`
 * reused (counter unchanged) and `bad` re-run (counter incremented); a success run
 * has nothing to retry (409); an unknown id is 404.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTargetFactory } from "./_support.ts";
import { startWebServer, type WebServerHandle } from "../src/web/index.ts";

const ECHO = `name: echo
jobs:
  say:
    steps:
      - run: echo hello
`;

// `ok` always passes; `bad` appends a byte then succeeds only once the marker
// exists. The counter/marker dir is injected via an input.
const MIXED = `name: mixed
inputs:
  dir: { type: string, required: true }
jobs:
  ok:
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/ok"'
  bad:
    steps:
      - run: 'printf x >> "\${{ inputs.dir }}/bad"; test -f "\${{ inputs.dir }}/pass"'
`;

let workspace: string;
let dataDir: string;
let sideDir: string;
let server: WebServerHandle;
let base: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pi-wf-webretry-"));
  sideDir = await mkdtemp(join(tmpdir(), "pi-wf-webretry-fx-"));
  const wfDir = join(workspace, ".workflows");
  await mkdir(wfDir, { recursive: true });
  await writeFile(join(wfDir, "echo.yaml"), ECHO);
  await writeFile(join(wfDir, "mixed.yaml"), MIXED);
  dataDir = join(wfDir, "db");
  server = await startWebServer({ workspace, dataDir, port: 0, makeTarget: hostTargetFactory });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  if (server) await server.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  if (sideDir) await rm(sideDir, { recursive: true, force: true });
});

async function byteLen(path: string): Promise<number> {
  return (await readFile(path, "utf8").catch(() => "")).length;
}

/** Dispatch a run and resolve its terminal status once the SSE stream ends. */
async function runToEnd(name: string, inputs: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Work-Token": server.token },
    body: JSON.stringify({ name, inputs }),
  });
  assert.equal(r.status, 202);
  const { runId } = (await r.json()) as { runId: string };
  await awaitRunEnd(runId);
  return runId;
}

describe("web — POST /api/runs/:id/retry (re-run failed jobs)", () => {
  it("re-runs only the failed job under the same id, reusing the passing one", async () => {
    const runId = await runToEnd("mixed", { dir: sideDir });
    // Phase 1: bad fails (no marker), ok passes. Both ran once; the run failed.
    assert.equal(await statusOf(runId), "failure");
    assert.equal(await byteLen(join(sideDir, "ok")), 1, "ok ran once");
    assert.equal(await byteLen(join(sideDir, "bad")), 1, "bad ran once");

    // Clear the flaky cause, then retry just the failed job.
    await writeFile(join(sideDir, "pass"), "");
    const retry = await fetch(`${base}/api/runs/${runId}/retry`, {
      method: "POST",
      headers: { "X-Work-Token": server.token },
    });
    assert.equal(retry.status, 202);
    const body = (await retry.json()) as { runId: string; jobsReset: string[] };
    assert.equal(body.runId, runId, "retry re-runs under the SAME run id");
    assert.deepEqual(body.jobsReset, ["bad"], "only the failed job is cleared");

    await awaitRunEnd(runId);
    assert.equal(await statusOf(runId), "success", "the retried run succeeds");
    assert.equal(await byteLen(join(sideDir, "ok")), 1, "the passing job is NOT re-run on retry");
    assert.equal(await byteLen(join(sideDir, "bad")), 2, "the failed job re-runs on retry");
  });

  it("answers 409 when the run had no failed jobs", async () => {
    const runId = await runToEnd("echo", {});
    assert.equal(await statusOf(runId), "success");
    const retry = await fetch(`${base}/api/runs/${runId}/retry`, {
      method: "POST",
      headers: { "X-Work-Token": server.token },
    });
    assert.equal(retry.status, 409);
    await retry.text();
  });

  it("answers 404 for an unknown run id", async () => {
    const retry = await fetch(`${base}/api/runs/does-not-exist/retry`, {
      method: "POST",
      headers: { "X-Work-Token": server.token },
    });
    assert.equal(retry.status, 404);
    await retry.text();
  });
});

/** The run's status from history. */
async function statusOf(runId: string): Promise<string> {
  const hist = (await (await fetch(`${base}/api/runs`)).json()) as { id: string; status: string }[];
  return hist.find((h) => h.id === runId)?.status ?? "missing";
}

/** Drain the SSE stream until `run-end` (or timeout). */
async function awaitRunEnd(runId: string, timeoutMs = 20_000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(`${base}/api/runs/${runId}/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawEnd = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.split("\n").some((l) => l.startsWith("event:") && l.slice(6).trim() === "run-end")) {
          sawEnd = true;
          clearTimeout(timer);
          controller.abort();
          return;
        }
      }
    }
  } catch (err) {
    if (!sawEnd) throw err;
  } finally {
    clearTimeout(timer);
  }
}
