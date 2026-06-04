/**
 * `WebPresenter` — a third `Presenter` (alongside the TUI's buffered/layered
 * ones) that turns the runtime's `RunHooks` into SSE frames for the browser.
 *
 * It is a *pure translator*: the hook callbacks build frame objects and hand
 * them to an `emit` sink (the `RunManager` broadcasts them to the run's SSE
 * subscribers). It holds no transport — that keeps it testable and lets the
 * manager own buffering/replay. The frame protocol is the one in
 * docs/web-ui-research.md §5; the `run-init` frame seeds the DAG and every other
 * frame maps 1:1 onto a hook.
 *
 * Hook payloads carry no timestamps, so — exactly as the TUI's `RunStore` does —
 * we stamp `Date.now()` on each frame at emit time; per-step durations are
 * derived client-side, not provided.
 */
import type { ExecutionPlan } from "../compiler/index.ts";
import type { JobResult, RunHooks, StepResult, WorkflowResult } from "../runtime/index.ts";
import type { Presenter } from "../tui/presenter.ts";
import { emitGraph } from "../graph/index.ts";

/** One SSE frame: an `event:` name + a JSON `data` object. */
export interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** The shape `emitGraph(plan,"json",{steps:true})` yields per job, reshaped for the client. */
interface GraphStep {
  name: string;
  title: string;
  kind: "run" | "uses";
  uses?: string;
}
interface GraphJob {
  runsOn: string;
  needs: string[];
  level: number;
  steps: GraphStep[];
}

/** Raw `stepList` entry from the graph JSON (pre-reshape). */
interface RawStep {
  name: string;
  kind: "run" | "uses";
  uses?: string;
  id?: string;
}

export class WebPresenter implements Presenter {
  readonly hooks: RunHooks;
  private readonly runId: string;
  private readonly emit: (frame: Frame) => void;

  constructor(runId: string, emit: (frame: Frame) => void) {
    this.runId = runId;
    this.emit = emit;
    this.hooks = {
      onJobStart: (jobId) => this.push("job-start", { jobId }),
      onStepStart: (jobId, stepName) => this.push("step-start", { jobId, stepName, title: stepName }),
      onOutput: (jobId, stepName, chunk) =>
        this.push("step-output", { jobId, stepName, stream: chunk.stream, text: chunk.text }),
      // Drop the bulk stdout/stderr — it was already streamed via step-output.
      onStepEnd: (jobId, step: StepResult) =>
        this.push("step-end", { jobId, stepName: step.name, status: step.status, exitCode: step.exitCode }),
      onJobEnd: (jobId, result: JobResult) => this.push("job-end", { jobId, status: result.status }),
    };
  }

  /** Seed the DAG: the `emitGraph` JSON reshaped (stepList → steps) + initial status. */
  start(plan: ExecutionPlan): void {
    const graph = JSON.parse(emitGraph(plan, "json", { steps: true })) as {
      name: string;
      jobOrder: string[];
      jobs: Record<string, { runsOn: string; needs: string[]; level: number; stepList?: RawStep[] }>;
    };

    const jobs: Record<string, GraphJob> = {};
    for (const [id, j] of Object.entries(graph.jobs)) {
      jobs[id] = {
        runsOn: j.runsOn,
        needs: j.needs,
        level: j.level,
        // The graph emitter's step `name` is the human label; use it as the title too.
        steps: (j.stepList ?? []).map((s) => ({
          name: s.name,
          title: s.name,
          kind: s.kind,
          ...(s.uses !== undefined ? { uses: s.uses } : {}),
        })),
      };
    }

    this.push("run-init", { name: graph.name, jobOrder: graph.jobOrder, jobs, status: "running" });
  }

  /** Final frame: the run's overall status. */
  finish(result: WorkflowResult): void {
    this.push("run-end", { status: result.status });
  }

  private push(event: string, data: Record<string, unknown>): void {
    this.emit({ event, data: { runId: this.runId, ts: Date.now(), ...data } });
  }
}
