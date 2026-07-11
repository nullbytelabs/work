import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
import { GuestPiRunner, GUEST_MODEL_KEY_ENV, modelKeyEnv, makeAgentEgressResolver } from "../src/agent/index.ts";
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
      // No Pi baked into this (stock) target: the link probe fails → install runs.
      if (/npm root -g/.test(command)) return { exitCode: 1, stdout: "", stderr: "", ok: false };
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

    // The per-invocation staging dir uses an UNPREDICTABLE name (`.pi-agent-<id>`,
    // not a constant) so a hostile checkout can't pre-plant a symlink or a
    // malicious `.npmrc`/`node_modules` at a known prefix, and it's removed wholesale
    // after the run.
    const entries = await readdir(dir);
    const stages = entries.filter((e) => /^\.pi-agent(-|$)/.test(e));
    assert.deepEqual(stages, [], "per-invocation staging dir should be cleaned up");
    await rm(dir, { recursive: true, force: true });
  });

  // When the guest image bakes Pi in (e.g. `work:pi`), the runner links that copy
  // into the stage instead of paying a ~30s `npm install` every step.
  it("reuses a Pi baked into the guest image, skipping the install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    const commands: string[] = [];
    const exec = async (command: string) => {
      commands.push(command);
      // A guest image with Pi baked in: the link probe succeeds.
      if (/npm root -g/.test(command)) return { exitCode: 0, stdout: "", stderr: "", ok: true };
      const m = /guest-runner-\w+\.mjs\s+(\S+)\s+(\S+)/.exec(command);
      if (m) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(m[2] as string, JSON.stringify({ text: "BAKED", finishReason: "stop" }));
      }
      return { exitCode: 0, stdout: "", stderr: "", ok: true };
    };

    const runner = new GuestPiRunner({ exec, hostDir: dir, guestDir: dir });
    const res = await runner.run({
      prompt: "hi",
      model: { baseUrl: "https://model.example.com/v1", apiKey: "k", model: "m" },
    });

    assert.equal(res.text, "BAKED");
    // It linked the baked-in Pi (probe) and ran the wrapper — without installing.
    assert.ok(
      commands.some((c) => /npm root -g/.test(c) && /ln -sfn/.test(c)),
      "should link the baked-in Pi into the stage",
    );
    assert.ok(!commands.some((c) => /npm install/.test(c)), "should NOT npm install when Pi is baked in");
    assert.ok(commands.some((c) => /node .*guest-runner-\w+\.mjs/.test(c)), "should run the wrapper");
    await rm(dir, { recursive: true, force: true });
  });

  // Regression: a hostile checkout can pre-plant a constant staging prefix
  // (`.pi-agent`) as a symlink (host-write escape) or a real dir with a malicious
  // `.npmrc`/`node_modules` (registry redirect → in-guest code-exec). The staging
  // dir must be UNPREDICTABLE per invocation, npm must run with its project dir IN
  // that dir (so a checkout-root `.npmrc` is ignored), and `--ignore-scripts` must
  // block lifecycle-script execution.
  it("stages into an unpredictable per-invocation dir and hardens the in-guest install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    const stageDirs: string[] = [];
    let installCmd = "";
    const exec = async (command: string) => {
      if (/npm root -g/.test(command)) return { exitCode: 1, stdout: "", stderr: "", ok: false };
      const cd = /cd (\S+\/(\.pi-agent-\w+)) &&/.exec(command);
      if (cd) stageDirs.push(cd[2] as string);
      if (/npm install/.test(command)) installCmd = command;
      const m = /guest-runner-\w+\.mjs\s+(\S+)\s+(\S+)/.exec(command);
      if (m) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(m[2] as string, JSON.stringify({ text: "ok" }));
      }
      return { exitCode: 0, stdout: "", stderr: "", ok: true };
    };
    const runner = new GuestPiRunner({ exec, hostDir: dir, guestDir: dir });
    const model = { baseUrl: "https://model.example.com/v1", apiKey: "k", model: "m" } as const;
    await runner.run({ system: "s", prompt: "p", model });
    const firstStage = stageDirs[0];
    await runner.run({ system: "s", prompt: "p", model });
    const secondStage = stageDirs[1];

    // The prefix is never the constant `.pi-agent` and differs across invocations.
    assert.ok(firstStage && /^\.pi-agent-\w+$/.test(firstStage), "stage dir must be `.pi-agent-<id>`");
    assert.notEqual(firstStage, ".pi-agent");
    assert.notEqual(firstStage, secondStage, "stage dir must be unpredictable per invocation");
    // The install runs inside the unguessable dir, pins the registry (so a planted
    // .npmrc can't redirect it), and ignores lifecycle scripts.
    assert.match(installCmd, /cd \S+\/\.pi-agent-\w+ && npm install/);
    assert.match(installCmd, /--registry=https:\/\/registry\.npmjs\.org\//);
    assert.match(installCmd, /--ignore-scripts/);
    await rm(dir, { recursive: true, force: true });
  });

  it("never writes the API key into the staged request file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    let capturedReq = "";
    const exec = async (command: string) => {
      if (/npm root -g/.test(command)) return { exitCode: 1, stdout: "", stderr: "", ok: false };
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

  it("hands the guest an alias baseUrl for a loopback model host (localhost provider)", async () => {
    // `baseUrl: http://localhost:8000/v1` in work.json: inside the guest, localhost
    // is the GUEST's loopback, so the runner must rewrite the guest-facing baseUrl
    // to the alias the egress resolver pins back to the host's loopback — and
    // derive the key env from that same alias so the placeholder matches.
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    let capturedReq = "";
    const exec = async (command: string) => {
      if (/npm root -g/.test(command)) return { exitCode: 1, stdout: "", stderr: "", ok: false };
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
      prompt: "p",
      model: { baseUrl: "http://localhost:8000/v1", apiKey: "k", model: "ornith" },
    });
    const req = JSON.parse(capturedReq) as { keyEnv: string; model: { baseUrl: string } };
    assert.equal(req.model.baseUrl, "http://localhost.loopback.internal:8000/v1", "guest baseUrl must carry the alias, not localhost");
    assert.equal(req.keyEnv, modelKeyEnv("localhost.loopback.internal"), "key env must derive from the alias (matches the resolver)");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects an IPv6-loopback model baseUrl with an actionable error", async () => {
    const runner = new GuestPiRunner({
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", ok: true }),
      hostDir: "/unused",
      guestDir: "/unused",
    });
    await assert.rejects(
      () => runner.run({ prompt: "p", model: { baseUrl: "http://[::1]:8000/v1", apiKey: "k", model: "m" } }),
      /bind the server on 127\.0\.0\.1/,
    );
  });

  // Regression: a prompt-injected agent could plant the result path as a symlink to
  // a host file (the shared mount follows symlinks), turning the wrapper's result
  // write into an arbitrary host-file overwrite. The host read must refuse to follow
  // a symlink at the result path.
  it("refuses to read a result file that is a symlink (sandbox write/read escape)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    const secretDir = await mkdtemp(join(tmpdir(), "pi-wf-secret-"));
    try {
      const secret = join(secretDir, "host-secret");
      await writeFile(secret, "HOST DATA");
      // Fake exec: instead of writing a regular result file, plant a symlink to a
      // host file at the result path (what a hostile in-guest actor would do).
      const exec = async (command: string) => {
        if (/npm root -g/.test(command)) return { exitCode: 1, stdout: "", stderr: "", ok: false };
        const m = /guest-runner-\w+\.mjs\s+(\S+)\s+(\S+)/.exec(command);
        if (m) await symlink(secret, m[2] as string);
        return { exitCode: 0, stdout: "", stderr: "", ok: true };
      };
      const runner = new GuestPiRunner({ exec, hostDir: dir, guestDir: dir });
      await assert.rejects(
        () => runner.run({ prompt: "p", model: { baseUrl: "https://m.example.com/v1", apiKey: "k", model: "m" } }),
        /result path is a symlink/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(secretDir, { recursive: true, force: true });
    }
  });

  // Regression: Pi records a failed model call (unreachable provider, bad auth) as
  // an assistant message with stopReason "error" and EMPTY text — the wrapper used
  // to return that as `{text: ""}`, so a run whose model never answered reported
  // SUCCESS with blank outputs and no visible error anywhere. The wrapper must
  // surface the cause as a failure instead.
  it("the real guest wrapper fails loudly when the model call errored (no empty-success)", async () => {
    const FAKE_ERROR_PI = `
export class AuthStorage { static inMemory() { return new AuthStorage(); } }
export class ModelRegistry { static inMemory() { return new ModelRegistry(); } registerProvider() {} find() { return { id: "stub" }; } }
export class SettingsManager { static inMemory() { return new SettingsManager(); } }
export class SessionManager { static inMemory() { return new SessionManager(); } }
export class DefaultResourceLoader { async reload() {} }
export async function createAgentSession() {
  return { session: {
    messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "connect ECONNREFUSED 127.0.0.1:8000" }],
    async prompt() {},
    dispose() {},
  } };
}
`;
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-wrap-err-"));
    try {
      // Stage the SHIPPING wrapper next to a fake Pi whose session errored, exactly
      // as GuestPiRunner stages it in-guest.
      const pkgDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0-stub", type: "module", main: "index.mjs" }));
      await writeFile(join(pkgDir, "index.mjs"), FAKE_ERROR_PI);
      const wrapper = join(dir, "guest-runner.mjs");
      await copyFile(fileURLToPath(new URL("../src/agent/guest-runner-script.mjs", import.meta.url)), wrapper);

      const reqPath = join(dir, "req.json");
      const resPath = join(dir, "res.json");
      await writeFile(reqPath, JSON.stringify({ prompt: "hi", cwd: dir, keyEnv: "PI_WF_MODEL_KEY", model: { baseUrl: "http://localhost.loopback.internal:8000/v1", model: "m" } }));

      const run = spawnSync(process.execPath, [wrapper, reqPath, resPath], { env: { ...process.env, PI_WF_MODEL_KEY: "k" }, encoding: "utf8" });
      assert.notEqual(run.status, 0, "wrapper must exit non-zero when the model call errored");
      const result = JSON.parse(await readFile(resPath, "utf8")) as { error?: string; text?: string };
      assert.equal(result.text, undefined, "no text result on a provider error");
      assert.match(result.error ?? "", /ECONNREFUSED 127\.0\.0\.1:8000/, "the provider error must surface in the result");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when the in-guest install fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-guest-"));
    const exec = async (command: string) => {
      if (/npm root -g/.test(command)) return { exitCode: 1, stdout: "", stderr: "", ok: false };
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
      [modelKeyEnv("api.model.test")]: { hosts: ["api.model.test"], value: "the-real-key" },
    });
  });

  it("grants open egress (but no key) to a job with no uses: step, and without config", () => {
    const resolveWith = makeAgentEgressResolver(config);
    const resolveNoCfg = makeAgentEgressResolver(undefined);

    const noUsesPlan = compile(
      parseWorkflow(`name: w\njobs:\n  go:\n    runs-on: gondolin\n    steps: [{ run: "true" }]`),
    );

    // No uses: step (only run:) → open egress, no model key (the wall was walked
    // back; the header-swap, not the allowlist, is the token control).
    const plainNet = resolveWith(noUsesPlan.jobs["go"]!);
    assert.deepEqual(plainNet?.allowedHosts, ["*"]);
    assert.equal(plainNet?.secrets, undefined);
    // A work/agent job without config still needs network (to npm-install Pi), but
    // there is no model key to inject.
    const net = resolveNoCfg(gondolinAgentPlan().jobs["review"]!);
    assert.deepEqual(net?.allowedHosts, ["*"]);
    assert.equal(net?.secrets, undefined);
  });
});
