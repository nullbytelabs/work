/**
 * Webhook receiver (`POST /hooks/:name`) tests — the authenticated, async trigger
 * (webhook-triggers-research.md §4/§7). We boot the same web server on an
 * ephemeral port with the `hostTargetFactory` double, so a triggered run executes
 * as host child processes — no gondolin VM. Everything else is real: bearer auth
 * (constant-time), the fail-closed gate, the opt-in check, ack-fast async
 * dispatch, and the `event` context both **baked at compile** (a `run:` echoes a
 * payload field) and **evaluated at runtime** (an `if:` gates a job on the alert
 * severity).
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbsurdEngine, type AbsurdEngine } from "../src/runtime/index.ts";
import type { WorkConfig } from "../src/config/index.ts";
import { collectSse, hostTargetFactory } from "./_support.ts";
import { startWebServer, type WebServerHandle } from "../src/web/index.ts";

// `incident` opts into webhook triggering. `triage` echoes a payload field
// (proves `${{ event.* }}` is baked at compile); `page` is gated on the alert
// severity (proves `${{ event.* }}` works in a runtime-evaluated `if:`).
const INCIDENT = `name: incident
on: webhook
jobs:
  triage:
    runs-on: gondolin
    steps:
      - name: echo-sev
        run: echo "severity=\${{ event.commonLabels.severity }}"
  page:
    runs-on: gondolin
    if: \${{ event.commonLabels.severity == 'critical' }}
    steps:
      - name: page
        run: echo "PAGING ONCALL"
`;

// `plain` does NOT declare `on: webhook`; a hook pointing at it must still 404
// (the opt-in gate is defense-in-depth over the config entry).
const PLAIN = `name: plain
jobs:
  noop:
    runs-on: gondolin
    steps:
      - name: noop
        run: echo noop
`;

// `broken` is valid YAML (so it resolves by name) but fails full parse (no jobs),
// so a hook pointing at it exercises loadOptedInSpec's parse-error path — which must
// only be reachable AFTER authentication (never disclosed to an unauthenticated caller).
const BROKEN = `name: broken
on: webhook
jobs: {}
`;

const SECRET = "s3cr3t-bearer-token";

const config: WorkConfig = {
  providers: {},
  models: {},
  webhooks: {
    "deploy-incident": { workflow: "incident", auth: "bearer", secret: "$WEBHOOK_TEST_SECRET" },
    "plain-hook": { workflow: "plain", auth: "bearer", secret: "$WEBHOOK_TEST_SECRET" },
    "disabled-hook": { workflow: "incident", enabled: false, auth: "bearer", secret: "$WEBHOOK_TEST_SECRET" },
    "secretless-hook": { workflow: "incident", auth: "bearer" },
    // GitHub-style HMAC (sha256= prefix) and Grafana-style (bare hex).
    "signed-hook": { workflow: "incident", auth: "hmac-sha256", secret: "$WEBHOOK_TEST_SECRET", signatureHeader: "X-Hub-Signature-256" },
    "grafana-hook": { workflow: "incident", auth: "hmac-sha256", secret: "$WEBHOOK_TEST_SECRET", signatureHeader: "X-Grafana-Alerting-Signature" },
    "broken-hook": { workflow: "broken", auth: "bearer", secret: "$WEBHOOK_TEST_SECRET" },
  },
};

let workspace: string;
let engine: AbsurdEngine;
let server: WebServerHandle;
let base: string;

before(async () => {
  process.env["WEBHOOK_TEST_SECRET"] = SECRET;
  workspace = await mkdtemp(join(tmpdir(), "pi-wf-hook-"));
  const wfDir = join(workspace, ".workflows");
  await mkdir(wfDir, { recursive: true });
  await writeFile(join(wfDir, "incident.yaml"), INCIDENT);
  await writeFile(join(wfDir, "plain.yaml"), PLAIN);
  await writeFile(join(wfDir, "broken.yaml"), BROKEN);

  engine = await createAbsurdEngine();
  server = await startWebServer({ workspace, port: 0, engine, config, makeTarget: hostTargetFactory });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  if (server) await server.close();
  if (engine) await engine.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  delete process.env["WEBHOOK_TEST_SECRET"];
});

/** POST a JSON body to a hook with an optional Bearer credential. */
function postHook(name: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${base}/hooks/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("webhook receiver — auth & fail-closed", () => {
  it("unknown hook → 404 (non-disclosing)", async () => {
    const r = await postHook("does-not-exist", {}, SECRET);
    assert.equal(r.status, 404);
  });

  it("missing credentials → 401", async () => {
    const r = await fetch(`${base}/hooks/deploy-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 401);
  });

  it("wrong credentials → 403", async () => {
    const r = await postHook("deploy-incident", {}, "not-the-secret");
    assert.equal(r.status, 403);
  });

  it("disabled hook → 404 (even with the right secret)", async () => {
    const r = await postHook("disabled-hook", {}, SECRET);
    assert.equal(r.status, 404);
  });

  it("secret-less hook → 404 (no auth configured ⇒ trigger disabled)", async () => {
    const r = await postHook("secretless-hook", {}, SECRET);
    assert.equal(r.status, 404);
  });

  it("hook whose workflow hasn't opted into `on: webhook` → 404", async () => {
    const r = await postHook("plain-hook", {}, SECRET);
    assert.equal(r.status, 404);
  });

  // Regression: authenticate BEFORE loading/parsing the target workflow. An
  // unauthenticated request to a hook whose workflow is broken must NOT reach the
  // parse (which would disclose the error inline and write an audit row) — it gets
  // a plain 401 with no parse detail leaked.
  it("unauthenticated request to a broken-workflow hook → 401, no parse-error disclosure", async () => {
    const r = await fetch(`${base}/hooks/broken-hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 401);
    const text = await r.text();
    assert.doesNotMatch(text, /job|parse|yaml|broken/i, `leaked workflow detail pre-auth: ${text}`);
  });

  // ...but an AUTHENTICATED operator still gets the real parse error (post-auth is
  // the legitimate place to surface it), proving the check moved, not disappeared.
  it("authenticated request to a broken-workflow hook → 400 with the parse error", async () => {
    const r = await postHook("broken-hook", {}, SECRET);
    assert.equal(r.status, 400);
    await r.text();
  });

  it("oversized body is rejected (413 or aborted) and never dispatched", async () => {
    // > 256KB of JSON, well past the cap. The server aborts the socket before
    // buffering it all (DoS protection), so a still-uploading client may see the
    // connection close rather than a clean 413 — both mean "rejected".
    const big = { blob: "x".repeat(300 * 1024) };
    let status = -1; // stays -1 if the socket is aborted mid-upload (also a rejection)
    try {
      status = (await postHook("deploy-incident", big, SECRET)).status;
    } catch {
      /* socket aborted mid-upload — status stays -1 */
    }
    assert.ok(status === 413 || status === -1, `expected 413 or abort, got ${status}`);
    assert.notEqual(status, 202);
  });

  it("non-object body → 400", async () => {
    const r = await fetch(`${base}/hooks/deploy-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: "[1,2,3]",
    });
    assert.equal(r.status, 400);
  });
});

describe("webhook receiver — dispatch & the event context", () => {
  it("a critical alert: 202, event baked into a run step, and the if-gated job RUNS", async () => {
    const r = await postHook("deploy-incident", { commonLabels: { severity: "critical" } }, SECRET);
    assert.equal(r.status, 202);
    const ack = (await r.json()) as { runId: string; eventsUrl: string };
    assert.equal(typeof ack.runId, "string");
    assert.equal(ack.eventsUrl, `/api/runs/${ack.runId}/events`);

    const events = await collectSse(`${base}/api/runs/${ack.runId}/events`, 30_000);
    assert.ok(events.some((e) => e.event === "run-init"), "expected run-init");
    const end = events.find((e) => e.event === "run-end");
    assert.ok(end, "expected run-end");
    assert.equal((JSON.parse(end.data) as { status: string }).status, "success");

    // The compiled `run:` echoed the payload's severity — event baked at compile.
    const out = events
      .filter((e) => e.event === "step-output")
      .map((e) => (JSON.parse(e.data) as { text: string }).text)
      .join("");
    assert.match(out, /severity=critical/);
    assert.match(out, /PAGING ONCALL/);

    // The `page` job's `if: event.* == 'critical'` evaluated true at runtime → it ran.
    const pageEnd = events.find((e) => e.event === "job-end" && (JSON.parse(e.data) as { jobId: string }).jobId === "page");
    assert.ok(pageEnd, "expected a job-end for `page`");
    assert.equal((JSON.parse(pageEnd.data) as { status: string }).status, "success");

    // It's recorded as a webhook-triggered run in history.
    const hist = (await (await fetch(`${base}/api/runs`)).json()) as { id: string; trigger: string }[];
    assert.equal(hist.find((h) => h.id === ack.runId)?.trigger, "webhook");
  });

  it("a non-critical alert: the if-gated `page` job does NOT run", async () => {
    const r = await postHook("deploy-incident", { commonLabels: { severity: "info" } }, SECRET);
    assert.equal(r.status, 202);
    const { runId } = (await r.json()) as { runId: string };

    const events = await collectSse(`${base}/api/runs/${runId}/events`, 30_000);
    const end = events.find((e) => e.event === "run-end");
    assert.equal((JSON.parse(end!.data) as { status: string }).status, "success");

    // `page`'s `if:` evaluated false at runtime — it never ran, so no output and
    // no successful job-end for it. (A job skipped at the scheduling layer emits
    // no hooks; the crisp skipped-status assertion lives in runtime-event.test.ts.)
    const out = events
      .filter((e) => e.event === "step-output")
      .map((e) => (JSON.parse(e.data) as { text: string }).text)
      .join("");
    assert.doesNotMatch(out, /PAGING ONCALL/);
    assert.match(out, /severity=info/);
    const pageSuccess = events.some(
      (e) => e.event === "job-end" && (JSON.parse(e.data) as { jobId: string; status: string }).jobId === "page" && (JSON.parse(e.data) as { status: string }).status === "success",
    );
    assert.equal(pageSuccess, false);
  });
});

describe("webhook receiver — HMAC signatures", () => {
  const sign = (raw: string) => createHmac("sha256", SECRET).update(raw).digest("hex");

  /** POST with a signature header computed (or not) from the exact bytes sent. */
  async function postHmac(hook: string, body: unknown, header: string, makeSig: (raw: string) => string | undefined): Promise<Response> {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const sig = makeSig(raw);
    if (sig !== undefined) headers[header] = sig;
    return fetch(`${base}/hooks/${hook}`, { method: "POST", headers, body: raw });
  }

  it("accepts a valid GitHub-style `sha256=<hex>` signature → 202", async () => {
    const r = await postHmac("signed-hook", { commonLabels: { severity: "low" } }, "X-Hub-Signature-256", (raw) => `sha256=${sign(raw)}`);
    assert.equal(r.status, 202);
  });

  it("accepts a valid Grafana-style bare-hex signature → 202", async () => {
    const r = await postHmac("grafana-hook", { commonLabels: { severity: "low" } }, "X-Grafana-Alerting-Signature", (raw) => sign(raw));
    assert.equal(r.status, 202);
  });

  it("missing signature header → 401", async () => {
    const r = await postHmac("signed-hook", { a: 1 }, "X-Hub-Signature-256", () => undefined);
    assert.equal(r.status, 401);
  });

  it("wrong signature → 403", async () => {
    const r = await postHmac("signed-hook", { a: 1 }, "X-Hub-Signature-256", () => `sha256=${"00".repeat(32)}`);
    assert.equal(r.status, 403);
  });

  it("a signature over different bytes (tampered body) → 403", async () => {
    const r = await postHmac("signed-hook", { a: 1 }, "X-Hub-Signature-256", () => `sha256=${sign(JSON.stringify({ a: 2 }))}`);
    assert.equal(r.status, 403);
  });

  it("a bearer token presented to an HMAC hook is rejected → 401", async () => {
    // The HMAC hook reads its signature header, not Authorization — a bearer
    // token isn't a signature, so it's missing-signature.
    const r = await fetch(`${base}/hooks/signed-hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: "{}",
    });
    assert.equal(r.status, 401);
  });
});

describe("webhook receiver — delivery dedupe", () => {
  it("an identical re-delivery returns the original runId and starts no new run", async () => {
    // Unique body so the delivery key can't collide with another test's run.
    const body = { commonLabels: { severity: "info" }, nonce: "dedupe-1" };
    const before = ((await (await fetch(`${base}/api/runs`)).json()) as unknown[]).length;

    const r1 = await postHook("deploy-incident", body, SECRET);
    assert.equal(r1.status, 202);
    const a1 = (await r1.json()) as { runId: string };

    const r2 = await postHook("deploy-incident", body, SECRET);
    assert.equal(r2.status, 200); // deduped — not a fresh 202
    const a2 = (await r2.json()) as { runId: string; deduped?: boolean };
    assert.equal(a2.runId, a1.runId);
    assert.equal(a2.deduped, true);

    // Exactly one new run was registered across the two deliveries.
    const after = ((await (await fetch(`${base}/api/runs`)).json()) as unknown[]).length;
    assert.equal(after - before, 1);
  });

  it("a different body is NOT deduped (distinct delivery key)", async () => {
    const r1 = await postHook("deploy-incident", { commonLabels: { severity: "info" }, nonce: "dedupe-A" }, SECRET);
    const r2 = await postHook("deploy-incident", { commonLabels: { severity: "info" }, nonce: "dedupe-B" }, SECRET);
    assert.equal(r1.status, 202);
    assert.equal(r2.status, 202);
    assert.notEqual(((await r1.json()) as { runId: string }).runId, ((await r2.json()) as { runId: string }).runId);
  });
});
