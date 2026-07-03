/**
 * Agent token-usage capture (Phase 2) — the plumbing that carries Pi's cumulative
 * token usage out to telemetry, tested without a VM or inference:
 *
 *  - work-handler: a runner that reports `usage` → the `work/agent` UsesResult carries
 *    `agent: { model, usage }` (which the runtime copies onto the StepResult, and the
 *    observability emitter turns into gen_ai.usage.* + token metrics).
 *  - GuestPiRunner: a fake `exec` that writes a result JSON with `usage` → the parsed
 *    AgentResult surfaces it (the host side of the guest boundary, VM-free per the
 *    runner's docstring).
 *
 * The one piece these don't cover is the in-guest wrapper's `getSessionStats()` call
 * against the real Pi SDK — that's verified by a real `work run` (docs §11, Layer 6).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createWorkHandler, GuestPiRunner, type AgentRunner } from "../src/agent/index.ts";
import { runComposite, type LoadedAction } from "../src/actions/index.ts";
import type { UsesContext, UsesResult } from "../src/runtime/index.ts";
import type { WorkConfig } from "../src/config/index.ts";

// A minimal stand-in for @earendil-works/pi-coding-agent: just the surface the
// wrapper touches, with a getSessionStats() returning known token totals.
const FAKE_PI = `
export class AuthStorage { static inMemory() { return new AuthStorage(); } }
export class ModelRegistry { static inMemory() { return new ModelRegistry(); } registerProvider() {} find() { return { id: "stub" }; } }
export class SettingsManager { static inMemory() { return new SettingsManager(); } }
export class SessionManager { static inMemory() { return new SessionManager(); } }
export class DefaultResourceLoader { async reload() {} }
export async function createAgentSession() {
  return { session: {
    messages: [{ role: "assistant", content: [{ type: "text", text: "STUB REPLY" }], stopReason: "stop" }],
    async prompt() {},
    getSessionStats() { return { tokens: { input: 321, output: 65, cacheRead: 0, cacheWrite: 0, total: 386 }, assistantMessages: 2 }; },
    dispose() {},
  } };
}
`;

const CONFIG: WorkConfig = {
  providers: { anthropic: { baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test" } },
  models: { opus: { provider: "anthropic", model: "claude-opus-4" } },
  defaultModel: "opus",
};

function makeCtx(workdir: string): UsesContext {
  return {
    uses: "work/agent",
    with: { prompt: "summarize" },
    workdir,
    runsOn: "gondolin",
    sandboxed: true,
    workspacePath: "/workspace",
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "", ok: true };
    },
    emit() {},
  };
}

describe("agent token-usage capture", () => {
  it("work-handler carries model + usage onto the agent step result", async () => {
    const runner: AgentRunner = {
      async run() {
        return { text: "done", usage: { inputTokens: 1820, outputTokens: 145, requests: 3 } };
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "au-"));
    try {
      const res = await createWorkHandler({ config: CONFIG, runner }).run(makeCtx(dir));
      assert.equal(res.status, "success");
      assert.deepEqual(res.agent, {
        model: "claude-opus-4",
        provider: "anthropic",
        usage: { inputTokens: 1820, outputTokens: 145, requests: 3 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("work-handler omits usage when the runner reports none (model still carried)", async () => {
    const runner: AgentRunner = { async run() { return { text: "done" }; } };
    const dir = await mkdtemp(join(tmpdir(), "au-"));
    try {
      const res = await createWorkHandler({ config: CONFIG, runner }).run(makeCtx(dir));
      assert.deepEqual(res.agent, { model: "claude-opus-4", provider: "anthropic" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("GuestPiRunner parses usage from the in-guest result JSON", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "au-host-"));
    const guestDir = "/guest-workspace";
    // Fake exec: ok the npm install, and for the wrapper run write a result JSON
    // (with usage) to the host side of the result path the command names.
    const exec = async (command: string) => {
      if (/npm root -g/.test(command)) return { exitCode: 1, stdout: "", stderr: "", ok: false }; // no baked-in Pi → install
      if (command.includes("npm install")) return { exitCode: 0, stdout: "", stderr: "", ok: true };
      const guestRes = command.split(" ").at(-1)!; // `node <wrapper> <req> <res>`
      const hostRes = guestRes.replace(guestDir, hostDir);
      await writeFile(hostRes, JSON.stringify({ text: "ok", finishReason: "stop", usage: { inputTokens: 123, outputTokens: 45, requests: 2 } }));
      return { exitCode: 0, stdout: "", stderr: "", ok: true };
    };
    try {
      const runner = new GuestPiRunner({ exec, hostDir, guestDir });
      const res = await runner.run({ prompt: "hi", model: { baseUrl: "https://api.anthropic.com/v1", apiKey: "sk", model: "claude-opus-4" } });
      assert.equal(res.text, "ok");
      assert.equal(res.finishReason, "stop");
      assert.deepEqual(res.usage, { inputTokens: 123, outputTokens: 45, requests: 2 });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("the real guest wrapper extracts usage from session stats (against a stub Pi)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "au-wrap-"));
    try {
      // Stage the SHIPPING wrapper next to a fake Pi package, exactly as GuestPiRunner
      // does in-guest — so the wrapper's `require.resolve` finds the fake, not the real SDK.
      const pkgDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0-stub", type: "module", main: "index.mjs" }));
      await writeFile(join(pkgDir, "index.mjs"), FAKE_PI);
      const wrapper = join(dir, "guest-runner.mjs");
      await copyFile(fileURLToPath(new URL("../src/agent/guest-runner-script.mjs", import.meta.url)), wrapper);

      const reqPath = join(dir, "req.json");
      const resPath = join(dir, "res.json");
      await writeFile(reqPath, JSON.stringify({ prompt: "hi", cwd: dir, keyEnv: "PI_WF_MODEL_KEY", model: { baseUrl: "https://api.example.com/v1", model: "claude-opus-4" } }));

      const run = spawnSync(process.execPath, [wrapper, reqPath, resPath], { env: { ...process.env, PI_WF_MODEL_KEY: "stub-key" }, encoding: "utf8" });
      assert.equal(run.status, 0, `wrapper exited non-zero: ${run.stderr}`);

      const result = JSON.parse(await readFile(resPath, "utf8"));
      assert.equal(result.text, "STUB REPLY");
      assert.equal(result.finishReason, "stop");
      assert.deepEqual(result.usage, { inputTokens: 321, outputTokens: 65, requests: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a composite action bubbles its inner work/agent usage up (the wrapped-agent path)", async () => {
    const action: LoadedAction = {
      name: "summarize",
      dir: "/unused",
      inputs: {},
      outputs: ["summary"],
      kind: "composite",
      steps: [{ id: "run", uses: "work/agent", with: { prompt: "summarize" } }],
      outputValues: { summary: "${{ steps.run.outputs.output }}" },
    };
    // dispatch stands in for the runtime's sub-uses router: work/agent returns usage.
    const dispatch = async (): Promise<UsesResult> => ({
      status: "success",
      outputs: { output: "SUMMARY" },
      agent: { model: "claude-opus-4", usage: { inputTokens: 500, outputTokens: 40, requests: 1 } },
    });
    const res = await runComposite(makeCtx("/unused"), action, {}, dispatch);
    assert.equal(res.status, "success");
    assert.equal(res.outputs?.summary, "SUMMARY");
    assert.deepEqual(res.agent, { model: "claude-opus-4", usage: { inputTokens: 500, outputTokens: 40, requests: 1 } });
  });
});
