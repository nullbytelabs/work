/**
 * Fan one run's lifecycle events out to several `RunHooks` consumers — e.g. the
 * presenter (TUI/SSE) and the telemetry emitter. Each event is forwarded to every
 * consumer that implements it, in order. Undefined consumers are skipped, so callers
 * can pass an optional presenter alongside the emitter without guarding.
 */
import type { RunHooks } from "../runtime/types.ts";

export function combineRunHooks(...consumers: (RunHooks | undefined)[]): RunHooks {
  const hs = consumers.filter((h): h is RunHooks => h !== undefined);
  return {
    onWorkflowStart: (meta) => hs.forEach((h) => h.onWorkflowStart?.(meta)),
    onJobStart: (jobId, meta) => hs.forEach((h) => h.onJobStart?.(jobId, meta)),
    onStepStart: (jobId, stepName, meta) => hs.forEach((h) => h.onStepStart?.(jobId, stepName, meta)),
    onOutput: (jobId, stepName, chunk) => hs.forEach((h) => h.onOutput?.(jobId, stepName, chunk)),
    onStepEnd: (jobId, result) => hs.forEach((h) => h.onStepEnd?.(jobId, result)),
    onJobEnd: (jobId, result) => hs.forEach((h) => h.onJobEnd?.(jobId, result)),
    onWorkflowEnd: (result) => hs.forEach((h) => h.onWorkflowEnd?.(result)),
  };
}
