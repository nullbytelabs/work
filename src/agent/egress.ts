/**
 * Per-job sandbox egress for agent steps.
 *
 * When a `runs-on: gondolin` job contains agent steps (`uses: agent/*` or the
 * `work/agent` primitive), the in-guest Pi process must reach the model API —
 * but Gondolin is deny-by-default. This
 * builds the job's network policy from config: allowlist the model host(s) and
 * inject the API key as a header-only secret under `GUEST_MODEL_KEY_ENV`, so the
 * **real key never enters the guest** (Gondolin swaps the placeholder into the
 * Authorization header for the model host only).
 *
 * It is wired into the runtime via `AbsurdRuntimeOptions.resolveJobNetwork`, so
 * the durable core stays agent-agnostic — it only forwards the result to the
 * target. The shape returned is structurally a `JobNetwork`.
 */
import type { PlannedJob } from "../compiler/index.ts";
import { resolveModel, type PiWorkflowsConfig, type ResolvedModel } from "../config/index.ts";
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

/** The model alias an agent step targets (its `with.model`), if any. */
function stepModelAlias(job: PlannedJob, i: number): string | undefined {
  const w = job.steps[i]?.with;
  const m = w?.["model"];
  return typeof m === "string" ? m : undefined;
}

/**
 * Whether a step reaches the model and so needs the egress allowlist + injected
 * key: either an `agent/<name>` package step or the `work/agent` primitive. Both
 * run a real Pi loop in-guest and reach the model the same way.
 */
function isModelStep(uses: string | undefined): boolean {
  return uses === "work/agent" || (uses?.startsWith("agent/") ?? false);
}

/**
 * Build the `resolveJobNetwork` callback. Returns `undefined` for jobs that
 * need no mediated egress (no config, or no agent steps).
 */
export function makeAgentEgressResolver(
  config?: PiWorkflowsConfig,
): (job: PlannedJob) => AgentJobNetwork | undefined {
  return (job) => {
    if (!config) return undefined;

    // Resolve every model an agent step in this job will call (agent/<name> or
    // the work/agent primitive).
    const models: ResolvedModel[] = [];
    job.steps.forEach((step, i) => {
      if (isModelStep(step.uses)) {
        models.push(resolveModel(config, stepModelAlias(job, i)));
      }
    });
    if (models.length === 0) return undefined;

    const hosts = [...new Set(models.map((m) => hostOf(m.baseUrl)).filter((h): h is string => !!h))];
    if (hosts.length === 0) return undefined;

    // One model key per job in this first cut: the guest reads a single
    // GUEST_MODEL_KEY_ENV. If a job mixes models with distinct keys, the first
    // key is injected for all model hosts (documented limitation).
    const value = models[0]!.apiKey;
    return {
      allowedHosts: ["*"],
      secrets: { [GUEST_MODEL_KEY_ENV]: { hosts, value } },
    };
  };
}
