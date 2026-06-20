/**
 * Agent model-key egress resolution — unit tests over the *pure* resolver
 * `makeAgentEgressResolver(config)(job)`, the function that decides which model
 * host(s) a job may reach and which API key Gondolin injects (host-scoped) for
 * the in-guest agent. No agent is run and nothing is mocked: we build a
 * `PlannedJob` by hand and assert the `AgentJobNetwork` the resolver produces —
 * the exact value the runtime later hands the target.
 *
 * The headline test pins the contract: one job may define two `work/agent` steps
 * on different providers, and each reaches its own host with its OWN key. The
 * resolver emits one host-scoped secret per distinct model host (`modelKeyEnv`),
 * and the in-guest runner derives the same per-host env name, so a step always
 * reads the placeholder for the host it calls — no first-wins collapse, no
 * cross-vendor key leak.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentEgressResolver } from "../src/agent/index.ts";
import type { PiWorkflowsConfig } from "../src/config/index.ts";
import type { PlannedJob, PlannedStep } from "../src/compiler/index.ts";

// Two providers, two models, two keys — the inference-arbitrage setup ("cheap
// model here, expensive model there").
const config: PiWorkflowsConfig = {
  providers: {
    anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "anthropic-key-AAA" },
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", apiKey: "fireworks-key-FFF" },
  },
  models: {
    sonnet: { provider: "anthropic", model: "claude-sonnet-4" },
    kimi: { provider: "fireworks", model: "accounts/fireworks/models/kimi" },
  },
  defaultModel: "sonnet",
};

const ANTHROPIC_HOST = "api.anthropic.com";
const FIREWORKS_HOST = "api.fireworks.ai";

function agentStep(name: string, model?: string): PlannedStep {
  return { name, uses: "work/agent", env: {}, ...(model ? { with: { model } } : {}) };
}

function job(id: string, steps: PlannedStep[]): PlannedJob {
  return { id, runsOn: "gondolin", machine: { cpus: 2, memory: "8G" }, needs: [], steps };
}

describe("agent model-key egress resolution", () => {
  it("one job with two model steps reaches each provider with ITS OWN key", () => {
    const resolve = makeAgentEgressResolver(config);
    // One job, two agent steps: sonnet (anthropic) and kimi (fireworks).
    const net = resolve(job("review", [agentStep("review/sonnet", "sonnet"), agentStep("review/kimi", "kimi")]));

    assert.ok(net, "a job with agent steps should get a network");
    assert.deepEqual(net.allowedHosts, ["*"], "agent jobs get mediated allow-all egress");
    assert.ok(net.secrets, "model keys should be injected");

    // What we want: each provider host is paired with its OWN key, so a request
    // to Fireworks carries the Fireworks key and one to Anthropic the Anthropic
    // key — no cross-vendor leak, no wrong-key 401. The single shared key env can
    // only hold one value, so correct scoping means a request to a host resolves
    // to that host's key. Express that as: for every injected secret, its key
    // value matches the provider of the host(s) it is scoped to.
    const secrets = Object.values(net.secrets);
    const keyForHost = (host: string): string | undefined =>
      secrets.find((s) => s.hosts.includes(host))?.value;

    assert.equal(keyForHost(ANTHROPIC_HOST), "anthropic-key-AAA", "Anthropic host must carry the Anthropic key");
    assert.equal(keyForHost(FIREWORKS_HOST), "fireworks-key-FFF", "Fireworks host must carry the Fireworks key");
  });

  it("a plain run: job gets open egress and no injected key", () => {
    // The egress wall was walked back (docs/egress-walk-back.md): every job gets
    // allow-all public egress, so a pure `run:` job (aws/kubectl/curl) is no longer
    // dead-ended. No model step → no injected key (the header-swap stays the control).
    const resolve = makeAgentEgressResolver(config);
    const net = resolve(job("plain", [{ name: "plain/echo", run: "echo hi", env: {} }]));
    assert.ok(net, "every job now gets a network");
    assert.deepEqual(net.allowedHosts, ["*"], "egress is open for every job");
    assert.equal(net.secrets, undefined, "no model step → no key injected");
  });
});
