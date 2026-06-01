/**
 * ExecutionTarget — the "where" layer (`runs-on`).
 *
 * A target is one job's isolated execution environment. The engine provisions
 * it, runs one or more step commands, then disposes it. Two targets back this
 * interface — LocalTarget (host process) and GondolinTarget (micro-VM) — which
 * is why `dispose()` exists and must always be called in a `finally`.
 *
 * This mirrors the interface sketched in docs/gondolin-secure-execution.md so
 * the Gondolin implementation drops in without changing the runtime.
 */

export interface RunOptions {
  /** Working directory inside the target. */
  cwd?: string;
  /** Environment variables for this command. */
  env?: Record<string, string>;
  /** Cancellation. */
  signal?: AbortSignal;
  /** Wall-clock timeout in ms. */
  timeoutMs?: number;
  /** Live output callback (stdout/stderr interleaved as produced). */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export interface ExecutionTarget {
  /** Identifier for diagnostics, e.g. "local". */
  readonly kind: string;
  /**
   * The staged per-job workspace path **as a run command sees it** — the host
   * working directory for `local`, the guest mount (`/workspace`) for
   * `gondolin`. The runtime places files a step writes and the host later reads
   * (e.g. `$PI_OUTPUT`) under this path, so output capture works on every target
   * regardless of how the host directory is surfaced inside the environment.
   */
  readonly workspacePath: string;
  /** Provision/boot the environment. */
  provision(): Promise<void>;
  /** Run a single step command, capturing output + exit code. */
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  /** Tear everything down. Must be idempotent / always safe to call. */
  dispose(): Promise<void>;
}
