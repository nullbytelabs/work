// Shared test support: boot ONE durable (PGLite-backed) Absurd engine per test
// file and hand out AbsurdRuntime instances bound to it, so we don't re-apply
// the schema for every workflow run. Not a *.test.ts file, so the runner ignores it.
import { before, after } from "node:test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine, type RunContext, type WorkflowResult } from "../src/runtime/index.ts";
import { parseRunsOn, type ExecutionPlan } from "../src/compiler/index.ts";
import { resolveImageConfig, ensureImageTag } from "../src/images/index.ts";
import type { ExecutionTarget, RunOptions, RunResult, TargetFactory } from "../src/targets/index.ts";
import { createWorkHandler, makeAgentEgressResolver, type AgentRunner, type AgentRequest } from "../src/agent/index.ts";
import { createActionUsesHandler, type SubUsesDispatch } from "../src/actions/index.ts";
import type { UsesHandler } from "../src/runtime/index.ts";

/**
 * Skip reason for the real-VM (QEMU) test tiers, or `false` to run them. Pass it
 * to `describe(name, { skip: vmTestSkip() }, …)` so the e2e / VM-smoke suites can
 * opt out of booting a micro-VM. The *only* opt-out is the explicit `WORK_SKIP_VM`
 * env var, which backs the fast `test:unit` inner loop. The full suite (`npm test`)
 * always boots real VMs — there is no auto-skip, so a run can never silently pass
 * by quietly dropping the VM tier.
 */
export function vmTestSkip(): string | false {
  return process.env["WORK_SKIP_VM"] ? "WORK_SKIP_VM set (fast unit tier)" : false;
}

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
      });

      let stdout = "";
      let stderr = "";

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

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
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

/**
 * A `makeTarget` factory whose target for job `jobId` simulates a platform stop:
 * its `run` rejects, so the runtime-wrapped exec throws StepInterrupted and the job
 * is torn out (resumable) while every other job runs on the host double. This is the
 * shared crash-resume primitive behind the durability tests — job identity is read
 * from the workdir basename, which the runtime sets to the job id.
 *
 * - `onRun` (default 1): reject the Nth `run()` call on the target; earlier calls
 *   delegate to the host, so a multi-step job can complete step 1 and be torn out on
 *   step 2.
 * - `disposeThrows`: the torn-out job's `dispose()` ALSO rejects (a dead VM's close
 *   failing). The runtime must swallow it and keep the run resumable, not relabel it a
 *   terminal failure.
 */
export function crashTargetFor(
  jobId: string,
  opts: { onRun?: number; disposeThrows?: boolean } = {},
): TargetFactory {
  const crashAt = opts.onRun ?? 1;
  return (_runsOn, ctx) => {
    const host = new HostTarget(ctx.workdir);
    if (basename(ctx.workdir) !== jobId) return host;
    let runs = 0;
    const crashing: ExecutionTarget = {
      kind: "host",
      workspacePath: host.workspacePath,
      provision: () => host.provision(),
      run: (cmd, runOpts) => {
        runs += 1;
        if (runs === crashAt) return Promise.reject(new Error("PLATFORM STOPPED mid-job (simulated)"));
        return host.run(cmd, runOpts);
      },
      dispose: opts.disposeThrows
        ? () => Promise.reject(new Error("vm.close() failed on an already-dead VM"))
        : () => host.dispose(),
    };
    return crashing;
  };
}

/** A raw SSE frame: the `event` name plus the undecoded `data:` payload. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Open an SSE stream at `url`, accumulate frames, and resolve once a `run-end`
 * frame arrives (or the timeout aborts the read). Skips `:` heartbeat comments and
 * is robust to `event:` / `event: ` spacing (it trims), so it parses every stream
 * the web server emits. Callers `JSON.parse` the `data` of whichever frame they
 * assert on. The single SSE reader behind the web tests.
 */
export async function collectSse(url: string, timeoutMs = 20_000): Promise<SseEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, { signal: controller.signal });
  if (res.status !== 200) throw new Error(`SSE ${url} → HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.startsWith(":")) continue; // heartbeat comment
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        events.push({ event, data });
        if (event === "run-end") {
          clearTimeout(timer);
          controller.abort();
          return events;
        }
      }
    }
  } catch (err) {
    // An abort after we saw run-end is expected; otherwise rethrow.
    if (!events.some((e) => e.event === "run-end")) throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

/** A parsed SSE frame: `data` JSON-decoded into an object. */
export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Like {@link collectSse} but JSON-decodes each frame's `data` (dataless frames are dropped). */
export async function collectSseFrames(url: string, timeoutMs = 20_000): Promise<SseFrame[]> {
  const events = await collectSse(url, timeoutMs);
  return events
    .filter((e) => e.data)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) as Record<string, unknown> }));
}

/** Drain an SSE stream until `run-end` (or timeout), discarding the frames. */
export async function awaitRunEnd(url: string, timeoutMs = 20_000): Promise<void> {
  await collectSse(url, timeoutMs);
}

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
export function useSharedRuntime(opts: { realTargets?: boolean; makeTarget?: TargetFactory } = {}): SharedRuntime {
  let engine: AbsurdEngine | undefined;
  before(async () => {
    engine = await createAbsurdEngine();
  });
  after(async () => {
    if (engine) await engine.close();
  });
  return {
    // Register the `work` handler (work/agent primitive + built-in actions) with
    // the mock runner (no inference) unless a test passes its own runner, plus the
    // action handler. A late-bound dispatcher routes a composite action's inner
    // `uses:` sub-steps by scheme — so e2e composite examples (and the migrated
    // agent review) dispatch work/agent / nested actions.
    run(plan, ctx, agentRunner = mockAgentRunner) {
      if (!engine) throw new Error("engine not started");
      const usesHandlers: UsesHandler[] = [];
      const dispatch: SubUsesDispatch = (subCtx) => {
        const h = usesHandlers.find((x) => x.scheme === subCtx.uses.split("/", 1)[0]);
        return h ? h.run(subCtx) : Promise.resolve({ status: "failure", stderr: `no handler for ${subCtx.uses}` });
      };
      usesHandlers.push(createWorkHandler({ runner: agentRunner, dispatch }), createActionUsesHandler({ dispatch }));
      return new AbsurdRuntime({
        engine,
        usesHandlers,
        // Mirror production egress: a job with a `uses:` step gets mediated egress
        // (allow-all). No config here (the agent runner is mocked), so no model key
        // is injected — but built-in network actions (work/checkout, work/install-node)
        // get the network they need.
        resolveJobNetwork: makeAgentEgressResolver(),
        // Mirror production image resolution so a `runs-on: work:<image>` example
        // boots the real custom image (only reached with real targets; the host
        // double ignores it).
        resolveImagePath: async (runsOn) => {
          const spec = parseRunsOn(runsOn);
          if (spec.namespace !== "work" || spec.variant === undefined) return undefined;
          return ensureImageTag(spec.variant, resolveImageConfig(spec.variant, ctx.workspaceSource));
        },
        ...(opts.makeTarget ? { makeTarget: opts.makeTarget } : opts.realTargets ? {} : { makeTarget: hostTargetFactory }),
      }).run(plan, ctx);
    },
  };
}
