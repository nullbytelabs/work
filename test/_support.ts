// Shared test support: boot ONE durable (PGLite-backed) Absurd engine per test
// file and hand out AbsurdRuntime instances bound to it, so we don't re-apply
// the schema for every workflow run. Not a *.test.ts file, so the runner ignores it.
import { before, after } from "node:test";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine, type RunContext, type WorkflowResult } from "../src/runtime/index.ts";
import type { ExecutionPlan } from "../src/compiler/index.ts";
import type { AgentRunner, AgentRequest } from "../src/agent/index.ts";

/** Deterministic agent runner for tests — no network. Echoes a canned summary. */
export const mockAgentRunner: AgentRunner = {
  async run(req: AgentRequest) {
    // Surface enough of the prompt to assert the wiring, but stay deterministic.
    const firstLine = req.prompt.split("\n").find((l) => l.trim().length > 0) ?? "";
    return { text: `MOCK SUMMARY: ${firstLine.slice(0, 60)}` };
  },
};

export interface SharedRuntime {
  run(plan: ExecutionPlan, ctx: RunContext): Promise<WorkflowResult>;
}

/** Call once at the top of a test file; registers before/after for the engine. */
export function useSharedRuntime(): SharedRuntime {
  let engine: AbsurdEngine | undefined;
  before(async () => {
    engine = await createAbsurdEngine();
  });
  after(async () => {
    if (engine) await engine.close();
  });
  return {
    run(plan, ctx) {
      if (!engine) throw new Error("engine not started");
      // Agent steps use the mock runner so tests never call inference.
      return new AbsurdRuntime({ engine, agentRunner: mockAgentRunner }).run(plan, ctx);
    },
  };
}
