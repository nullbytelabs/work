// Shared test support: boot ONE durable (PGLite-backed) Absurd engine per test
// file and hand out AbsurdRuntime instances bound to it, so we don't re-apply
// the schema for every workflow run. Not a *.test.ts file, so the runner ignores it.
import { before, after } from "node:test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine, type RunContext, type WorkflowResult } from "../src/runtime/index.ts";
import type { ExecutionPlan } from "../src/compiler/index.ts";
import type { ExecutionTarget, RunOptions, RunResult, TargetFactory } from "../src/targets/index.ts";
import { createAgentUsesHandler, createWorkAgentHandler, type AgentRunner, type AgentRequest } from "../src/agent/index.ts";
import { createActionUsesHandler } from "../src/actions/index.ts";

/** Deterministic agent runner for tests — no network. Echoes a canned summary. */
export const mockAgentRunner: AgentRunner = {
  async run(req: AgentRequest) {
    // Surface enough of the prompt to assert the wiring, but stay deterministic.
    const firstLine = req.prompt.split("\n").find((l) => l.trim().length > 0) ?? "";
    return { text: `MOCK SUMMARY: ${firstLine.slice(0, 60)}` };
  },
};

/**
 * Test-only `ExecutionTarget` that runs commands as host child processes — the
 * lightweight double the runtime talks to so component/integration tests verify
 * the runtime↔target *contract* (provision → run → capture $WORK_OUTPUT → dispose)
 * without booting a real micro-VM. Production has no host target; this lives in
 * test code only and is reachable solely through the runtime's `makeTarget` hook,
 * never from a workflow. Real gondolin coverage lives in the e2e/VM-smoke tests.
 */
export class HostTarget implements ExecutionTarget {
  readonly kind = "host";
  private readonly workdir: string;
  readonly workspacePath: string;

  constructor(workdir: string) {
    this.workdir = workdir;
    this.workspacePath = workdir;
  }

  async provision(): Promise<void> {
    await mkdir(this.workdir, { recursive: true });
  }

  run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", ["-lc", command], {
        cwd: opts.cwd ?? this.workdir,
        env: { ...process.env, ...opts.env },
        signal: opts.signal,
      });

      let stdout = "";
      let stderr = "";
      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;

      child.stdout.on("data", (b: Buffer) => {
        const t = b.toString();
        stdout += t;
        opts.onOutput?.({ stream: "stdout", text: t });
      });
      child.stderr.on("data", (b: Buffer) => {
        const t = b.toString();
        stderr += t;
        opts.onOutput?.({ stream: "stderr", text: t });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const exitCode = code ?? -1;
        resolve({ exitCode, stdout, stderr, ok: exitCode === 0 });
      });
    });
  }

  async dispose(): Promise<void> {
    /* Host target holds no resources to release. */
  }
}

/** A `makeTarget` factory that always returns the host double (ignores runs-on). */
export const hostTargetFactory: TargetFactory = (_runsOn, ctx) => new HostTarget(ctx.workdir);

export interface SharedRuntime {
  run(plan: ExecutionPlan, ctx: RunContext, agentRunner?: AgentRunner): Promise<WorkflowResult>;
}

/**
 * Call once at the top of a test file; registers before/after for the engine.
 *
 * By default the runtime uses the host-process double (`HostTarget`), so the
 * test exercises the runtime↔target contract without a VM. Pass
 * `{ realTargets: true }` for the e2e tier (examples) that must boot real
 * gondolin micro-VMs.
 */
export function useSharedRuntime(opts: { realTargets?: boolean } = {}): SharedRuntime {
  let engine: AbsurdEngine | undefined;
  before(async () => {
    engine = await createAbsurdEngine();
  });
  after(async () => {
    if (engine) await engine.close();
  });
  return {
    // Register the agent uses-handlers with the mock runner (no inference) unless
    // a test passes its own runner — both `agent/<name>` and the `work/agent`
    // primitive — plus the JS-action handler (which runs `node` in-target, not the
    // runner), so e2e examples using any of them dispatch.
    run(plan, ctx, agentRunner = mockAgentRunner) {
      if (!engine) throw new Error("engine not started");
      const usesHandlers = [
        createAgentUsesHandler({ runner: agentRunner }),
        createWorkAgentHandler({ runner: agentRunner }),
        createActionUsesHandler(),
      ];
      return new AbsurdRuntime({
        engine,
        usesHandlers,
        ...(opts.realTargets ? {} : { makeTarget: hostTargetFactory }),
      }).run(plan, ctx);
    },
  };
}
