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
import { loopbackModelPin, makeAgentEgressResolver, modelKeyEnv, resolveModelEndpoint } from "../src/agent/index.ts";
import type { WorkConfig } from "../src/config/index.ts";
import type { PlannedJob, PlannedStep } from "../src/compiler/index.ts";

// Two providers, two models, two keys — the inference-arbitrage setup ("cheap
// model here, expensive model there").
const config: WorkConfig = {
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
  return { id, runsOn: "gondolin", runsOnSpec: { namespace: "gondolin" }, machine: { cpus: 2, memory: "8G" }, needs: [], steps };
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

  it("a loopback provider (localhost model server) gets a guest alias pinned back to loopback", () => {
    // The everyday local setup: llama.cpp/ollama/omlx on the operator's machine,
    // `baseUrl: http://localhost:8000/v1` written verbatim in work.json. The guest
    // can't dial localhost (that's ITS loopback), so the resolver must emit a
    // host-side pin for the alias the in-guest runner hands Pi, lift the
    // internal-range block for the loopback IP, and scope the key to that IP
    // (the hostname the request carries after the pin rewrite).
    const local: WorkConfig = {
      providers: { omlx: { baseUrl: "http://localhost:8000/v1", apiKey: "local-key-LLL" } },
      models: { ornith: { provider: "omlx", model: "ornith-35b" } },
      defaultModel: "ornith",
    };
    const net = makeAgentEgressResolver(local)(job("local", [agentStep("local/agent")]));

    assert.ok(net?.secrets, "the local key should still ride host-side injection");
    const pin = loopbackModelPin("localhost");
    assert.ok(pin, "localhost must be recognized as a loopback model host");
    assert.deepEqual(net.hostResolves, { [pin.alias]: "127.0.0.1" }, "the alias must pin to the host's loopback");
    assert.deepEqual(net.allowedInternalHosts, ["127.0.0.1"], "the internal-range block must be lifted for the pin IP");
    assert.deepEqual(
      net.secrets[modelKeyEnv(pin.alias)],
      { hosts: ["127.0.0.1"], value: "local-key-LLL" },
      "the key must be scoped to the pinned IP under the alias-derived env name",
    );
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

describe("loopbackModelPin", () => {
  it("maps localhost, *.localhost, and 127/8 literals to an alias + loopback IP", () => {
    assert.deepEqual(loopbackModelPin("localhost"), { alias: "localhost.loopback.internal", ip: "127.0.0.1" });
    assert.deepEqual(loopbackModelPin("api.localhost"), { alias: "api-localhost.loopback.internal", ip: "127.0.0.1" });
    assert.deepEqual(loopbackModelPin("127.0.0.5"), { alias: "127-0-0-5.loopback.internal", ip: "127.0.0.5" });
  });

  it("leaves non-loopback hosts alone", () => {
    assert.equal(loopbackModelPin("api.fireworks.ai"), undefined);
    assert.equal(loopbackModelPin("mylocalhost.example.com"), undefined);
    assert.equal(loopbackModelPin("[::1]"), undefined); // rejected upstream with a clear error
  });

  it("never emits an alias the guest DNS special-cases back to guest loopback", () => {
    for (const host of ["localhost", "api.localhost", "127.0.0.1"]) {
      const alias = loopbackModelPin(host)!.alias;
      assert.ok(alias !== "localhost" && !alias.endsWith(".localhost"), `alias "${alias}" must not re-trigger the RFC-6761 carve-out`);
    }
  });
});

describe("resolveModelEndpoint", () => {
  // The single derivation both sides of the guest/host split consume: the egress
  // resolver (host-side key injection) and the in-guest runner. They used to
  // re-derive host/pin/keyEnv in parallel and could drift; this pins the contract.
  it("resolves a public provider to host == guestHost, no pin, host-derived keyEnv", () => {
    const ep = resolveModelEndpoint("https://api.fireworks.ai/inference/v1");
    assert.equal(ep.host, "api.fireworks.ai");
    assert.equal(ep.pin, undefined);
    assert.equal(ep.guestHost, "api.fireworks.ai");
    assert.equal(ep.keyEnv, modelKeyEnv("api.fireworks.ai"));
  });

  it("resolves a loopback provider to the alias guestHost + a pin, keyEnv derived from the alias", () => {
    const ep = resolveModelEndpoint("http://localhost:8000/v1");
    assert.equal(ep.host, "localhost");
    assert.deepEqual(ep.pin, { alias: "localhost.loopback.internal", ip: "127.0.0.1" });
    assert.equal(ep.guestHost, "localhost.loopback.internal");
    // The key scopes to the alias (what the guest dials), matching the guest runner.
    assert.equal(ep.keyEnv, modelKeyEnv("localhost.loopback.internal"));
  });

  it("fails closed (throws) on an unpinnable [::1] and on an invalid baseUrl — so both sides skip identically", () => {
    assert.throws(() => resolveModelEndpoint("http://[::1]:8000/v1"), /IPv6 loopback/);
    assert.throws(() => resolveModelEndpoint("not a url"), /not a valid URL/);
  });
});
