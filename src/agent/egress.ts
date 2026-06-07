/**
 * Per-job sandbox egress for `uses:` steps.
 *
 * Gondolin is deny-by-default, but a non-`run` `uses:` step almost always needs
 * the network: the `work/agent` primitive (and any composite action wrapping it)
 * reaches the model; a JS action `npm install`s; `work/checkout`/`work/install-node`
 * fetch from a git/download host. So a job containing **any** `work/*` or
 * `action/*` step is granted mediated allow-all egress.
 *
 * When a model is configured, the API key is also injected as a header-only secret
 * under `GUEST_MODEL_KEY_ENV`, scoped to the configured model host(s) — so the
 * **real key never enters the guest** (Gondolin swaps the placeholder into the
 * Authorization header for the model host only) and is harmless for a job that
 * never calls the model. A composite `action/<name>` may wrap `work/agent` without
 * the resolver being able to see inside it, so action steps get the key too.
 *
 * Wired via `AbsurdRuntimeOptions.resolveJobNetwork`, so the durable core stays
 * agnostic — it only forwards the result to the target.
 */
import type { PlannedJob } from "../compiler/index.ts";
import { resolveModel, type PiWorkflowsConfig } from "../config/index.ts";
import { GUEST_MODEL_KEY_ENV } from "./guest-pi-runner.ts";

/** Structural `JobNetwork` (kept local to avoid an agent→runtime import cycle). */
export interface AgentJobNetwork {
  allowedHosts?: string[];
  secrets?: Record<string, { hosts: string[]; value: string }>;
}

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
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

    // Inject the model key (host-scoped) when a model is configured and the job
    // has a step that might call the model. `work/agent` carries its own alias;
    // an action that may wrap it can't be introspected, so use the default model.
    if (config) {
      const hosts = new Set<string>();
      let value: string | undefined;
      job.steps.forEach((step, i) => {
        if (!mightRunModel(step.uses)) return;
        const alias = step.uses === "work/agent" ? stepModelAlias(job, i) : undefined;
        const model = resolveModel(config, alias);
        const h = hostOf(model.baseUrl);
        if (h) hosts.add(h);
        value ??= model.apiKey; // one key per job (first wins) — documented limitation
      });
      if (hosts.size > 0 && value !== undefined) {
        net.secrets = { [GUEST_MODEL_KEY_ENV]: { hosts: [...hosts], value } };
      }
    }

    return net;
  };
}
