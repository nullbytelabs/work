/**
 * Resolve a `runs-on` value to a concrete ExecutionTarget.
 *
 *   local    -> LocalTarget   (host child process; fast, no isolation)
 *   gondolin -> GondolinTarget (secure micro-VM; lazily loads the optional SDK)
 *
 * Construction is cheap and side-effect-free for both targets — GondolinTarget
 * does not import or boot anything until `provision()` is called.
 */
import type { ExecutionTarget } from "./types.ts";
import { LocalTarget } from "./local.ts";
import { GondolinTarget } from "./gondolin.ts";

export interface TargetContext {
  /** Per-job working directory. */
  workdir: string;
  /** Non-secret env to apply to the target environment. */
  env?: Record<string, string>;
}

export function makeTarget(runsOn: string, ctx: TargetContext): ExecutionTarget {
  switch (runsOn) {
    case "local":
      return new LocalTarget(ctx.workdir);
    case "gondolin":
      return new GondolinTarget({ workdir: ctx.workdir, env: ctx.env });
    default:
      throw new Error(`unknown runs-on: "${runsOn}" (supported: "local", "gondolin")`);
  }
}
