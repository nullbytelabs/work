/**
 * `runGuestNode` — run a user's Node script **inside the job's sandbox** (the
 * gondolin guest), the mechanism behind JS actions.
 *
 * It is the same stage→install→exec→read dance `GuestPiRunner` does for the Pi
 * wrapper, generalized for an arbitrary action directory: copy the action dir
 * into a private subdir of the shared `/workspace` mount (host writes, guest
 * reads), `npm install` in-guest iff it has a `package.json` (native deps build
 * for the guest), then `exec("node <main>")` with the `INPUT_*` env set and
 * `$WORK_OUTPUT` pointed at a capture file the host reads back. So the action's
 * code never runs on the host, exactly like a `run:` step — and it's all testable
 * without a VM by supplying a fake `exec`.
 */
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseOutputFile } from "../runtime/index.ts";

/** Default guest path for Gondolin's MITM CA, so in-guest Node trusts the proxy. */
const GUEST_CA_PATH = "/etc/gondolin/mitm/ca.crt";

/** Private staging root under the shared mount (host writes, guest reads). */
const STAGE_ROOT = ".work-actions";

/** The output capture filename written inside the staged action dir. */
const OUTPUT_FILE = ".work-output";

export interface GuestNodeDeps {
  /** Run a command in the guest (the job's target). */
  exec(
    command: string,
    opts?: {
      env?: Record<string, string>;
      onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; ok: boolean }>;
  /** Host path of the shared workspace (where we write/read staged files). */
  hostDir: string;
  /** Guest path of the same workspace (what the `exec`'d command sees). */
  guestDir: string;
  /** Stream guest output to the run's hooks. */
  emit?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export interface GuestNodeRequest {
  /** Host path of the action source directory to stage into the guest. */
  srcDir: string;
  /** Subdir name under the staging root (the action name). */
  stageName: string;
  /** Entry script, relative to the staged action dir. */
  main: string;
  /** Whether the action dir has a `package.json` (→ `npm install` in-guest). */
  hasPackageJson: boolean;
  /** Extra env for the script (the `INPUT_*` ABI). `WORK_OUTPUT` is set here. */
  env: Record<string, string>;
}

export interface GuestNodeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  /** Parsed `$WORK_OUTPUT` (key=value / heredoc), or `{}` if the run failed. */
  outputs: Record<string, string>;
}

/** POSIX single-quote a value so the guest shell treats it as one literal word.
 *  The stage path and an action manifest's `main` field flow into a `sh -lc`
 *  command, so quoting keeps a space or metacharacter in either from splitting
 *  the command or injecting extra ones. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Stage the action dir into the guest mount, optionally `npm install`, run it. */
export async function runGuestNode(deps: GuestNodeDeps, req: GuestNodeRequest): Promise<GuestNodeResult> {
  const { exec, hostDir, guestDir, emit } = deps;

  const hostStage = join(hostDir, STAGE_ROOT, req.stageName);
  await rm(hostStage, { recursive: true, force: true });
  await mkdir(hostStage, { recursive: true });
  // Copy the action source into the staging subdir (host side of the mount).
  await cp(req.srcDir, hostStage, { recursive: true });

  const gStage = `${guestDir}/${STAGE_ROOT}/${req.stageName}`;
  const hostOutFile = join(hostStage, OUTPUT_FILE);
  await rm(hostOutFile, { force: true });

  if (req.hasPackageJson) {
    const install = await exec(`npm install --prefix ${shq(gStage)} --no-audit --no-fund`, {
      ...(emit ? { onOutput: emit } : {}),
    });
    if (!install.ok) {
      return {
        exitCode: install.exitCode,
        stdout: install.stdout,
        stderr: install.stderr || `npm install failed for action "${req.stageName}"`,
        ok: false,
        outputs: {},
      };
    }
  }

  const run = await exec(`node ${shq(`${gStage}/${req.main}`)}`, {
    env: {
      ...req.env,
      WORK_OUTPUT: `${gStage}/${OUTPUT_FILE}`,
      NODE_EXTRA_CA_CERTS: GUEST_CA_PATH,
    },
    ...(emit ? { onOutput: emit } : {}),
  });

  const outputs = run.ok ? parseOutputFile(await readFile(hostOutFile, "utf-8").catch(() => "")) : {};
  return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, ok: run.ok, outputs };
}
