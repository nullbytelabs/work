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
 * The built-in catalog of named machine types. `medium` is the default — sized
 * so jobs that don't declare a `machine:` run unchanged. The floor is set by
 * knip's parser (oxc): via raw transfer it eagerly reserves a single ~6 GiB
 * ArrayBuffer per parse, independent of file size. The buffer is virtual
 * (overcommit-backed and mostly never faulted in), but the *reservation* must
 * fit under the guest's commit limit, so the default needs real headroom above
 * 6 GiB or knip dies at `new ArrayBuffer` with "Array buffer allocation failed".
 * 8G clears it with ~2 GiB to spare. (Was 6G — fine when oxc's buffer was
 * ~4 GiB; oxc grew the reservation to ~6 GiB and 6G no longer had room.)
 */
export const MACHINE_TYPES: Record<string, ResolvedMachine> = {
  small: { cpus: 2, memory: "2G" },
  medium: { cpus: 2, memory: "8G" },
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
