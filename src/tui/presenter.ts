/**
 * Presenters turn the runtime's `RunHooks` into terminal output. The CLI builds
 * one, hands its `hooks` to the runtime, and calls `start`/`finish` around the
 * run — it knows nothing about TTY vs CI vs quiet. `selectPresenter` picks:
 *
 *   quiet              -> NullPresenter     (no output)
 *   not a TTY, or CI   -> BufferedPresenter (per-job buffer, flush on completion)
 *   interactive TTY    -> LayeredPresenter  (live DAG-aware status board)
 *
 * The buffered path is the durable default and the behaviour the live board
 * degrades to; the layered board is strictly the interactive enhancement layered
 * on top. No engine changes — both are pure consumers of the hooks.
 */
import type { ExecutionPlan } from "../compiler/index.ts";
import type { JobResult, RunHooks, StepResult, WorkflowResult } from "../runtime/types.ts";
import { levelize } from "./levels.ts";
import { RunStore, type JobState } from "./store.ts";
import { renderBoard } from "./render.ts";

export interface Presenter {
  /** Hooks handed to the runtime (`undefined` to disable output entirely). */
  readonly hooks: RunHooks | undefined;
  start(plan: ExecutionPlan): void;
  finish(result: WorkflowResult): void;
}

export interface SelectOptions {
  out: NodeJS.WriteStream;
  quiet: boolean;
  isTTY: boolean;
  isCI: boolean;
}

/** Heuristic CI detection (matches the common `is-in-ci` set). */
export function detectCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env["CI"] ||
      env["CONTINUOUS_INTEGRATION"] ||
      env["GITHUB_ACTIONS"] ||
      env["BUILDKITE"] ||
      env["GITLAB_CI"] ||
      env["CIRCLECI"],
  );
}

export function selectPresenter(opts: SelectOptions): Presenter {
  // Explicit override for testing / forcing a mode: PI_WORKFLOWS_TUI=1|0.
  const override = process.env["PI_WORKFLOWS_TUI"];
  if (opts.quiet) return new NullPresenter();
  const wantLayered = override === "1" || (override !== "0" && opts.isTTY && !opts.isCI);
  return wantLayered ? new LayeredPresenter(opts.out) : new BufferedPresenter(opts.out, opts.isCI);
}

/** No output (the `--quiet` path). */
export class NullPresenter implements Presenter {
  readonly hooks = undefined;
  start(): void {}
  finish(): void {}
}

/**
 * The non-TTY/CI default: buffer each job's lines and flush the whole block
 * atomically on completion so parallel jobs stay contiguous instead of
 * interleaved. In CI, wrap each block in `::group::`/`::endgroup::` so
 * GitHub/Buildkite collapse it.
 */
export class BufferedPresenter implements Presenter {
  readonly hooks: RunHooks;
  private readonly out: NodeJS.WriteStream;
  private readonly ci: boolean;
  private readonly buffers = new Map<string, string[]>();
  /** Stable step name -> author `name:`, populated in start(). */
  private readonly titles = new Map<string, string>();

  constructor(out: NodeJS.WriteStream, ci: boolean) {
    this.out = out;
    this.ci = ci;
    this.hooks = {
      onJobStart: (jobId) => void this.lines(jobId),
      onStepStart: (jobId, stepName) => this.lines(jobId).push(`  > ${this.titles.get(stepName) ?? stepName}`),
      onOutput: (jobId, _stepName, chunk) => {
        const prefix = chunk.stream === "stderr" ? "    ! " : "    ";
        for (const line of chunk.text.replace(/\n$/, "").split("\n")) this.lines(jobId).push(`${prefix}${line}`);
      },
      onStepEnd: (jobId, step: StepResult) => {
        const mark = step.status === "success" ? "ok" : step.status;
        this.lines(jobId).push(`    (${mark}, exit ${step.exitCode})`);
      },
      onJobEnd: (jobId, _result: JobResult) => {
        const b = this.buffers.get(jobId);
        if (!b) return;
        if (this.ci) {
          this.out.write(`::group::job: ${jobId}\n${b.join("\n")}\n::endgroup::\n`);
        } else {
          this.out.write(`\n${b.join("\n")}\n`);
        }
        this.buffers.delete(jobId);
      },
    };
  }

  private lines(jobId: string): string[] {
    let b = this.buffers.get(jobId);
    if (!b) {
      b = [`[job: ${jobId}]`];
      this.buffers.set(jobId, b);
    }
    return b;
  }

  start(plan: ExecutionPlan): void {
    for (const job of Object.values(plan.jobs)) {
      for (const step of job.steps) {
        if (step.title) this.titles.set(step.name, step.title);
      }
    }
    this.out.write(`workflow: ${plan.name}\n`);
  }

  finish(result: WorkflowResult): void {
    this.out.write(`\nresult: ${result.status}\n`);
  }
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FPS_MS = 80;

/**
 * The interactive board: an in-place-redrawn status list keyed by job, with the
 * DAG shown as indentation. A finished job's detailed log is "committed" to
 * native scrollback above the live region (the sticky-status + scrollback
 * pattern), so completed output scrolls up while the board stays pinned below.
 */
export class LayeredPresenter implements Presenter {
  readonly hooks: RunHooks;
  private readonly out: NodeJS.WriteStream;
  private store: RunStore | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private spin = 0;
  private liveLines = 0;

  constructor(out: NodeJS.WriteStream) {
    this.out = out;
    this.hooks = {
      onJobStart: (id) => this.store?.onJobStart(id),
      onStepStart: (id, name) => this.store?.onStepStart(id, name),
      onOutput: (id, name, chunk) => this.store?.onOutput(id, name, chunk),
      onStepEnd: (id, step) => this.store?.onStepEnd(id, step),
      onJobEnd: (id, result) => {
        const s = this.store?.states.get(id);
        this.store?.onJobEnd(id, result);
        if (s) this.commit(s);
      },
    };
  }

  start(plan: ExecutionPlan): void {
    this.store = new RunStore(plan, levelize(plan));
    if (this.out.write("\x1b[?25l")) { /* hide cursor */ }
    this.paint(false);
    this.timer = setInterval(() => {
      this.spin = (this.spin + 1) % SPINNER.length;
      this.paint(false);
    }, FPS_MS);
    this.timer.unref?.();
  }

  finish(result: WorkflowResult): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.paint(true);
    this.out.write("\x1b[?25h"); // show cursor
    this.out.write(`\n${result.status === "success" ? "✓" : "✗"} result: ${result.status}\n`);
  }

  private width(): number {
    return this.out.columns && this.out.columns > 0 ? this.out.columns : 80;
  }

  private clearLive(): void {
    if (this.liveLines > 0) {
      this.out.write(`\x1b[${this.liveLines}A\x1b[0J`);
      this.liveLines = 0;
    }
  }

  private paint(final: boolean): void {
    if (!this.store) return;
    const frame = renderBoard(this.store.name, this.store.snapshot(), {
      color: true,
      spinner: SPINNER[this.spin]!,
      width: this.width(),
      now: Date.now(),
      final,
    });
    this.clearLive();
    this.out.write(`${frame.join("\n")}\n`);
    this.liveLines = frame.length;
  }

  /** Push a finished job's detail block to permanent scrollback above the board. */
  private commit(s: JobState): void {
    const status = s.phase;
    const glyph = status === "success" ? "✓" : status === "failure" ? "✗" : status === "skipped" ? "⊘" : "•";
    const block = [`\x1b[1m[job: ${s.id}]\x1b[0m ${glyph} ${status}`, ...s.log.map((l) => `  ${l}`)];
    this.clearLive();
    this.out.write(`${block.join("\n")}\n`);
    this.paint(false);
  }
}
