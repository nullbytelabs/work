import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { parseConfig } from "../src/config/index.ts";
import {
  AbsurdRuntime,
  createAbsurdEngine,
  type AbsurdEngine,
  type UsesHandler,
  type UsesContext,
} from "../src/runtime/index.ts";
import { GuestPiRunner, GUEST_MODEL_KEY_ENV, makeAgentEgressResolver } from "../src/agent/index.ts";
import { hostTargetFactory } from "./_support.ts";

// --- The seam: a uses step runs through the job's target -----------------------

describe("uses steps inherit runs-on (the exec/sandboxed seam)", () => {
  let engine: AbsurdEngine;
  before(async () => (engine = await createAbsurdEngine()));
  after(async () => await engine.close());

  it("hands the handler a sandboxed flag and an exec bound to the job target", async () => {
    let seenSandboxed: boolean | undefined;
    let execStdout = "";
    const probe: UsesHandler = {
      scheme: "probe",
      async run(ctx: UsesContext) {
        seenSandboxed = ctx.sandboxed;
        // exec runs in the job's environment (a host-process double in this test).
        const r = await ctx.exec("echo from-target");
        execStdout = r.stdout.trim();
        return { status: "success", outputs: { via: execStdout } };
      },
    };

    const plan = compile(
      parseWorkflow(`
name: u
jobs:
  go:
    runs-on: gondolin
    steps:
      - id: p
        uses: probe/thing
      - env: { V: "\${{ steps.p.outputs.via }}" }
        run: echo "got=$V"
`),
    );
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-seam-"));
    let output = "";
    try {
      const result = await new AbsurdRuntime({ engine, usesHandlers: [probe], makeTarget: hostTargetFactory }).run(plan, {
        workRoot,
        hooks: { onOutput: (_j, _s, c) => (output += c.text) },
      });
      assert.equal(result.status, "success");
      assert.equal(seenSandboxed, true); // every job is sandboxed (gondolin)
      assert.equal(execStdout, "from-target");
      assert.match(output, /got=from-target/);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});

// --- GuestPiRunner: host-side orchestration (no VM needed) ----------------------

describe("GuestPiRunner", () => {
  it("installs Pi in-guest, runs the wrapper, and returns the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    const commands: string[] = [];
    // Fake guest exec: record commands; npm install no-ops; the wrapper writes a result.
    const exec = async (command: string) => {
      commands.push(command);
      const m = /guest-runner-\w+\.mjs\s+(\S+)\s+(\S+)/.exec(command);
      if (m) {
        const resHost = (m[2] as string).replace(`${dir}/`, `${dir}/`); // guestDir==hostDir==dir here
        const { writeFile } = await import("node:fs/promises");
        await writeFile(resHost, JSON.stringify({ text: "GUEST RESULT", finishReason: "stop" }));
      }
      return { exitCode: 0, stdout: "", stderr: "", ok: true };
    };

    const runner = new GuestPiRunner({ exec, hostDir: dir, guestDir: dir });
    const res = await runner.run({
      system: "sys",
      prompt: "hi",
      model: { baseUrl: "https://model.example.com/v1", apiKey: "SECRET", model: "m" },
    });

    assert.equal(res.text, "GUEST RESULT");
    assert.equal(res.finishReason, "stop");
    // It installed the Pi package, then ran the wrapper.
    assert.ok(commands.some((c) => /npm install .*@earendil-works\/pi-coding-agent/.test(c)), "should npm install Pi");
    assert.ok(commands.some((c) => /node .*guest-runner-\w+\.mjs/.test(c)), "should run the wrapper");

    // The per-invocation wrapper uses an unpredictable name (so a malicious guest
    // can't pre-plant a symlink at a known path) and is cleaned up after the run,
    // along with the request/result files.
    const stage = join(dir, ".pi-agent");
    const files = await readdir(stage);
    assert.ok(!files.some((f) => /^guest-runner-\w+\.mjs$/.test(f)), "wrapper should be cleaned up");
    assert.ok(!files.some((f) => /^req-/.test(f) || /^res-/.test(f)), "request/result should be cleaned up");
    await rm(dir, { recursive: true, force: true });
  });

  it("never writes the API key into the staged request file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    let capturedReq = "";
    const exec = async (command: string) => {
      const m = /guest-runner-\w+\.mjs\s+(\S+)\s+(\S+)/.exec(command);
      if (m) {
        capturedReq = await readFile(m[1] as string, "utf-8");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(m[2] as string, JSON.stringify({ text: "ok" }));
      }
      return { exitCode: 0, stdout: "", stderr: "", ok: true };
    };
    const runner = new GuestPiRunner({ exec, hostDir: dir, guestDir: dir });
    await runner.run({
      system: "s",
      prompt: "p",
      model: { baseUrl: "https://model.example.com/v1", apiKey: "SUPER-SECRET-KEY", model: "m" },
    });
    assert.doesNotMatch(capturedReq, /SUPER-SECRET-KEY/, "request file must not leak the key");
    assert.match(capturedReq, new RegExp(GUEST_MODEL_KEY_ENV), "request names the key env var instead");
    await rm(dir, { recursive: true, force: true });
  });

  it("fails clearly when the in-guest install fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    const exec = async (command: string) => {
      if (/npm install/.test(command)) return { exitCode: 1, stdout: "", stderr: "network down", ok: false };
      return { exitCode: 0, stdout: "", stderr: "", ok: true };
    };
    const runner = new GuestPiRunner({ exec, hostDir: dir, guestDir: dir });
    await assert.rejects(
      () =>
        runner.run({
          system: "s",
          prompt: "p",
          model: { baseUrl: "https://m.example.com/v1", apiKey: "k", model: "m" },
        }),
      /failed to install .*pi-coding-agent/,
    );
    await rm(dir, { recursive: true, force: true });
  });
});

// --- Egress resolver: allowlist model host + inject key ------------------------

describe("makeAgentEgressResolver", () => {
  const config = parseConfig({
    providers: { p: { baseUrl: "https://api.model.test/v1", apiKey: "the-real-key" } },
    models: { default: { provider: "p", model: "m1" } },
    defaultModel: "default",
  });

  function gondolinAgentPlan() {
    return compile(
      parseWorkflow(`
name: w
jobs:
  review:
    runs-on: gondolin
    steps:
      - uses: work/agent
        with: { prompt: "summarize" }
`),
    );
  }

  it("allows all egress (so the guest can npm-install Pi) but scopes the injected key to the model host", () => {
    const resolve = makeAgentEgressResolver(config);
    const net = resolve(gondolinAgentPlan().jobs["review"]!);
    // Egress is wide-open: the in-guest GuestPiRunner must reach registry.npmjs.org
    // to install @earendil-works/pi-coding-agent at runtime, not just the model API.
    assert.deepEqual(net?.allowedHosts, ["*"]);
    // The real API key stays scoped to the model host only — wildcarding egress
    // does NOT widen where the secret is injected.
    assert.deepEqual(net?.secrets, {
      [GUEST_MODEL_KEY_ENV]: { hosts: ["api.model.test"], value: "the-real-key" },
    });
  });

  it("grants no egress to a job with no uses: step; grants network (but no key) without config", () => {
    const resolveWith = makeAgentEgressResolver(config);
    const resolveNoCfg = makeAgentEgressResolver(undefined);

    const noUsesPlan = compile(
      parseWorkflow(`name: w\njobs:\n  go:\n    runs-on: gondolin\n    steps: [{ run: "true" }]`),
    );

    // No uses: step (only run:) → deny-by-default, no mediated egress.
    assert.equal(resolveWith(noUsesPlan.jobs["go"]!), undefined);
    // A work/agent job without config still needs network (to npm-install Pi), but
    // there is no model key to inject.
    const net = resolveNoCfg(gondolinAgentPlan().jobs["review"]!);
    assert.deepEqual(net?.allowedHosts, ["*"]);
    assert.equal(net?.secrets, undefined);
  });
});
