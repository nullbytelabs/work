/**
 * GondolinTarget — runs a job's steps inside a hardware-virtualized micro-VM
 * (`runs-on: gondolin`, the secure target).
 *
 * Backed by `@earendil-works/gondolin` (QEMU by default). That package is an
 * OPTIONAL dependency: it requires Node >= 23.6 and a host QEMU install, and
 * ships platform-specific runner binaries. To keep the engine importable and
 * the test suite working everywhere, Gondolin is loaded
 * **lazily** inside `provision()` via dynamic import — nothing here is touched
 * unless a workflow actually declares `runs-on: gondolin`.
 *
 * Mapping to the documented SDK (docs/gondolin-secure-execution.md):
 *   provision -> VM.create({ memory, cpus, env, vfs, httpHooks? })
 *   run       -> vm.exec(["/bin/sh","-lc",cmd], { cwd, env, signal })
 *   dispose   -> vm.close()   (REQUIRED, or the QEMU process leaks)
 */
import { mkdir } from "node:fs/promises";
import { UserFacingError } from "../errors.ts";
import { MACHINE_TYPES, DEFAULT_MACHINE, type ResolvedMachine } from "../compiler/index.ts";
import type { ExecutionTarget, RunOptions, RunResult } from "./types.ts";

/** The guest path the per-job working directory is mounted at. */
const GUEST_WORKSPACE = "/workspace";

// Applied when a caller provisions a VM without an explicit machine (e.g. a
// direct makeTarget call). Compiled jobs always carry a resolved machine, so in
// the normal run path this fallback is never hit.
const DEFAULT_GONDOLIN_MACHINE: ResolvedMachine = MACHINE_TYPES[DEFAULT_MACHINE]!;

/**
 * Minimal structural shapes for the bits of the Gondolin SDK we use. We model
 * these locally (rather than importing the package's types) so `tsc` succeeds
 * even when the optional dependency is not installed.
 */
interface GExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface GExecProcess extends Promise<GExecResult> {
  output(): AsyncIterable<{ stream: "stdout" | "stderr"; text: string }>;
}
interface GVM {
  exec(argv: string[], opts?: Record<string, unknown>): GExecProcess;
  close(): Promise<void>;
}

export interface GondolinTargetConfig {
  /** Host directory mounted read-write at /workspace inside the guest. */
  workdir: string;
  /** Machine sizing (cpus/memory) for the VM; defaults to the catalog default. */
  machine?: ResolvedMachine;
  /** Non-secret env applied to the VM (steps also pass their own per-run env). */
  env?: Record<string, string>;
  /** Outbound HTTP allowlist (deny-by-default otherwise). */
  allowedHosts?: string[];
  /** Secrets injected into outbound HTTP headers only; never visible in-guest. */
  secrets?: Record<string, { hosts: string[]; value: string }>;
}

/**
 * Build the argv for a step command. Uses `/bin/sh -lc` for portability — `sh`
 * is the lowest common denominator and is always present — so `$VARS`, pipes,
 * and `${VAR}` expansion behave as workflow authors expect. (The guest also
 * ships bash/node/python3, but steps shouldn't have to assume that.) Exported
 * for tests.
 */
export function buildExecArgs(command: string): string[] {
  return ["/bin/sh", "-lc", command];
}

/** Lazily import the optional Gondolin SDK with an actionable error if absent. */
async function loadGondolin(): Promise<Record<string, unknown>> {
  const specifier = "@earendil-works/gondolin";
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    throw new UserFacingError(
      `runs-on: gondolin requires the optional dependency "${specifier}" ` +
        "(Node >= 23.6 and QEMU installed). Install it with:\n" +
        "  npm install @earendil-works/gondolin\n" +
        `underlying error: ${(err as Error).message}`,
    );
  }
}

export class GondolinTarget implements ExecutionTarget {
  readonly kind = "gondolin";
  /** The job workdir is mounted into the guest here, so $WORK_OUTPUT lives under it. */
  readonly workspacePath = GUEST_WORKSPACE;
  private readonly cfg: GondolinTargetConfig;
  private vm: GVM | null = null;

  constructor(cfg: GondolinTargetConfig) {
    this.cfg = cfg;
  }

  async provision(): Promise<void> {
    const g = await loadGondolin();
    const VM = g["VM"] as { create(opts?: Record<string, unknown>): Promise<GVM> };
    const RealFSProvider = g["RealFSProvider"] as new (hostDir: string) => unknown;
    const createHttpHooks = g["createHttpHooks"] as
      | ((opts: Record<string, unknown>) => { httpHooks: unknown; env: Record<string, string> })
      | undefined;

    await mkdir(this.cfg.workdir, { recursive: true });

    const machine = this.cfg.machine ?? DEFAULT_GONDOLIN_MACHINE;
    const createOpts: Record<string, unknown> = {
      memory: machine.memory,
      cpus: machine.cpus,
      vfs: { mounts: { [GUEST_WORKSPACE]: new RealFSProvider(this.cfg.workdir) } },
    };

    // Only mediate network when something is configured; otherwise the default
    // deny-by-default posture applies (fine for steps that need no network).
    let secretEnv: Record<string, string> = {};
    const wantsNetwork = (this.cfg.allowedHosts?.length ?? 0) > 0 || this.cfg.secrets !== undefined;
    if (wantsNetwork && createHttpHooks) {
      const { httpHooks, env } = createHttpHooks({
        allowedHosts: this.cfg.allowedHosts ?? [],
        secrets: this.cfg.secrets ?? {},
      });
      createOpts["httpHooks"] = httpHooks;
      secretEnv = env;
    }
    createOpts["env"] = { ...secretEnv, ...(this.cfg.env ?? {}) };

    try {
      this.vm = await VM.create(createOpts);
    } catch (err) {
      throw new UserFacingError(
        "failed to provision the gondolin micro-VM: " +
          (err as Error).message +
          "\nCheck that QEMU is installed (`brew install qemu`) and that the guest " +
          "image can be downloaded on first run (~200MB, requires network).",
      );
    }
  }

  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    if (!this.vm) throw new Error("GondolinTarget.run called before provision()");

    const streaming = Boolean(opts.onOutput);
    const execOpts: Record<string, unknown> = {
      cwd: opts.cwd ?? GUEST_WORKSPACE,
      env: opts.env,
      signal: opts.signal,
    };
    // In "pipe" mode Gondolin does not also buffer into the final result, so we
    // accumulate stdout/stderr ourselves while forwarding chunks live.
    if (streaming) {
      execOpts["stdout"] = "pipe";
      execOpts["stderr"] = "pipe";
    }

    const proc = this.vm.exec(buildExecArgs(command), execOpts);

    let stdout = "";
    let stderr = "";
    if (streaming) {
      for await (const { stream, text } of proc.output()) {
        if (stream === "stdout") stdout += text;
        else stderr += text;
        opts.onOutput?.({ stream, text });
      }
    }

    const r = await proc;
    if (!streaming) {
      stdout = r.stdout;
      stderr = r.stderr;
    }
    return { exitCode: r.exitCode, stdout, stderr, ok: r.exitCode === 0 };
  }

  async dispose(): Promise<void> {
    if (this.vm) {
      const vm = this.vm;
      this.vm = null;
      await vm.close();
    }
  }
}
