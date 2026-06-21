/**
 * Webhook pairing — the greenfield (`create workflow --webhook`) and retrofit
 * (`create webhook <name> --workflow <existing>`) paths, plus the pure builders.
 * The invariants that matter: both halves get name-matched, the secret is always
 * a `$VAR` ref, the source preset drives the auth mode/header, greenfield bakes
 * `on: webhook` into the generated file (and it still compiles), and retrofit
 * never mutates an existing workflow's YAML.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCreate } from "../src/scaffold/index.ts";
import {
  buildWebhookEntry,
  webhookTriggerBlock,
  webhookSecretEnv,
  resolveSource,
  SOURCE_PRESETS,
} from "../src/scaffold/webhook.ts";
import { injectAfterName } from "../src/scaffold/templates.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { UserFacingError } from "../src/errors.ts";

const readJson = async (p: string) => JSON.parse(await readFile(p, "utf-8"));

describe("webhook — pure builders", () => {
  it("derives the secret env as <NAME>_SECRET", () => {
    assert.equal(webhookSecretEnv("alerts"), "ALERTS_SECRET");
    assert.equal(webhookSecretEnv("my-hook"), "MY_HOOK_SECRET");
  });

  it("resolveSource: default generic, explicit wins, unknown throws", () => {
    assert.equal(resolveSource(undefined).id, "generic");
    assert.equal(resolveSource("grafana").id, "grafana");
    assert.throws(() => resolveSource("nope"), UserFacingError);
  });

  it("buildWebhookEntry: secret is a $VAR ref, auth/header from preset", () => {
    const entry = buildWebhookEntry({ hook: "alerts", workflow: "triage", source: SOURCE_PRESETS["grafana"]! });
    assert.equal(entry.workflow, "triage");
    assert.equal(entry.auth, "hmac-sha256");
    assert.equal(entry.signatureHeader, "X-Grafana-Alerting-Signature");
    assert.equal(entry.secret, "$ALERTS_SECRET");
    assert.match(String(entry.secret), /^\$/); // never a literal secret
  });

  it("buildWebhookEntry: bearer source omits signatureHeader; datasources scope when given", () => {
    const entry = buildWebhookEntry({
      hook: "alerts",
      workflow: "triage",
      source: SOURCE_PRESETS["alertmanager"]!,
      datasources: ["prometheus", "loki"],
    });
    assert.equal(entry.auth, "bearer");
    assert.equal(entry.signatureHeader, undefined);
    assert.deepEqual(entry.datasources, ["prometheus", "loki"]);
  });

  it("webhookTriggerBlock: includes source except for generic", () => {
    assert.match(webhookTriggerBlock("alerts", SOURCE_PRESETS["grafana"]!), /source: grafana/);
    assert.doesNotMatch(webhookTriggerBlock("alerts", SOURCE_PRESETS["generic"]!), /source:/);
    assert.match(webhookTriggerBlock("alerts", SOURCE_PRESETS["generic"]!), /secret: alerts/);
  });

  it("injectAfterName: inserts after name and keeps the rest", () => {
    const out = injectAfterName("name: x\n\njobs: {}\n", "on:\n  webhook: true");
    assert.match(out, /name: x\non:\n {2}webhook: true\n\njobs/);
    assert.throws(() => injectAfterName("jobs: {}\n", "on: x"));
  });
});

describe("create workflow --webhook (greenfield)", () => {
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), "pi-wf-wh-"));
  });
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  it("bakes on: webhook into the generated workflow and wires the config half", async () => {
    const code = await runCreate(["workflow", "triage", "--source", "alertmanager"], proj);
    assert.equal(code, 0);

    const yaml = await readFile(join(proj, ".workflows", "triage.yaml"), "utf-8");
    const spec = parseWorkflow(yaml);
    assert.ok(spec.on?.webhook, "workflow opts into webhook");
    assert.doesNotThrow(() => compile(spec), "generated workflow still compiles");
    assert.match(yaml, /secret: triage/);
    assert.match(yaml, /source: alertmanager/);

    const cfg = await readJson(join(proj, "work.json"));
    assert.equal(cfg.webhooks.triage.workflow, "triage");
    assert.equal(cfg.webhooks.triage.auth, "bearer");
    assert.equal(cfg.webhooks.triage.secret, "$TRIAGE_SECRET");
  });

  it("--datasources scopes the webhook entry", async () => {
    await runCreate(["workflow", "triage", "--webhook", "--datasources", "prometheus,loki"], proj);
    const cfg = await readJson(join(proj, "work.json"));
    assert.deepEqual(cfg.webhooks.triage.datasources, ["prometheus", "loki"]);
  });

  it("merges the webhook half into a template's own work.json (agent-action)", async () => {
    await runCreate(["workflow", "triage", "--template", "agent-action", "--webhook"], proj);
    const cfg = await readJson(join(proj, "work.json"));
    assert.ok(cfg.providers, "agent-action providers survive");
    assert.ok(cfg.models, "agent-action models survive");
    assert.equal(cfg.webhooks.triage.workflow, "triage");
  });

  it("an unknown --source fails before writing anything", async () => {
    await assert.rejects(() => runCreate(["workflow", "triage", "--source", "nope"], proj), UserFacingError);
    assert.equal(existsSync(join(proj, ".workflows", "triage.yaml")), false);
    assert.equal(existsSync(join(proj, "work.json")), false);
  });

  it("dry-run writes nothing", async () => {
    await runCreate(["workflow", "triage", "--webhook", "--dry-run"], proj);
    assert.equal(existsSync(join(proj, ".workflows", "triage.yaml")), false);
    assert.equal(existsSync(join(proj, "work.json")), false);
  });
});

describe("create webhook (retrofit)", () => {
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), "pi-wf-wh-"));
  });
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  it("wires the config half for an existing workflow without touching its YAML", async () => {
    await runCreate(["workflow", "triage"], proj); // plain workflow, no webhook
    const before = await readFile(join(proj, ".workflows", "triage.yaml"), "utf-8");

    const code = await runCreate(["webhook", "alerts", "--workflow", "triage", "--source", "grafana"], proj);
    assert.equal(code, 0);

    const cfg = await readJson(join(proj, "work.json"));
    assert.equal(cfg.webhooks.alerts.workflow, "triage");
    assert.equal(cfg.webhooks.alerts.auth, "hmac-sha256");
    assert.equal(cfg.webhooks.alerts.signatureHeader, "X-Grafana-Alerting-Signature");
    assert.equal(cfg.webhooks.alerts.secret, "$ALERTS_SECRET");

    // The workflow YAML is left exactly as it was (retrofit prints a snippet).
    assert.equal(await readFile(join(proj, ".workflows", "triage.yaml"), "utf-8"), before);
  });

  it("rejects a webhook for a workflow that doesn't exist", async () => {
    await assert.rejects(
      () => runCreate(["webhook", "alerts", "--workflow", "ghost"], proj),
      UserFacingError,
    );
    assert.equal(existsSync(join(proj, "work.json")), false);
  });

  it("retrofit with no --source uses the generic preset and still writes a $VAR-secret entry", async () => {
    // (A missing --workflow is rejected by `failUsage`, which calls process.exit — so
    // that arg-required path can't be asserted in-process; the grafana test above
    // covers an explicit preset, so here we pin the DEFAULT/generic-source path.)
    await runCreate(["workflow", "triage"], proj);
    assert.equal(await runCreate(["webhook", "alerts", "--workflow", "triage"], proj), 0);

    const cfg = await readJson(join(proj, "work.json"));
    assert.equal(cfg.webhooks.alerts.workflow, "triage");
    assert.equal(cfg.webhooks.alerts.secret, "$ALERTS_SECRET"); // never a literal secret
  });
});
