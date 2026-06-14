/**
 * Per-job sandbox egress for `uses:` steps.
 *
 * Gondolin is deny-by-default, but a non-`run` `uses:` step almost always needs
 * the network: the `work/agent` primitive (and any composite action wrapping it)
 * reaches the model; a JS action `npm install`s; `work/checkout`/`work/install-node`
 * fetch from a git/download host. So a job containing **any** `work/*` or
 * `action/*` step is granted mediated allow-all egress.
 *
 * When a model is configured, each model host the job touches gets its own
 * header-only secret, injected under a per-host env-var name (`modelKeyEnv`) and
 * scoped to that one host — so the **real key never enters the guest** (Gondolin
 * swaps the placeholder into the Authorization header for that host only, and
 * blocks it if sent elsewhere) and is harmless for a job that never calls the
 * model. A job with two `work/agent` steps on different providers therefore gets
 * two distinct host-scoped keys, each read by the step that needs it. A composite
 * `action/<name>` may wrap `work/agent` without the resolver being able to see
 * inside it, so action steps get the default model's key too.
 *
 * Wired via `AbsurdRuntimeOptions.resolveJobNetwork`, so the durable core stays
 * agnostic — it only forwards the result to the target.
 */
import type { PlannedJob } from "../compiler/index.ts";
import { resolveModel, type PiWorkflowsConfig } from "../config/index.ts";
import { modelHostOf, modelKeyEnv } from "./guest-pi-runner.ts";

/** Structural `JobNetwork` (kept local to avoid an agent→runtime import cycle). */
export interface AgentJobNetwork {
  allowedHosts?: string[];
  secrets?: Record<string, { hosts: string[]; value: string }>;
}

/** A non-`run` step that needs the sandbox's mediated egress. */
function isUsesStep(uses: string | undefined): boolean {
  return uses !== undefined && (uses.startsWith("work/") || uses.startsWith("action/"));
}

/** Could this step run a model? `work/agent`, or an `action/<name>` that might wrap it. */
function mightRunModel(uses: string | undefined): boolean {
  return uses === "work/agent" || (uses?.startsWith("action/") ?? false);
}

/** The model alias a `work/agent` step targets (its `with.model`), if any. */
function stepModelAlias(job: PlannedJob, i: number): string | undefined {
  const m = job.steps[i]?.with?.["model"];
  return typeof m === "string" ? m : undefined;
}

/**
 * Build the `resolveJobNetwork` callback. Returns `undefined` for jobs with no
 * `uses:` step (they stay deny-by-default).
 */
export function makeAgentEgressResolver(
  config?: PiWorkflowsConfig,
): (job: PlannedJob) => AgentJobNetwork | undefined {
  return (job) => {
    if (!job.steps.some((s) => isUsesStep(s.uses))) return undefined;

    const net: AgentJobNetwork = { allowedHosts: ["*"] };

    // Inject one host-scoped model key PER distinct model host the job touches.
    // Each model step contributes its own (host -> key); steps whose models share
    // a host (same provider) collapse onto one entry. `work/agent` carries its own
    // alias; an action that may wrap it can't be introspected, so use the default
    // model. The in-guest runner derives the same `modelKeyEnv(host)` from each
    // step's model, so a step always reads the placeholder for the host it calls.
    if (config) {
      const secrets: Record<string, { hosts: string[]; value: string }> = {};
      for (const [i, step] of job.steps.entries()) {
        if (!mightRunModel(step.uses)) continue;
        const alias = step.uses === "work/agent" ? stepModelAlias(job, i) : undefined;
        const model = resolveModel(config, alias);
        const host = modelHostOf(model.baseUrl);
        if (!host) continue;
        secrets[modelKeyEnv(host)] = { hosts: [host], value: model.apiKey };
      }
      if (Object.keys(secrets).length > 0) net.secrets = secrets;
    }

    return net;
  };
}
