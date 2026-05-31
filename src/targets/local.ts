/**
 * LocalTarget — runs steps as host child processes.
 *
 * Fast, no isolation. Intended for trusted steps and local dev (and Phase 1,
 * where it is the only target). Commands run via `/bin/bash -lc` so that shell
 * features used in workflows (`$VARS`, pipes, redirects) behave as authors
 * expect — matching the README's hello-world `echo $HELLO_WORLD`.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { ExecutionTarget, RunOptions, RunResult } from "./types.ts";

export class LocalTarget implements ExecutionTarget {
  readonly kind = "local";
  private readonly workdir: string;

  constructor(workdir: string) {
    this.workdir = workdir;
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
      const timer = opts.timeoutMs
        ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
        : undefined;

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
    /* Local target holds no resources to release. */
  }
}
