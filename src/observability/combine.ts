/**
 * Fan one run's lifecycle events out to several `RunHooks` consumers — e.g. the
 * presenter (TUI/SSE) and the telemetry emitter. Each event is forwarded to every
 * consumer that implements it, in order. Undefined consumers are skipped, so callers
 * can pass an optional presenter alongside the emitter without guarding.
 */
import type { RunHooks } from "../runtime/types.ts";

export function combineRunHooks(...consumers: (RunHooks | undefined)[]): RunHooks {
  const hs = consumers.filter((h): h is RunHooks => h !== undefined);
  // Isolate each consumer: a presenter or the telemetry emitter throwing in a hook
  // must never abort the other consumers or the run itself — hooks are fire-and-forget
  // side effects, and telemetry in particular must never take down a workflow. A
  // thrown error is swallowed per call so one bad consumer can't starve the rest.
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* a hook consumer's failure is non-fatal to the run */
    }
  };
  return {
    onWorkflowStart: (meta) => hs.forEach((h) => guard(() => h.onWorkflowStart?.(meta))),
    onJobStart: (jobId, meta) => hs.forEach((h) => guard(() => h.onJobStart?.(jobId, meta))),
    onStepStart: (jobId, stepName, meta) => hs.forEach((h) => guard(() => h.onStepStart?.(jobId, stepName, meta))),
    onOutput: (jobId, stepName, chunk) => hs.forEach((h) => guard(() => h.onOutput?.(jobId, stepName, chunk))),
    onStepEnd: (jobId, result) => hs.forEach((h) => guard(() => h.onStepEnd?.(jobId, result))),
    onJobEnd: (jobId, result) => hs.forEach((h) => guard(() => h.onJobEnd?.(jobId, result))),
    onWorkflowEnd: (result) => hs.forEach((h) => guard(() => h.onWorkflowEnd?.(result))),
  };
}
