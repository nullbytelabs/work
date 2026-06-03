/**
 * `work doctor` — the check list, decoupled from how it's printed.
 *
 * Every probe that touches the host (Node version, dynamic import, spawning
 * QEMU, fs access, reading config) is injected through `DoctorProbes`, so
 * `runChecks` itself is deterministic and unit-testable with a fake bag —
 * mirroring the `makeTarget` injection seam in `src/targets/factory.ts`.
 *
 * The checks deliberately mirror what `GondolinTarget.provision()` will actually
 * do at run time (QEMU by default, the arch-picked binary, the cached guest
 * image) so doctor's verdict matches the engine's behaviour instead of guessing.
 */
import { constants as fsConstants } from "node:fs";
import { existsSync, accessSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { resolve } from "node:path";
import { WORKFLOWS_DIR } from "../project.ts";
import { loadConfig } from "../config/index.ts";
import { UserFacingError } from "../errors.ts";

/** Default project config filename — mirrors DEFAULT_CONFIG_PATH in cli.ts. */
const DEFAULT_CONFIG_PATH = "pi-workflows.config.json";

/** The gondolin SDK specifier — single source so doctor and the target agree. */
const GONDOLIN_SPECIFIER = "@earendil-works/gondolin";

/** Minimum Node major.minor the gondolin sandbox (and type-stripping) require. */
const NODE_MIN: readonly [number, number] = [23, 6];

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  /** Stable identifier for `--json` consumers. */
  id: string;
  /** Human-readable check name. */
  title: string;
  status: CheckStatus;
  /** What was found (the right-hand side of the checklist line). */
  detail?: string;
  /** Exact, copy-pasteable next step when not passing. Never auto-run. */
  remediation?: string;
}

/** Outcome of spawning a binary with `--version`. */
export interface SpawnResult {
  /** Process spawned and exited 0. */
  ok: boolean;
  /** Spawn error code (e.g. "ENOENT" when the binary is missing), else null. */
  errorCode: string | null;
  /** Captured stdout (used to confirm it's really QEMU). */
  stdout: string;
}

/**
 * The host-touching operations doctor needs. `defaultProbes()` binds the real
 * implementations; tests pass a fake to drive any host scenario with zero infra.
 */
export interface DoctorProbes {
  /** `process.versions.node`. */
  nodeVersion: string;
  /** `process.platform` / `process.arch`. */
  platform: NodeJS.Platform;
  arch: string;
  /** Working directory the project checks run against. */
  cwd: string;
  /** Dynamic-import the gondolin SDK (same probe as the target's loadGondolin). */
  importGondolin(): Promise<Record<string, unknown>>;
  /** Spawn `<bin> --version`. */
  spawnVersion(bin: string): Promise<SpawnResult>;
  /** `fs.accessSync(path, mode)` as a boolean (for /dev/kvm). */
  pathAccess(path: string, mode: number): boolean;
  /** Whether a path exists (for .workflows/ and the config file). */
  exists(path: string): boolean;
  /** Load + validate a config file; throws (UserFacingError) on bad config. */
  loadConfig(path: string): Promise<unknown>;
  /** $PI_WORKFLOWS_CONFIG, if set. */
  configEnv?: string;
}

/** Parse "23.6.0" → [23, 6]; tolerant of a leading "v". */
function parseNodeVersion(v: string): [number, number] {
  const [maj, min] = v.replace(/^v/, "").split(".").map(Number);
  return [maj ?? 0, min ?? 0];
}

/** The QEMU system binary gondolin launches for this host arch. */
export function qemuBinaryFor(arch: string): string {
  // gondolin maps arm64 → aarch64, x64 → x86_64; anything else falls back to the
  // host arch string (QEMU's own naming) so the remediation still names a real binary.
  const guest = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `qemu-system-${guest}`;
}

/** Install hint for QEMU, picked per host OS. */
function qemuInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "brew install qemu";
  // Cover the common Linux package managers; pick whichever your distro uses.
  return "apt install qemu-system  # or: dnf install qemu-system-*";
}

/**
 * Run every check against the injected probes. Pure given its probes: returns
 * the ordered Check list; the caller decides how to render and what exit code to
 * use (`overallStatus`).
 */
export async function runChecks(probes: DoctorProbes): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Node floor — same parse as the bin shim's preflight.
  const [maj, min] = parseNodeVersion(probes.nodeVersion);
  const nodeOk = maj > NODE_MIN[0] || (maj === NODE_MIN[0] && min >= NODE_MIN[1]);
  checks.push({
    id: "node",
    title: `Node >= ${NODE_MIN[0]}.${NODE_MIN[1]}`,
    status: nodeOk ? "pass" : "fail",
    detail: probes.nodeVersion,
    ...(nodeOk ? {} : { remediation: `upgrade Node to >= ${NODE_MIN[0]}.${NODE_MIN[1]} and re-run` }),
  });

  // 2. gondolin SDK importable — the exact probe the target uses at provision time.
  let gondolin: Record<string, unknown> | undefined;
  try {
    gondolin = await probes.importGondolin();
    checks.push({ id: "gondolin", title: "gondolin SDK importable", status: "pass", detail: GONDOLIN_SPECIFIER });
  } catch (err) {
    checks.push({
      id: "gondolin",
      title: "gondolin SDK importable",
      status: "fail",
      detail: (err as Error).message.split("\n")[0],
      remediation: `npm install ${GONDOLIN_SPECIFIER}`,
    });
  }

  // 3. QEMU binary present — gondolin launches it by bare name via PATH, so a
  //    missing binary otherwise surfaces only as a late ENOENT at provision.
  const qemu = qemuBinaryFor(probes.arch);
  const spawn = await probes.spawnVersion(qemu);
  if (spawn.errorCode === "ENOENT") {
    checks.push({
      id: "qemu",
      title: "QEMU installed",
      status: "fail",
      detail: `${qemu} not found on PATH`,
      remediation: qemuInstallHint(probes.platform),
    });
  } else if (spawn.ok && /qemu/i.test(spawn.stdout)) {
    const version = /version ([0-9][^\s]*)/i.exec(spawn.stdout)?.[1];
    checks.push({
      id: "qemu",
      title: "QEMU installed",
      status: "pass",
      detail: version ? `${qemu} ${version}` : qemu,
    });
  } else {
    // Spawned but didn't look like QEMU (or a non-ENOENT error) — warn, don't fail.
    checks.push({
      id: "qemu",
      title: "QEMU installed",
      status: "warn",
      detail: spawn.errorCode ? `${qemu}: ${spawn.errorCode}` : `${qemu}: unrecognized --version output`,
      remediation: qemuInstallHint(probes.platform),
    });
  }

  // 4. Hardware acceleration — mirror gondolin's own probe; never fail (TCG still
  //    runs, just slower, and gondolin itself only warns).
  if (probes.platform === "linux") {
    const kvm = probes.pathAccess("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
    checks.push({
      id: "accel",
      title: "Hardware acceleration",
      status: kvm ? "pass" : "warn",
      detail: kvm ? "KVM (/dev/kvm)" : "no /dev/kvm access — falls back to TCG (slow)",
      ...(kvm ? {} : { remediation: "load the kvm module and add your user to the `kvm` group" }),
    });
  } else if (probes.platform === "darwin") {
    checks.push({ id: "accel", title: "Hardware acceleration", status: "pass", detail: "HVF (macOS)" });
  } else {
    checks.push({
      id: "accel",
      title: "Hardware acceleration",
      status: "warn",
      detail: `${probes.platform}: no known accelerator — falls back to TCG (slow)`,
    });
  }

  // 5. Guest image cached — first run downloads it; warn (not fail) if absent.
  if (gondolin) {
    const hasAssets = gondolin["hasGuestAssets"] as (() => boolean) | undefined;
    if (typeof hasAssets === "function") {
      const cached = hasAssets();
      checks.push({
        id: "guest-image",
        title: "Guest image cached",
        status: cached ? "pass" : "warn",
        detail: cached ? "cached" : "not cached — first run downloads ~200 MB (needs network)",
      });
    } else {
      checks.push({ id: "guest-image", title: "Guest image cached", status: "warn", detail: "cannot probe (SDK lacks hasGuestAssets)" });
    }
  } else {
    checks.push({ id: "guest-image", title: "Guest image cached", status: "warn", detail: "unknown (SDK not importable)" });
  }

  // 6. Config valid, if present. Absent is fine (config is optional until an
  //    agent step needs a model); a present-but-broken config is a hard failure.
  const configPath = probes.configEnv ? resolve(probes.configEnv) : resolve(join(probes.cwd, DEFAULT_CONFIG_PATH));
  if (!probes.exists(configPath)) {
    checks.push({ id: "config", title: "Config valid", status: "pass", detail: "no config file (optional)" });
  } else {
    try {
      await probes.loadConfig(configPath);
      checks.push({ id: "config", title: "Config valid", status: "pass", detail: configPath });
    } catch (err) {
      checks.push({
        id: "config",
        title: "Config valid",
        status: "fail",
        detail: err instanceof UserFacingError ? err.message : `failed to load ${configPath}`,
      });
    }
  }

  // 7. .workflows/ present — context only; warn so `work run <name>` is usable.
  const wfDir = join(probes.cwd, WORKFLOWS_DIR);
  const hasWfDir = probes.exists(wfDir);
  checks.push({
    id: "workflows-dir",
    title: `${WORKFLOWS_DIR}/ present`,
    status: hasWfDir ? "pass" : "warn",
    detail: hasWfDir ? wfDir : `none in ${probes.cwd}`,
    ...(hasWfDir ? {} : { remediation: `create ${WORKFLOWS_DIR}/ to use \`work run <name>\`` }),
  });

  return checks;
}

/** Reduce checks to a single status: fail beats warn beats pass. */
export function overallStatus(checks: Check[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

/** Bind the real host implementations of every probe. */
export function defaultProbes(): DoctorProbes {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    importGondolin: () => import(GONDOLIN_SPECIFIER) as Promise<Record<string, unknown>>,
    spawnVersion: (bin) =>
      new Promise<SpawnResult>((res) => {
        execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
          if (err && (err as NodeJS.ErrnoException).code) {
            res({ ok: false, errorCode: (err as NodeJS.ErrnoException).code ?? null, stdout: stdout ?? "" });
          } else {
            res({ ok: !err, errorCode: null, stdout: stdout ?? "" });
          }
        });
      }),
    pathAccess: (path, mode) => {
      try {
        accessSync(path, mode);
        return true;
      } catch {
        return false;
      }
    },
    exists: (path) => existsSync(path),
    loadConfig: (path) => loadConfig(path),
    ...(process.env["PI_WORKFLOWS_CONFIG"] ? { configEnv: process.env["PI_WORKFLOWS_CONFIG"] } : {}),
  };
}
