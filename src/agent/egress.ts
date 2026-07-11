/**
 * Per-job sandbox egress + model-key injection.
 *
 * **Egress is open for every job.** The deny-by-default wall on `run:`-only jobs
 * was theater (see `docs/egress-walk-back.md`): agent steps and any job with a
 * `work/checkout`/`action/*` step already got allow-all, and what actually keeps a
 * provider token out of a guest is the host-side header-swap below — not the
 * allowlist. Walling off the one shape operators reach for first (a pure `run:`
 * job) only pushed real work back onto the unsandboxed host. So this resolver
 * grants `["*"]` to every job and the runtime stops dead-ending plain `run:` jobs.
 * (Reaching *internal/private* ranges stays blocked by gondolin's default — opening
 * public egress doesn't expose host-loopback services.)
 *
 * The load-bearing control stays: when a model is configured, each model host the
 * job touches gets its own header-only secret, injected under a per-host env-var
 * name (`modelKeyEnv`) and scoped to that one host — so the **real key never enters
 * the guest** (Gondolin swaps the placeholder into the Authorization header for
 * that host only, and blocks it if sent elsewhere) and is harmless for a job that
 * never calls the model. A job with two `work/agent` steps on different providers
 * therefore gets two distinct host-scoped keys, each read by the step that needs
 * it. A composite `action/<name>` may wrap `work/agent` without the resolver being
 * able to see inside it, so action steps get the default model's key too.
 *
 * Wired via `AbsurdRuntimeOptions.resolveJobNetwork`, so the durable core stays
 * agnostic — it only forwards the result to the target.
 */
import type { PlannedJob } from "../compiler/index.ts";
import { resolveModel, type WorkConfig } from "../config/index.ts";
import { loopbackModelPin, modelHostOf, modelKeyEnv } from "./guest-pi-runner.ts";

/** Structural `JobNetwork` (kept local to avoid an agent→runtime import cycle). */
export interface AgentJobNetwork {
  allowedHosts?: string[];
  /** Hosts exempt from the sandbox's internal-IP-range block (loopback model servers). */
  allowedInternalHosts?: string[];
  /** Host-side dial pins (hostname → IP), like curl `--resolve`. */
  hostResolves?: Record<string, string>;
  secrets?: Record<string, { hosts: string[]; value: string }>;
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
 * Build the `resolveJobNetwork` callback. Grants allow-all egress to every job and
 * injects per-host model keys for any model-running step.
 */
export function makeAgentEgressResolver(
  config?: WorkConfig,
): (job: PlannedJob) => AgentJobNetwork | undefined {
  return (job) => {
    const net: AgentJobNetwork = { allowedHosts: ["*"] };

    // Inject one host-scoped model key PER distinct model host the job touches.
    // Each model step contributes its own (host -> key); steps whose models share
    // a host (same provider) collapse onto one entry. `work/agent` carries its own
    // alias; an action that may wrap it can't be introspected, so use the default
    // model. The in-guest runner derives the same `modelKeyEnv(host)` from each
    // step's model, so a step always reads the placeholder for the host it calls.
    if (config) {
      const secrets: Record<string, { hosts: string[]; value: string }> = {};
      const hostResolves: Record<string, string> = {};
      const allowedInternalHosts: string[] = [];
      for (const [i, step] of job.steps.entries()) {
        if (!mightRunModel(step.uses)) continue;
        const alias = step.uses === "work/agent" ? stepModelAlias(job, i) : undefined;
        const model = resolveModel(config, alias);
        const host = modelHostOf(model.baseUrl);
        if (!host) continue;
        // A loopback provider (llama.cpp/ollama/omlx on the operator's machine):
        // the guest dials a guest-safe alias — the in-guest runner derives the
        // SAME one via `loopbackModelPin` — and the pin rewrites it to the
        // loopback IP before policy checks and secret injection, so the key
        // scopes to the IP the request actually carries when it's swapped in,
        // and the internal-range block is lifted for exactly that IP.
        const pin = loopbackModelPin(host);
        if (pin) {
          secrets[modelKeyEnv(pin.alias)] = { hosts: [pin.ip], value: model.apiKey };
          hostResolves[pin.alias] = pin.ip;
          if (!allowedInternalHosts.includes(pin.ip)) allowedInternalHosts.push(pin.ip);
        } else {
          secrets[modelKeyEnv(host)] = { hosts: [host], value: model.apiKey };
        }
      }
      if (Object.keys(secrets).length > 0) net.secrets = secrets;
      if (Object.keys(hostResolves).length > 0) net.hostResolves = hostResolves;
      if (allowedInternalHosts.length > 0) net.allowedInternalHosts = allowedInternalHosts;
    }

    return net;
  };
}
