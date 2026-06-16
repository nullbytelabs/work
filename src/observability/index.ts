/**
 * Observability — OpenTelemetry traces + metrics for workflow runs.
 *
 * - `createTelemetryHooks` — the **emitter**, a `RunHooks` consumer mapping run
 *   lifecycle events onto spans/metrics against an injected tracer/meter (the
 *   unit-testable heart).
 * - `startTelemetry` — the lazy, opt-in SDK **bootstrap** (global provider + OTLP
 *   push to Alloy), returning the emitter hooks + a flush/shutdown.
 * - `combineRunHooks` — fan run events out to the presenter *and* the emitter.
 *
 * See docs/observability-otel-metrics.md.
 */
export { createTelemetryHooks, type TelemetryOptions } from "./emitter.ts";
export { startTelemetry, resolveTelemetry, type TelemetryHandle, type ResolvedTelemetry } from "./bootstrap.ts";
export { combineRunHooks } from "./combine.ts";
export { ATTR } from "./semconv.ts";
