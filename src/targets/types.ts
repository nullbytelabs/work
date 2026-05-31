/**
 * ExecutionTarget — the "where" layer (`runs-on`).
 *
 * A target is one job's isolated execution environment. The engine provisions
 * it, runs one or more step commands, then disposes it. Phase 1 ships only
 * LocalTarget; the same interface backs GondolinTarget (micro-VM) in Phase 2,
 * which is why `dispose()` exists and must always be called in a `finally`.
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
  /** Provision/boot the environment. */
  provision(): Promise<void>;
  /** Run a single step command, capturing output + exit code. */
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  /** Tear everything down. Must be idempotent / always safe to call. */
  dispose(): Promise<void>;
}
