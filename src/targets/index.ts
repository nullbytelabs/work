export type { ExecutionTarget, RunOptions, RunResult } from "./types.ts";
export { GondolinTarget, buildExecArgs, type GondolinTargetConfig } from "./gondolin.ts";
export { makeTarget, type TargetContext, type TargetFactory } from "./factory.ts";
