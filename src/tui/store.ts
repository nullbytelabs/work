/**
 * RunStore — the presenter's mutable view of a run, driven by `RunHooks`.
 *
 * The runtime fires hooks keyed by `jobId` and interleaves them across jobs that
 * run at the same time, so live state can't be a stack of buffers — it's a map
 * the renderer reads on every repaint. Each hook mutates the keyed `JobState`
 * and bumps a revision so a renderer can cheaply tell whether anything changed.
 *
 * The store also keeps a per-job line log (step markers + streamed output) so the
 * presenter can "commit" a finished job's detail above the live board, the same
 * buffered block the non-TTY path prints.
 */
import type { ExecutionPlan } from "../compiler/index.ts";
import type { JobResult, StepResult } from "../runtime/types.ts";
import type { Levels } from "./levels.ts";

export type JobPhase = "pending" | "running" | "success" | "failure" | "skipped";

export interface JobState {
  id: string;
  runsOn: string;
  level: number;
  needs: string[];
  phase: JobPhase;
  totalSteps: number;
  doneSteps: number;
  /** Display name of the step currently running (undefined when none). */
  currentStep: string | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
  /** Buffered detail lines (step markers + output) for commit-on-end. */
  log: string[];
}

/** Strip the stable `<jobId>/` prefix from a step name for display. */
export function shortStep(name: string): string {
  const i = name.indexOf("/");
  return i >= 0 ? name.slice(i + 1) : name;
}

export class RunStore {
  readonly name: string;
  readonly states: Map<string, JobState>;
  /** Render order: by level, then id. */
  readonly order: string[];
  /** Stable step name -> human display name (the author `name:`). */
  private readonly titles: Map<string, string>;
  private rev: number;

  constructor(plan: ExecutionPlan, levels: Levels) {
    this.name = plan.name;
    this.rev = 0;
    this.states = new Map();
    this.titles = new Map();

    for (const id of plan.jobOrder) {
      const job = plan.jobs[id];
      if (!job) continue;
      for (const step of job.steps) {
        if (step.title) this.titles.set(step.name, step.title);
      }
      this.states.set(id, {
        id,
        runsOn: job.runsOn,
        level: levels.level.get(id) ?? 0,
        needs: job.needs,
        phase: "pending",
        totalSteps: job.steps.length,
        doneSteps: 0,
        currentStep: undefined,
        startedAt: undefined,
        endedAt: undefined,
        log: [],
      });
    }

    this.order = [...this.states.keys()].sort((a, b) => {
      const la = this.states.get(a)!.level;
      const lb = this.states.get(b)!.level;
      return la - lb || a.localeCompare(b);
    });
  }

  revision(): number {
    return this.rev;
  }

  onJobStart(id: string): void {
    const s = this.states.get(id);
    if (!s) return;
    s.phase = "running";
    s.startedAt = Date.now();
    this.rev++;
  }

  onStepStart(id: string, stepName: string): void {
    const s = this.states.get(id);
    if (!s) return;
    const label = this.titles.get(stepName) ?? shortStep(stepName);
    s.currentStep = label;
    s.log.push(`> ${label}`);
    this.rev++;
  }

  onOutput(id: string, _stepName: string, chunk: { stream: "stdout" | "stderr"; text: string }): void {
    const s = this.states.get(id);
    if (!s) return;
    const prefix = chunk.stream === "stderr" ? "  ! " : "    ";
    for (const line of chunk.text.replace(/\n$/, "").split("\n")) s.log.push(`${prefix}${line}`);
    this.rev++;
  }

  onStepEnd(id: string, step: StepResult): void {
    const s = this.states.get(id);
    if (!s) return;
    s.doneSteps++;
    s.currentStep = undefined;
    const mark = step.status === "success" ? "ok" : step.status;
    s.log.push(`  (${mark}, exit ${step.exitCode})`);
    this.rev++;
  }

  onJobEnd(id: string, result: JobResult): void {
    const s = this.states.get(id);
    if (!s) return;
    s.phase = result.status;
    s.endedAt = Date.now();
    s.currentStep = undefined;
    this.rev++;
  }

  snapshot(): JobState[] {
    return this.order.map((id) => this.states.get(id)!);
  }
}
