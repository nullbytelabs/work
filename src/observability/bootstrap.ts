/**
 * Lazy, opt-in OpenTelemetry SDK bootstrap.
 *
 * `startTelemetry` is the production seam: when telemetry is enabled it dynamically
 * imports the OTel SDK (an `optionalDependency`, so users who don't opt in never load
 * it), starts a `NodeSDK` that pushes OTLP — traces *and* metrics — to a single
 * collector endpoint (Grafana Alloy → Tempo + Prometheus), and returns the emitter
 * hooks plus a `shutdown` that flushes before exit. When disabled it returns
 * `undefined` and nothing is imported — the engine pays nothing (§7).
 *
 * The live OTLP export path is validated against a collector in the e2e tier (the
 * Layer 5/6 tests in docs/observability-otel-metrics.md §11); this module's unit
 * coverage is the enable/endpoint resolution (`resolveTelemetry`).
 */
import type { Tracer, Meter } from "@opentelemetry/api";
import { expandEnvStrict, type ObservabilityConfig } from "../config/index.ts";

/**
 * A started SDK, shared for a process's lifetime. It is NOT the hook consumer — the
 * tracer/meter are concurrency-safe and shared, but the emitter (`createTelemetryHooks`)
 * holds per-run span state, so a fresh emitter is built per run from this handle. The
 * web/serve process starts one handle at boot and injects it into every run; a one-shot
 * CLI run starts and shuts down its own.
 */
export interface TelemetryHandle {
  tracer: Tracer;
  meter: Meter;
  /** Flush + shut down the SDK. Awaited at process/run exit so spans export first. */
  shutdown(): Promise<void>;
}

/** Duration histogram buckets (seconds), spanning sub-second steps to multi-minute jobs (§5.4). */
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];

const DEFAULT_ENDPOINT = "http://localhost:4318";
const DEFAULT_METRIC_INTERVAL_MS = 15_000;

/** The resolved enable/endpoint decision: explicit config wins, else the standard
 *  `OTEL_EXPORTER_OTLP_ENDPOINT` env turns it on, else off. */
export interface ResolvedTelemetry {
  enabled: boolean;
  endpoint: string;
  metricIntervalMs: number;
  traces: boolean;
  metrics: boolean;
  /** OTLP export headers, with `$VAR` already expanded. Absent → exporters fall back
   *  to the standard `OTEL_EXPORTER_OTLP_HEADERS` env var. */
  headers?: Record<string, string>;
}

export function resolveTelemetry(
  config: ObservabilityConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTelemetry {
  const envEndpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const enabled = config?.enabled ?? envEndpoint !== undefined;
  const base: ResolvedTelemetry = {
    enabled,
    endpoint: config?.otlpEndpoint ?? envEndpoint ?? DEFAULT_ENDPOINT,
    metricIntervalMs: config?.metricExportIntervalMs ?? DEFAULT_METRIC_INTERVAL_MS,
    traces: config?.traces?.enabled ?? true,
    metrics: config?.metrics?.enabled ?? true,
  };
  // Expand header secrets only when we'll actually export (so a disabled config with a
  // placeholder header never throws on an unset var).
  if (!enabled || !config?.headers) return base;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.headers)) headers[k] = expandEnvStrict(v, `observability.headers.${k}`);
  return { ...base, headers };
}

/**
 * Start the SDK if enabled and return the emitter hooks + a shutdown; otherwise
 * `undefined`. The SDK packages are imported lazily so a disabled run never loads them.
 */
export async function startTelemetry(
  config: ObservabilityConfig | undefined,
  serviceVersion: string,
): Promise<TelemetryHandle | undefined> {
  const resolved = resolveTelemetry(config);
  if (!resolved.enabled) return undefined;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto");
  const { PeriodicExportingMetricReader, AggregationType } = await import("@opentelemetry/sdk-metrics");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import("@opentelemetry/semantic-conventions");
  const { trace, metrics } = await import("@opentelemetry/api");

  const headers = resolved.headers;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "work", [ATTR_SERVICE_VERSION]: serviceVersion }),
    ...(resolved.traces
      ? { traceExporter: new OTLPTraceExporter({ url: `${resolved.endpoint}/v1/traces`, ...(headers ? { headers } : {}) }) }
      : {}),
    ...(resolved.metrics
      ? {
          metricReaders: [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({ url: `${resolved.endpoint}/v1/metrics`, ...(headers ? { headers } : {}) }),
              exportIntervalMillis: resolved.metricIntervalMs,
            }),
          ],
        }
      : {}),
    views: [
      {
        instrumentName: "work.*.duration",
        aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS } },
      },
    ],
  });
  sdk.start();

  return {
    tracer: trace.getTracer("work", serviceVersion),
    meter: metrics.getMeter("work", serviceVersion),
    async shutdown() {
      await sdk.shutdown();
    },
  };
}
