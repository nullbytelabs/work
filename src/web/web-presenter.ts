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
  // Stable step name (`<job>/<id-or-index>`, the runtime's checkpoint key and the
  // client's correlation key) -> the author's human `name:`. The hooks only carry
  // the stable name, so we resolve the display label here, populated from the plan
  // in `start()` (which runs before any step hook fires).
  private readonly stepTitles = new Map<string, string>();

  constructor(runId: string, emit: (frame: Frame) => void) {
    this.runId = runId;
    this.emit = emit;
    const titleOf = (stepName: string): string => this.stepTitles.get(stepName) ?? stepName;
    this.hooks = {
      onJobStart: (jobId) => this.push("job-start", { jobId }),
      onStepStart: (jobId, stepName) => this.push("step-start", { jobId, stepName, title: titleOf(stepName) }),
      onOutput: (jobId, stepName, chunk) =>
        this.push("step-output", { jobId, stepName, title: titleOf(stepName), stream: chunk.stream, text: chunk.text }),
      // Drop the bulk stdout/stderr — it was already streamed via step-output.
      onStepEnd: (jobId, step: StepResult) =>
        this.push("step-end", { jobId, stepName: step.name, title: titleOf(step.name), status: step.status, exitCode: step.exitCode }),
      onJobEnd: (jobId, result: JobResult) => this.push("job-end", { jobId, status: result.status }),
    };
  }

  /**
   * Seed the DAG: `emitGraph` JSON supplies the job layout (runsOn/needs/level);
   * the steps come straight from the plan so each carries its **stable name** (the
   * key the live step frames use) alongside its human **title**. Also builds the
   * `stepTitles` lookup the step hooks resolve display labels through.
   */
  start(plan: ExecutionPlan): void {
    const graph = JSON.parse(emitGraph(plan, "json", { steps: true })) as {
      name: string;
      jobOrder: string[];
      jobs: Record<string, { runsOn: string; needs: string[]; level: number; stepList?: RawStep[] }>;
    };

    const jobs: Record<string, GraphJob> = {};
    for (const [id, j] of Object.entries(graph.jobs)) {
      // Steps from the plan: `name` is the stable `<job>/<id-or-index>` checkpoint
      // key (== the live frames' `stepName`); `title` is the author's `name:`.
      const steps: GraphStep[] = (plan.jobs[id]?.steps ?? []).map((s) => {
        const title = s.title ?? s.name;
        this.stepTitles.set(s.name, title);
        return {
          name: s.name,
          title,
          kind: s.uses !== undefined ? ("uses" as const) : ("run" as const),
          ...(s.uses !== undefined ? { uses: s.uses } : {}),
        };
      });
      jobs[id] = { runsOn: j.runsOn, needs: j.needs, level: j.level, steps };
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
