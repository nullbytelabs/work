/**
 * Vendored semantic-convention attribute keys.
 *
 * The OTel conventions we lean on are not all stable: `cicd.*` is Release-Candidate
 * and `gen_ai.*` is Development (and lives in a separate repo that tracks `main`).
 * Rather than pin `@opentelemetry/semantic-conventions` and chase renames across the
 * codebase, we vendor the exact keys we emit here — so an upstream rename is a
 * one-file change (docs/observability-otel-metrics.md §12). Stable keys (`error.type`)
 * are vendored too for one consistent source.
 */
export const ATTR = {
  // CI/CD pipeline (RC) — workflow = pipeline, job = task.
  CICD_PIPELINE_NAME: "cicd.pipeline.name",
  CICD_PIPELINE_RUN_ID: "cicd.pipeline.run.id",
  CICD_PIPELINE_RESULT: "cicd.pipeline.result",
  CICD_TASK_NAME: "cicd.pipeline.task.name",
  CICD_TASK_RUN_ID: "cicd.pipeline.task.run.id",
  CICD_TASK_RESULT: "cicd.pipeline.task.run.result",

  // Engine domain (app-scoped `work.*`).
  WORK_RUN_ID: "work.run.id",
  WORK_WORKFLOW_NAME: "work.workflow.name",
  WORK_JOB_NAME: "work.job.name",
  WORK_STEP_NAME: "work.step.name",
  WORK_STEP_KIND: "work.step.kind",
  WORK_STEP_USES: "work.step.uses",
  WORK_STEP_RESULT: "work.step.result",
  WORK_RUN_RESUMED: "work.run.resumed",
  WORK_JOB_PHASE: "work.job.phase",
  // Agent step time split — setup (staging + in-guest Pi install) vs the agent loop.
  WORK_AGENT_SETUP_MS: "work.agent.setup_ms",
  WORK_AGENT_RUN_MS: "work.agent.run_ms",

  // Host / micro-VM image (a VM is a host, not a container).
  HOST_IMAGE_NAME: "host.image.name",
  HOST_ARCH: "host.arch",

  // GenAI (Development). NB the current names: provider.name (not the deprecated
  // gen_ai.system) and usage.input_tokens/output_tokens (not prompt/completion).
  GEN_AI_OPERATION_NAME: "gen_ai.operation.name",
  GEN_AI_PROVIDER_NAME: "gen_ai.provider.name",
  GEN_AI_REQUEST_MODEL: "gen_ai.request.model",
  GEN_AI_USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  GEN_AI_USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  GEN_AI_USAGE_CACHE_READ: "gen_ai.usage.cache_read.input_tokens",
  GEN_AI_USAGE_CACHE_CREATION: "gen_ai.usage.cache_creation.input_tokens",

  // Errors (Stable).
  ERROR_TYPE: "error.type",
} as const;

/** GenAI provider value for Claude. */
export const GEN_AI_PROVIDER_ANTHROPIC = "anthropic";

/** Map a run-level status onto the `cicd.pipeline.result` vocabulary. */
export function runResult(status: "success" | "failure" | "interrupted"): string {
  return status === "interrupted" ? "cancellation" : status;
}

/** Map a job/step status onto the `cicd.pipeline.task.run.result` vocabulary. */
export function taskResult(status: "success" | "failure" | "skipped"): string {
  return status === "skipped" ? "skip" : status;
}
