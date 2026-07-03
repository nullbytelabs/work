/**
 * Webhook delivery audit log — the `DeliveryRepository` over the engine's `query`
 * seam (append/list ordering + restart durability on a real `dataDir`), and the
 * three UI-facing endpoints the receiver feeds:
 *   - `GET /api/webhooks` (shape; NO secret leakage),
 *   - `GET /api/webhooks/:name/deliveries` (a bad-auth POST and a valid/test
 *     delivery each show up with the right result + httpStatus; unknown → 404),
 *   - `POST /api/webhooks/:name/test` (token-gated; records a `"test"` row).
 *
 * The server is booted with a real `dataDir` (so deliveries are durable and read
 * from the repo) plus the `hostTargetFactory` double, so a triggered run executes
 * as host child processes — no gondolin VM.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbsurdEngine, SILENT_LOG } from "../src/runtime/index.ts";
import type { WorkConfig } from "../src/config/index.ts";
import { DeliveryRepository } from "../src/persistence/deliveries.ts";
import { hostTargetFactory } from "./_support.ts";
import { startWebServer, type WebServerHandle } from "../src/web/index.ts";

describe("DeliveryRepository", () => {
  it("appends and lists newest-first (by insert order), capped", async () => {
    const engine = await createAbsurdEngine({ log: SILENT_LOG });
    try {
      const repo = new DeliveryRepository(engine);
      await repo.ensureSchema();

      await repo.append({ hook: "h1", workflow: "wf", result: "forbidden", httpStatus: 403, sourceIp: "1.2.3.4", ts: 1000 });
      await repo.append({ hook: "h1", workflow: "wf", result: "accepted", httpStatus: 202, runId: "run-1", sourceIp: "1.2.3.4", ts: 2000 });
      await repo.append({ hook: "h2", workflow: "other", result: "unauthorized", httpStatus: 401, ts: 1500 });

      const h1 = await repo.listForHook("h1");
      assert.equal(h1.length, 2);
      // newest (highest id / last inserted) first
      assert.equal(h1[0]?.result, "accepted");
      assert.equal(h1[0]?.httpStatus, 202);
      assert.equal(h1[0]?.runId, "run-1");
      assert.equal(h1[0]?.ts, 2000);
      assert.equal(h1[1]?.result, "forbidden");
      assert.equal(h1[1]?.runId, null); // no run on a forbidden delivery

      // Scoped to the hook — h2's row is not in h1.
      const h2 = await repo.listForHook("h2");
      assert.equal(h2.length, 1);
      assert.equal(h2[0]?.result, "unauthorized");
      assert.equal(h2[0]?.sourceIp, null);

      // limit caps the result set.
      assert.equal((await repo.listForHook("h1", 1)).length, 1);

      // never returns a payload/secret — only the audited columns.
      assert.deepEqual(Object.keys(h1[0]!).sort(), ["httpStatus", "result", "runId", "sourceIp", "ts"]);
    } finally {
      await engine.close();
    }
  });

  it("persists across an engine restart on the same dataDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-deliv-"));
    try {
      const e1 = await createAbsurdEngine({ dataDir: dir, log: SILENT_LOG });
      const r1 = new DeliveryRepository(e1);
      await r1.ensureSchema();
      await r1.append({ hook: "survivor", workflow: "wf", result: "accepted", httpStatus: 202, runId: "r", ts: 4242 });
      await e1.close();

      // Reopen the same dataDir — the audited delivery must still be there.
      const e2 = await createAbsurdEngine({ dataDir: dir, log: SILENT_LOG });
      try {
        const r2 = new DeliveryRepository(e2);
        await r2.ensureSchema(); // idempotent
        const got = await r2.listForHook("survivor");
        assert.equal(got.length, 1);
        assert.equal(got[0]?.result, "accepted");
        assert.equal(got[0]?.httpStatus, 202);
        assert.equal(got[0]?.runId, "r");
        assert.equal(got[0]?.ts, 4242);
      } finally {
        await e2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// `incident` opts into webhook triggering; `plain` does not (used to prove the
// opt-in gate still fail-closes a hook pointing at it).
const INCIDENT = `name: incident
on: webhook
jobs:
  triage:
    runs-on: gondolin
    steps:
      - name: echo-sev
        run: echo "severity=\${{ event.commonLabels.severity }}"
`;

const PLAIN = `name: plain
jobs:
  noop:
    runs-on: gondolin
    steps:
      - name: noop
        run: echo noop
`;

const SECRET = "s3cr3t-bearer-token";

const config: WorkConfig = {
  providers: {},
  models: {},
  webhooks: {
    "deploy-incident": { workflow: "incident", auth: "bearer", secret: "$WEBHOOK_DELIV_SECRET" },
    "plain-hook": { workflow: "plain", auth: "bearer", secret: "$WEBHOOK_DELIV_SECRET" },
    "secretless-hook": { workflow: "incident", auth: "bearer" },
  },
};

describe("webhook delivery endpoints", () => {
  let workspace: string;
  let dataDir: string;
  let server: WebServerHandle;
  let base: string;

  before(async () => {
    process.env["WEBHOOK_DELIV_SECRET"] = SECRET;
    workspace = await mkdtemp(join(tmpdir(), "pi-wf-deliv-ws-"));
    const wfDir = join(workspace, ".workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "incident.yaml"), INCIDENT);
    await writeFile(join(wfDir, "plain.yaml"), PLAIN);

    dataDir = await mkdtemp(join(tmpdir(), "pi-wf-deliv-db-"));
    // We own the engine (no `engine` injected) so the durable DeliveryRepository
    // is wired up against `dataDir`.
    server = await startWebServer({ workspace, port: 0, dataDir, config, makeTarget: hostTargetFactory });
    base = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    if (server) await server.close();
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    delete process.env["WEBHOOK_DELIV_SECRET"];
  });

  function postHook(name: string, body: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${base}/hooks/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("GET /api/webhooks lists configured hooks and NEVER leaks a secret", async () => {
    const r = await fetch(`${base}/api/webhooks`);
    assert.equal(r.status, 200);
    const hooks = (await r.json()) as Array<Record<string, unknown>>;

    const deploy = hooks.find((h) => h["name"] === "deploy-incident")!;
    assert.ok(deploy, "expected deploy-incident in the listing");
    assert.equal(deploy["workflow"], "incident");
    assert.equal(deploy["enabled"], true);
    assert.equal(deploy["auth"], "bearer");
    assert.equal(deploy["configured"], true); // secret resolves

    // A configured-but-secretless hook reports configured:false.
    const secretless = hooks.find((h) => h["name"] === "secretless-hook")!;
    assert.equal(secretless["configured"], false);

    // The listed fields are exactly the contract — no `secret` anywhere.
    for (const h of hooks) {
      assert.deepEqual(Object.keys(h).sort(), ["auth", "configured", "enabled", "name", "workflow"]);
    }
    const serialized = JSON.stringify(hooks);
    assert.doesNotMatch(serialized, new RegExp(SECRET));
    assert.doesNotMatch(serialized, /WEBHOOK_DELIV_SECRET/);
  });

  it("a bad-auth POST is audited as forbidden with httpStatus 403", async () => {
    const r = await postHook("deploy-incident", { commonLabels: { severity: "info" } }, "wrong-secret");
    assert.equal(r.status, 403);

    const list = (await (await fetch(`${base}/api/webhooks/deploy-incident/deliveries`)).json()) as Array<Record<string, unknown>>;
    const forbidden = list.find((d) => d["result"] === "forbidden");
    assert.ok(forbidden, "expected a forbidden delivery row");
    assert.equal(forbidden["httpStatus"], 403);
    assert.equal(forbidden["runId"], null);
    assert.equal(typeof forbidden["ts"], "number");
    // never the payload/secret
    assert.deepEqual(Object.keys(forbidden!).sort(), ["httpStatus", "result", "runId", "sourceIp", "ts"]);
  });

  it("a missing-credentials POST is audited as unauthorized with httpStatus 401", async () => {
    const r = await fetch(`${base}/hooks/deploy-incident`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);

    const list = (await (await fetch(`${base}/api/webhooks/deploy-incident/deliveries`)).json()) as Array<Record<string, unknown>>;
    assert.ok(list.some((d) => d["result"] === "unauthorized" && d["httpStatus"] === 401), "expected an unauthorized row");
  });

  it("a valid delivery is audited as accepted with a runId, newest-first", async () => {
    const r = await postHook("deploy-incident", { commonLabels: { severity: "info" }, nonce: "accept-1" }, SECRET);
    assert.equal(r.status, 202);
    const { runId } = (await r.json()) as { runId: string };

    const list = (await (await fetch(`${base}/api/webhooks/deploy-incident/deliveries`)).json()) as Array<Record<string, unknown>>;
    // Newest-first: the accepted delivery we just made is at the head.
    assert.equal(list[0]?.["result"], "accepted");
    assert.equal(list[0]?.["httpStatus"], 202);
    assert.equal(list[0]?.["runId"], runId);
  });

  it("POST /api/webhooks/:name/test (token-gated) dispatches and audits a `test` row", async () => {
    // Without the token it's a 403 (the /api/* CSRF gate).
    const noTok = await fetch(`${base}/api/webhooks/deploy-incident/test`, { method: "POST" });
    assert.equal(noTok.status, 403);

    const r = await fetch(`${base}/api/webhooks/deploy-incident/test`, { method: "POST", headers: { "X-Work-Token": server.token } });
    assert.equal(r.status, 202);
    const { runId } = (await r.json()) as { runId: string };
    assert.equal(typeof runId, "string");

    const list = (await (await fetch(`${base}/api/webhooks/deploy-incident/deliveries`)).json()) as Array<Record<string, unknown>>;
    const test = list.find((d) => d["result"] === "test");
    assert.ok(test, "expected a test delivery row");
    assert.equal(test["httpStatus"], 202);
    assert.equal(test["runId"], runId);
  });

  it("test 404s a misconfigured (secretless) hook even with the token", async () => {
    const r = await fetch(`${base}/api/webhooks/secretless-hook/test`, { method: "POST", headers: { "X-Work-Token": server.token } });
    assert.equal(r.status, 404);
  });

  it("test 404s a hook whose workflow hasn't opted into `on: webhook`", async () => {
    const r = await fetch(`${base}/api/webhooks/plain-hook/test`, { method: "POST", headers: { "X-Work-Token": server.token } });
    assert.equal(r.status, 404);
  });

  it("GET …/deliveries 404s an unknown hook name", async () => {
    const r = await fetch(`${base}/api/webhooks/does-not-exist/deliveries`);
    assert.equal(r.status, 404);
  });
});
