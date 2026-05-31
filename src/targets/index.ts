export type { ExecutionTarget, RunOptions, RunResult } from "./types.ts";
export { LocalTarget } from "./local.ts";
export { GondolinTarget, buildExecArgs, type GondolinTargetConfig } from "./gondolin.ts";
export { makeTarget, type TargetContext } from "./factory.ts";
