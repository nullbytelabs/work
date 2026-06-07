/**
 * The shared dispatch sequence — the one place that turns a compiled plan into a
 * finished `WorkflowResult`. Both the CLI (`work run …`) and the web UI's
 * `RunManager` call this, so they share *exactly* one run path: same config load,
 * same work-root allocation, same `AbsurdRuntime` construction (agent uses-handler
 * + per-job egress), same close semantics.
 *
 * It deliberately does NOT own presentation. The caller hands `hooks` (the CLI's
 * presenter hooks, or the web presenter's SSE sink) and starts/finishes around
 * the call. Keeping presentation out means the web layer reuses this untouched.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AbsurdRuntime, type AbsurdEngine, type RunHooks, type WorkflowResult } from "./runtime/index.ts";
import type { ExecutionPlan } from "./compiler/index.ts";
import type { TargetFactory } from "./targets/index.ts";
import { createWorkHandler, makeAgentEgressResolver } from "./agent/index.ts";
import { createActionUsesHandler, type SubUsesDispatch } from "./actions/index.ts";
import type { UsesHandler } from "./runtime/index.ts";
import { composeResolvers, makeDatasourceEgressResolver } from "./egress/index.ts";
import type { PiWorkflowsConfig } from "./config/index.ts";

export interface StartRunOptions {
  /** The compiled plan to run. */
  plan: ExecutionPlan;
  /**
   * Directory staged into every job's working directory (the checkout). Together
   * with `workflowDir` this is the workflow's `WorkflowLayout` spread in.
   */
  workspaceSource?: string;
  /** Directory holding the workflow definition + local assets (agent packages). */
  workflowDir?: string;
  /** Run hooks (presenter / SSE sink). */
  hooks?: RunHooks;
  /** Caller-supplied stable run id (web mints it up front); defaults to a UUID. */
  runId?: string;
  /** Provider/model config for agent steps. */
  config?: PiWorkflowsConfig | undefined;
  /**
   * Datasource keys this run's jobs may reach (e.g. a webhook's `datasources`
   * scope). Composed with the agent egress resolver and forwarded to the runtime,
   * so a plain `run:` step in this run can reach an allowlisted datasource host
   * with a header-injected token. Deny-by-default — omit and no datasource egress
   * is granted.
   */
  datasources?: string[];
  /** Base working directory; a fresh temp dir is allocated when omitted. */
  workdir?: string;
  /**
   * A shared `AbsurdEngine` to run on. When provided the runtime does NOT own it
   * (the `ownsEngine` flag is false), so `runtime.close()` is a no-op for it and
   * the engine outlives the run — the web server boots one engine for all runs.
   */
  engine?: AbsurdEngine;
  /** Override the runs-on → ExecutionTarget factory (tests inject a host double). */
  makeTarget?: TargetFactory;
}

/**
 * Construct the agent-composed `AbsurdRuntime`, run the plan, and close. Returns
 * the `WorkflowResult`. `runtime.close()` always runs in `finally` — it's a no-op
 * for an injected `engine`, so this is safe for both the per-run-engine CLI path
 * and the shared-engine web path.
 */
export async function startRun(opts: StartRunOptions): Promise<WorkflowResult> {
  const workRoot = opts.workdir
    ? resolve(opts.workdir)
    : await mkdtemp(join(tmpdir(), "pi-workflows-"));

  // Compose the `uses:` handlers into the (agent-agnostic) runtime. A composite
  // action's inner `uses:` sub-steps route through a late-bound dispatcher that
  // resolves by scheme over this same handler set — so `work/agent` and nested
  // `action/<name>` work inside a composite, and built-in `work/*` actions run via
  // the action path. Per-job egress is the union of the agent/action resolver
  // (allow-all for jobs with a uses-step + a host-scoped model key) and the
  // datasource resolver (a scoped datasource host + injected token for a `run:`
  // step). Secrets are injected host-side only — never entering the guest. An
  // injected engine is shared (not closed per run).
  const handlers: UsesHandler[] = [];
  const dispatch: SubUsesDispatch = (subCtx) => {
    const scheme = subCtx.uses.split("/", 1)[0]!;
    const h = handlers.find((x) => x.scheme === scheme);
    if (!h) {
      subCtx.emit({ stream: "stderr", text: `no handler for uses: "${subCtx.uses}"` });
      return Promise.resolve({ status: "failure", stderr: `no handler for uses: "${subCtx.uses}"` });
    }
    return h.run(subCtx);
  };
  handlers.push(
    createWorkHandler({ config: opts.config, dispatch }),
    createActionUsesHandler({ dispatch }),
  );

  const runtime = new AbsurdRuntime({
    usesHandlers: handlers,
    resolveJobNetwork: composeResolvers(
      makeAgentEgressResolver(opts.config),
      makeDatasourceEgressResolver(opts.config, opts.datasources ? { datasources: opts.datasources } : {}),
    ),
    ...(opts.engine ? { engine: opts.engine } : {}),
    ...(opts.makeTarget ? { makeTarget: opts.makeTarget } : {}),
  });

  try {
    return await runtime.run(opts.plan, {
      workRoot,
      ...(opts.workspaceSource !== undefined ? { workspaceSource: opts.workspaceSource } : {}),
      ...(opts.workflowDir !== undefined ? { workflowDir: opts.workflowDir } : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    });
  } finally {
    await runtime.close();
  }
}
