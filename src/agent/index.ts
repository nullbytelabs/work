/**
 * Agent layer for the `work/agent` primitive.
 *
 * `AgentRunner` is the seam. The production runner is `GuestPiRunner`: every job
 * runs in the gondolin sandbox, so the agent's whole loop (model calls + tools)
 * executes in-guest via the `@earendil-works/pi-coding-agent` SDK. There is no
 * host-side runner — running an agent on the host would defeat the sandbox.
 * Tests inject a stub runner, so the whole pipeline is exercisable without
 * inference.
 *
 * The agent surface is the dumb **`work/agent`** primitive (`work-handler.ts`):
 * prompted entirely through `with:`, no package format. Richer, versioned behavior
 * lives in user-space actions (`src/actions/`) — a composite action that wraps
 * `work/agent`. There is no engine-owned `agent/<name>` package format; see
 * docs/agent-primitive-and-actions.md.
 */
import type { ResolvedModel } from "../config/index.ts";
import type { StepAgentUsage } from "../runtime/types.ts";

export interface AgentRequest {
  /**
   * System prompt (the agent's standing persona/policy). Optional, and the
   * `work/agent` primitive never sets it — when omitted, the runner passes *no*
   * override, so Pi's own `DefaultResourceLoader` discovery (a checked-in `.pi/`
   * persona, `AGENTS.md`) stands. Kept on the runner as a general capability.
   */
  system?: string;
  /** Task prompt for this invocation. */
  prompt: string;
  /** Resolved model; optional so a stub runner can ignore it. */
  model?: ResolvedModel;
  /**
   * Working directory the agent runs in — the job's staged workspace (its
   * checkout). The agent gets the full toolset rooted here, so it operates on
   * the real files directly. The runner does not police what it does in there.
   * Defaults to `process.cwd()` when omitted.
   */
  cwd?: string;
}

export interface AgentResult {
  text: string;
  /** Why the model stopped — "stop" (complete) or "length" (truncated at max_tokens), etc. */
  finishReason?: string;
  /** Cumulative token usage across the whole agent loop (from Pi's session stats),
   *  for telemetry. Absent when the runner/SDK didn't surface it. */
  usage?: StepAgentUsage;
  /** Wall-clock spent on setup (staging + the in-guest Pi install), in ms. */
  setupMs?: number;
  /** Wall-clock spent in the agent loop itself (the wrapper exec — model + tools), in ms. */
  runMs?: number;
}

export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResult>;
}

// The in-guest runner (every job is sandboxed) + the env var its model key arrives under.
export { GuestPiRunner, GUEST_MODEL_KEY_ENV, PI_PACKAGE, modelHostOf, modelKeyEnv, loopbackModelPin, resolveModelEndpoint, type ModelEndpoint, type GuestPiRunnerDeps } from "./guest-pi-runner.ts";
// The `work` uses-handler (work/agent primitive + built-in actions) — register at the composition root.
export { createWorkHandler, type WorkHandlerOptions } from "./work-handler.ts";
// Per-job sandbox egress for agent steps (allow-all egress + model-host-scoped key).
export { makeAgentEgressResolver, type AgentJobNetwork } from "./egress.ts";
