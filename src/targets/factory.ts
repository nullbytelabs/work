/**
 * Resolve a `runs-on` value to a concrete ExecutionTarget.
 *
 *   gondolin -> GondolinTarget (secure micro-VM; lazily loads the optional SDK)
 *
 * Gondolin is the only execution target: every job runs in the sandbox. There is
 * deliberately no host-execution target — running a step directly on the host
 * would defeat the isolation the engine exists to provide. (Tests inject a
 * lightweight `ExecutionTarget` double via the runtime's `makeTarget` hook to
 * exercise the contract without booting a VM; that double lives in test code and
 * is never reachable from a workflow.)
 *
 * Construction is cheap and side-effect-free — GondolinTarget does not import or
 * boot anything until `provision()` is called.
 */
import type { ResolvedMachine } from "../compiler/index.ts";
import type { ExecutionTarget } from "./types.ts";
import { GondolinTarget } from "./gondolin.ts";

export interface TargetContext {
  /** Per-job working directory. */
  workdir: string;
  /** Resolved machine sizing (cpus/memory). Targets that ignore it fall back to a default. */
  machine?: ResolvedMachine;
  /** Non-secret env to apply to the target environment. */
  env?: Record<string, string>;
  /** Outbound HTTP allowlist for sandbox targets (deny-by-default otherwise). */
  allowedHosts?: string[];
  /** Secrets injected into outbound headers host-side only; never seen in-guest. */
  secrets?: Record<string, { hosts: string[]; value: string }>;
}

/** Builds the ExecutionTarget for a job's `runs-on`. The runtime accepts an
 *  override of this (e.g. tests inject a host-process double) via its options. */
export type TargetFactory = (runsOn: string, ctx: TargetContext) => ExecutionTarget;

export const makeTarget: TargetFactory = (runsOn, ctx) => {
  switch (runsOn) {
    case "gondolin":
      return new GondolinTarget({
        workdir: ctx.workdir,
        ...(ctx.machine ? { machine: ctx.machine } : {}),
        ...(ctx.env ? { env: ctx.env } : {}),
        ...(ctx.allowedHosts ? { allowedHosts: ctx.allowedHosts } : {}),
        ...(ctx.secrets ? { secrets: ctx.secrets } : {}),
      });
    default:
      throw new Error(`unknown runs-on: "${runsOn}" (the only supported target is "gondolin")`);
  }
};
