/**
 * Datasource egress wiring — proves `startRun` composes the agent + datasource
 * resolvers and the runtime forwards the resulting `JobNetwork` to a job's target,
 * so a plain `run:` step gets the scoped datasource's host allowlisted + its token
 * injected as a header-only secret. We can't exercise the real host-side header
 * swap without a gondolin VM (the test double doesn't implement it), so we spy on
 * the target factory and assert the network the runtime *hands it* — the seam the
 * real Gondolin target consumes.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createAbsurdEngine, type AbsurdEngine } from "../src/runtime/index.ts";
import type { TargetFactory } from "../src/targets/index.ts";
import type { PiWorkflowsConfig } from "../src/config/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { startRun } from "../src/run.ts";
import { HostTarget } from "./_support.ts";

const YAML = `name: ds-test
jobs:
  fetch:
    runs-on: gondolin
    steps:
      - name: q
        run: echo hi
`;

const config: PiWorkflowsConfig = {
  providers: {},
  models: {},
  datasources: { grafana: { baseUrl: "https://grafana.internal", token: "$GRAFANA_TEST_TOKEN" } },
};

/** A `JobNetwork` as captured at the target boundary. */
type CapturedNet = { allowedHosts?: string[]; secrets?: Record<string, { hosts: string[]; value: string }> };

let engine: AbsurdEngine;
before(async () => {
  process.env["GRAFANA_TEST_TOKEN"] = "tok-123";
  engine = await createAbsurdEngine();
});
after(async () => {
  await engine.close();
  delete process.env["GRAFANA_TEST_TOKEN"];
});

/** Run the workflow with a spy target factory; return the network handed to `fetch`. */
async function runAndCapture(datasources?: string[]): Promise<CapturedNet | undefined> {
  const seen = new Map<string, CapturedNet>();
  const spy: TargetFactory = (_runsOn, ctx) => {
    seen.set(basename(ctx.workdir), { allowedHosts: ctx.allowedHosts, secrets: ctx.secrets });
    return new HostTarget(ctx.workdir);
  };
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-ds-"));
  try {
    const result = await startRun({
      plan: compile(parseWorkflow(YAML)),
      workdir: workRoot,
      engine,
      config,
      makeTarget: spy,
      ...(datasources ? { datasources } : {}),
    });
    assert.equal(result.status, "success");
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
  return seen.get("fetch");
}

describe("datasource egress wiring", () => {
  it("grants a scoped datasource's host + injected token to a plain run job", async () => {
    const net = await runAndCapture(["grafana"]);
    assert.ok(net, "the `fetch` job's target should have been built");
    assert.deepEqual(net.allowedHosts, ["grafana.internal"]);
    assert.ok(net.secrets, "expected an injected secret");
    assert.deepEqual(net.secrets["GRAFANA_TOKEN"], { hosts: ["grafana.internal"], value: "tok-123" });
  });

  it("deny-by-default: with no datasource scope, a plain run job gets no egress", async () => {
    const net = await runAndCapture(); // no scope, no agent steps → no network
    assert.ok(net, "the `fetch` job's target should still have been built");
    assert.equal(net.allowedHosts, undefined);
    assert.equal(net.secrets, undefined);
  });
});
