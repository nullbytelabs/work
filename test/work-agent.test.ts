import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkHandler, type AgentRunner, type AgentRequest } from "../src/agent/index.ts";
import { StepInterrupted, type UsesContext } from "../src/runtime/index.ts";

// The dumb `work/agent` primitive: `with:` is the AgentRequest. These tests drive
// the handler directly with a recording runner (no inference), asserting prompt
// sourcing, the ambient-discovery (no system) path, and output mapping.

function recordingRunner(): { runner: AgentRunner; calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  return {
    calls,
    runner: {
      async run(req) {
        calls.push(req);
        return { text: "AGENT REPLY" };
      },
    },
  };
}

function makeCtx(over: {
  uses?: string;
  with: Record<string, unknown>;
  workdir: string;
}): { ctx: UsesContext; emitted: { stream: string; text: string }[] } {
  const emitted: { stream: string; text: string }[] = [];
  const ctx: UsesContext = {
    uses: over.uses ?? "work/agent",
    with: over.with,
    workdir: over.workdir,
    runsOn: "gondolin",
    sandboxed: true,
    workspacePath: "/workspace",
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "", ok: true };
    },
    emit: (c) => emitted.push(c),
  };
  return { ctx, emitted };
}

describe("work/agent primitive", () => {
  it("passes the inline prompt to the runner and maps the reply to `output`", async () => {
    const { runner, calls } = recordingRunner();
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      const { ctx } = makeCtx({ with: { prompt: "Summarize." }, workdir: dir });
      const res = await createWorkHandler({ runner }).run(ctx);
      assert.equal(res.status, "success");
      assert.equal(res.stdout, "AGENT REPLY");
      assert.deepEqual(res.outputs, { output: "AGENT REPLY" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.prompt, "Summarize.");
      assert.equal(calls[0]!.cwd, "/workspace");
      // No separate system prompt — the prompt carries the role; ambient .pi/ stands.
      assert.equal(calls[0]!.system, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads promptFile from the workspace", async () => {
    const { runner, calls } = recordingRunner();
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      await writeFile(join(dir, "task.md"), "Review the diff.\n");
      const { ctx } = makeCtx({ with: { promptFile: "task.md" }, workdir: dir });
      const res = await createWorkHandler({ runner }).run(ctx);
      assert.equal(res.status, "success");
      assert.equal(calls[0]!.prompt, "Review the diff."); // trimmed
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when no prompt source is supplied", async () => {
    const { runner } = recordingRunner();
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      const { ctx, emitted } = makeCtx({ with: { model: "kimi" }, workdir: dir });
      const res = await createWorkHandler({ runner }).run(ctx);
      assert.equal(res.status, "failure");
      assert.match(res.stderr ?? "", /needs a prompt/);
      assert.ok(emitted.some((e) => /needs a prompt/.test(e.text)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Regression: a StepInterrupted (a target/exec tear-out) must propagate, never be
  // swallowed into a failure result — otherwise a torn-out work/agent step is
  // recorded as a non-resumable failure (durable-resume parity with run: steps).
  it("re-throws StepInterrupted from the runner instead of swallowing it", async () => {
    const runner: AgentRunner = { async run() { throw new StepInterrupted(new Error("vm torn out")); } };
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      const { ctx } = makeCtx({ with: { prompt: "x" }, workdir: dir });
      await assert.rejects(() => createWorkHandler({ runner }).run(ctx), (e) => e instanceof StepInterrupted);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects any work/<x> other than work/agent", async () => {
    const { runner } = recordingRunner();
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      const { ctx } = makeCtx({ uses: "work/summarize", with: { prompt: "x" }, workdir: dir });
      const res = await createWorkHandler({ runner }).run(ctx);
      assert.equal(res.status, "failure");
      assert.match(res.stderr ?? "", /unsupported work built-in/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a promptFile that escapes the workspace", async () => {
    const { runner } = recordingRunner();
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      const { ctx } = makeCtx({ with: { promptFile: "../escape.md" }, workdir: dir });
      const res = await createWorkHandler({ runner }).run(ctx);
      assert.equal(res.status, "failure");
      assert.match(res.stderr ?? "", /escapes the workspace/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Regression: a hostile checkout plants a symlink whose lexical path has no `..`
  // but resolves to an arbitrary host file (a secret). The containment check must
  // resolve symlinks, not just `relative(join())`, so the host secret never becomes
  // the agent's prompt.
  it("rejects a promptFile that is a symlink escaping the workspace", async () => {
    const { runner, calls } = recordingRunner();
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    const secretDir = await mkdtemp(join(tmpdir(), "wa-secret-"));
    try {
      const secret = join(secretDir, "id_rsa");
      await writeFile(secret, "PRIVATE-HOST-KEY\n");
      await symlink(secret, join(dir, "leak.md"));
      const { ctx } = makeCtx({ with: { promptFile: "leak.md" }, workdir: dir });
      const res = await createWorkHandler({ runner }).run(ctx);
      assert.equal(res.status, "failure");
      assert.match(res.stderr ?? "", /escapes the workspace/);
      // The runner must never have seen the host secret.
      assert.equal(calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(secretDir, { recursive: true, force: true });
    }
  });

  // A symlink that stays INSIDE the workspace is still fine to read.
  it("reads a promptFile symlink that resolves within the workspace", async () => {
    const { runner, calls } = recordingRunner();
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      await writeFile(join(dir, "real.md"), "Inside task.\n");
      await symlink(join(dir, "real.md"), join(dir, "task.md"));
      const { ctx } = makeCtx({ with: { promptFile: "task.md" }, workdir: dir });
      const res = await createWorkHandler({ runner }).run(ctx);
      assert.equal(res.status, "success");
      assert.equal(calls[0]!.prompt, "Inside task.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
