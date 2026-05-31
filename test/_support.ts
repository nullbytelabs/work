// Shared test support: boot ONE durable (PGLite-backed) Absurd engine per test
// file and hand out AbsurdRuntime instances bound to it, so we don't re-apply
// the schema for every workflow run. Not a *.test.ts file, so the runner ignores it.
import { before, after } from "node:test";
import { AbsurdRuntime, createAbsurdEngine, type AbsurdEngine, type RunContext, type WorkflowResult } from "../src/runtime/index.ts";
import type { ExecutionPlan } from "../src/compiler/index.ts";

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
      return new AbsurdRuntime({ engine }).run(plan, ctx);
    },
  };
}
