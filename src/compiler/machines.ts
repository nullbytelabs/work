/**
 * Machine types — per-job CPU / RAM sizing for the gondolin micro-VM.
 *
 * A job picks a size with `machine:` — either a named type from the built-in
 * catalog below (`machine: large`) or an inline custom spec
 * (`machine: { cpus: 8, memory: 16G }`). The compiler resolves either form to a
 * concrete `ResolvedMachine` and stores it on the `PlannedJob`; the runtime
 * forwards it to the target, which maps it onto the VM's `memory` / `cpus`.
 *
 * A custom spec may set either dimension — an unset one falls back to the
 * default type, so `machine: { memory: 16G }` keeps the default cpus.
 *
 * Disk sizing is deliberately absent: gondolin's `rootfs.size` runs a guest-side
 * `resize2fs` at boot, but the shipped Alpine guest image has no `e2fsprogs`, so
 * any disk override hard-fails the VM. Storage waits on a custom guest image.
 */
import { WorkflowCompileError } from "./compile.ts";
import type { MachineSpec } from "../spec/index.ts";

/** A fully-resolved machine sizing: every dimension is concrete. */
export interface ResolvedMachine {
  /** vCPU count. */
  cpus: number;
  /** RAM in qemu syntax (e.g. "6G"). */
  memory: string;
}

/**
 * The built-in catalog of named machine types. `medium` is the default and
 * preserves the engine's historical 6G boot size — knip's parser (oxc) eagerly
 * allocates a single ~4 GiB ArrayBuffer and OOMs below that — so existing
 * workflows keep running unchanged when they don't declare a `machine:`.
 */
export const MACHINE_TYPES: Record<string, ResolvedMachine> = {
  small: { cpus: 2, memory: "2G" },
  medium: { cpus: 2, memory: "6G" },
  large: { cpus: 4, memory: "12G" },
  xlarge: { cpus: 8, memory: "24G" },
};

/** The machine type applied when a job declares no `machine:`. */
export const DEFAULT_MACHINE = "medium";

/** qemu-style size: a positive integer with an optional K/M/G/T suffix. */
const SIZE_RE = /^[1-9]\d*[KMGT]?$/i;

function validateSize(value: string, jobId: string, field: string): string {
  if (!SIZE_RE.test(value)) {
    throw new WorkflowCompileError(
      `job "${jobId}": invalid machine.${field} "${value}" — use a size like "8G" (positive integer, optional K/M/G/T suffix).`,
    );
  }
  return value;
}

/**
 * Resolve a job's `machine:` to concrete dimensions. A string names a catalog
 * type; a mapping is a custom spec whose unset dimensions inherit from the
 * default type. Throws a WorkflowCompileError on an unknown name or bad value.
 */
export function resolveMachine(spec: MachineSpec | undefined, jobId: string): ResolvedMachine {
  const base = MACHINE_TYPES[DEFAULT_MACHINE]!;

  if (spec === undefined) return base;

  if (typeof spec === "string") {
    const named = MACHINE_TYPES[spec];
    if (!named) {
      const known = Object.keys(MACHINE_TYPES).join(", ");
      throw new WorkflowCompileError(
        `job "${jobId}": unknown machine type "${spec}" (known types: ${known}; or specify cpus/memory inline).`,
      );
    }
    return named;
  }

  // Custom spec: each dimension overrides the default type's value.
  const cpus = spec.cpus ?? base.cpus;
  if (!Number.isInteger(cpus) || cpus < 1) {
    throw new WorkflowCompileError(
      `job "${jobId}": invalid machine.cpus "${spec.cpus}" — must be a positive integer.`,
    );
  }
  return {
    cpus,
    memory: spec.memory !== undefined ? validateSize(spec.memory, jobId, "memory") : base.memory,
  };
}
