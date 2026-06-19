/**
 * GuestPiRunner — runs a Pi agent prompt **inside the job's sandbox** (the
 * gondolin guest). It is the only agent runner: every job is a sandbox, so the
 * agent loop never runs on the host.
 *
 * This is what makes `uses: work/agent` steps honor `runs-on: gondolin`: the whole
 * model loop executes in the VM, reaching the model API only through Gondolin's
 * mediated egress, with the API key injected host-side (it never enters the
 * guest). The host side here only *stages* a request and *reads back* a result
 * over the shared `/workspace` mount — so all of it is testable without a VM by
 * supplying a fake `exec` that writes the result file.
 *
 * Mechanics (Option B in docs/pi-in-gondolin.md):
 *   1. copy the standalone wrapper (`guest-runner-script.mjs`) + a request JSON
 *      into a private subdir of the shared workspace (host writes, guest reads);
 *   2. `npm install` the Pi package into that dir in-guest (native deps build
 *      for the guest platform), then `exec("node <wrapper> <req> <res>")` — Pi
 *      drives the model call through the allowlisted egress;
 *   3. read the result JSON back from the host side of the mount.
 *
 * The request file carries baseUrl + model id but **never the key**: the wrapper
 * reads it from `process.env[<keyEnv>]`, where `keyEnv` is the per-model-host env
 * var name (`modelKeyEnv`) that the egress resolver injected a placeholder under.
 * Gondolin swaps that placeholder into the Authorization header for that host only
 * (and blocks it if sent anywhere else), so a job that calls two providers reads a
 * different, host-correct key per step.
 */
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { mkdir, readFile, writeFile, rm, copyFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { UserFacingError } from "../errors.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "./index.ts";

/** Prefix for the per-model-host key env vars (and the legacy fallback name the
 *  guest wrapper reads when a request omits `keyEnv`). */
export const GUEST_MODEL_KEY_ENV = "PI_WF_MODEL_KEY";

/** The hostname a model `baseUrl` resolves to (port stripped), or undefined if it
 *  doesn't parse. The unit Gondolin scopes an injected secret by. */
export function modelHostOf(baseUrl: string): string | undefined {
  try {
    const host = new URL(baseUrl).hostname || undefined;
    // The host scopes the injected model key (and the in-guest `modelKeyEnv`). It's
    // used as a gondolin `matchHostname` pattern, which treats `*` as a wildcard, so a
    // `*` in the host would scope the key to a pattern instead of one host — leaking it
    // to any matching host the agent's allow-all egress can reach. Refuse it (fail
    // closed). Mirrors `hostOf` in egress/datasource.ts — keep the two in lockstep.
    return host?.includes("*") ? undefined : host;
  } catch {
    return undefined;
  }
}

/**
 * The guest env-var name under which a given model host's API key is injected.
 * Derived deterministically from the host so the host-side egress resolver and
 * the in-guest runner compute the SAME name independently (no out-of-band
 * coordination) — that agreement is what lets a multi-provider job read the
 * right key per step. A readable host slug plus a short hash keeps it both
 * debuggable and collision-safe (two distinct hosts never map to one name).
 */
export function modelKeyEnv(host: string): string {
  const slug = host.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const hash = createHash("sha256").update(host).digest("hex").slice(0, 8);
  return `${GUEST_MODEL_KEY_ENV}_${slug}_${hash}`;
}

/** Default guest path for Gondolin's MITM CA, so in-guest Node trusts the proxy. */
const GUEST_CA_PATH = "/etc/gondolin/mitm/ca.crt";

/** The Pi package (+ range) installed into the guest so the wrapper can load it. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent@^0.79.1";

/** The exec capability + workspace paths a sandboxed handler is handed. */
export interface GuestPiRunnerDeps {
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

const STAGE_DIR = ".pi-agent";

export class GuestPiRunner implements AgentRunner {
  private readonly deps: GuestPiRunnerDeps;
  constructor(deps: GuestPiRunnerDeps) {
    this.deps = deps;
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    if (!req.model) {
      throw new UserFacingError(
        "agent step needs a model — provide a config (--config) with providers/models and a defaultModel, or set with.model",
      );
    }
    // The host whose injected key this step will read. Must agree with the egress
    // resolver's `modelKeyEnv(host)` so the placeholder for the right host is read.
    const modelHost = modelHostOf(req.model.baseUrl);
    if (!modelHost) {
      throw new UserFacingError(`agent step model baseUrl is not a valid URL: ${req.model.baseUrl}`);
    }
    const { exec, hostDir, guestDir, emit } = this.deps;
    const id = randomUUID().slice(0, 8);
    // Per-invocation, UNPREDICTABLE staging DIRECTORY — not a constant. The checkout
    // is attacker-controlled and lands in this same mount, so a constant `.pi-agent`
    // lets a hostile repo pre-plant the prefix: (a) as a symlink to a host dir, so
    // mkdir-recursive no-ops and the host's writes escape through it; or (b) as a
    // real dir holding a malicious `.npmrc` (registry redirect) / `node_modules`,
    // which the in-guest `npm install --prefix` and the wrapper's require.resolve
    // would then trust. Randomizing only the file *names* (below) is not enough —
    // the directory itself must be unguessable so it can't be pre-planted at all.
    const stageName = `${STAGE_DIR}-${id}`;
    const hostStage = join(hostDir, stageName);
    await mkdir(hostStage, { recursive: true });

    // Per-invocation, unpredictable name. The wrapper lands in the workspace mount
    // the guest can also write to, so a deterministic path would let a malicious
    // guest pre-plant a symlink there that the host's copy would follow (an
    // arbitrary host-file overwrite). A random name the guest can't predict — plus
    // COPYFILE_EXCL below — closes that.
    const wrapperSrc = fileURLToPath(new URL("./guest-runner-script.mjs", import.meta.url));
    const hostWrapper = join(hostStage, `guest-runner-${id}.mjs`);
    const hostReq = join(hostStage, `req-${id}.json`);
    const hostRes = join(hostStage, `res-${id}.json`);

    // Request carries everything EXCEPT the key (which crosses via header injection).
    // `cwd` is the guest-side workspace mount so the agent's tools operate on the
    // real checkout (the handler passes it; default to the mount root).
    const request = {
      // Omitted when the caller supplies no system prompt, so the in-guest
      // wrapper applies no override and Pi's discovered persona/AGENTS.md stands.
      ...(req.system !== undefined ? { system: req.system } : {}),
      prompt: req.prompt,
      // Per-host key env: the egress resolver injected this model's key under the
      // same name (derived from the host), scoped to that host only.
      keyEnv: modelKeyEnv(modelHost),
      cwd: req.cwd ?? guestDir,
      model: {
        baseUrl: req.model.baseUrl,
        model: req.model.model,
        ...(req.model.maxTokens !== undefined ? { maxTokens: req.model.maxTokens } : {}),
        ...(req.model.temperature !== undefined ? { temperature: req.model.temperature } : {}),
      },
    };

    // COPYFILE_EXCL: fail loudly if the destination already exists (e.g. a guest
    // pre-planted symlink) instead of writing *through* it to a host file.
    await copyFile(wrapperSrc, hostWrapper, constants.COPYFILE_EXCL);
    // `wx` (O_CREAT|O_EXCL) like the wrapper's COPYFILE_EXCL above: refuse to write
    // THROUGH a symlink a hostile process could plant at this path inside the shared
    // mount (which would redirect the request — carrying the prompt — to an arbitrary
    // host file). EEXIST fails the step loudly instead.
    await writeFile(hostReq, JSON.stringify(request), { encoding: "utf-8", flag: "wx" });
    await rm(hostRes, { force: true });

    // Guest-visible paths (same files via the shared mount).
    const gStage = `${guestDir}/${stageName}`;
    const gWrapper = `${gStage}/guest-runner-${id}.mjs`;
    const gReq = `${gStage}/req-${id}.json`;
    const gRes = `${gStage}/res-${id}.json`;

    // Install the Pi package into the guest (runs in-guest, so native deps build
    // for the guest platform). Hardened against a hostile checkout:
    //   * `cd ${gStage}` runs npm with its project dir = the unguessable stage dir,
    //     so npm reads only THAT dir's `.npmrc` (which the checkout can't plant) —
    //     never a `.npmrc` sitting at the checkout root.
    //   * `--ignore-scripts` blocks lifecycle-script code-exec from any fetched
    //     package, defense in depth.
    const install = await exec(
      // `--registry` pins the default registry on the CLI (overrides any `.npmrc`
      // registry= a hostile process could plant in the stage dir), so the wrapper
      // can't be tricked into loading an attacker-served Pi package. `--ignore-scripts`
      // blocks lifecycle-script execution as defense in depth.
      `cd ${gStage} && npm install --prefix ${gStage} --registry=https://registry.npmjs.org/ --no-save --no-audit --no-fund --ignore-scripts ${PI_PACKAGE}`,
      { ...(emit ? { onOutput: emit } : {}) },
    );
    if (!install.ok) {
      throw new UserFacingError(
        `failed to install ${PI_PACKAGE} in the sandbox guest (exit ${install.exitCode})` +
          `${install.stderr ? `: ${install.stderr.slice(0, 300)}` : ""}`,
      );
    }

    const run = await exec(`node ${gWrapper} ${gReq} ${gRes}`, {
      env: { NODE_EXTRA_CA_CERTS: GUEST_CA_PATH, PI_SKIP_VERSION_CHECK: "1" },
      ...(emit ? { onOutput: emit } : {}),
    });

    const resultText = await readResultFile(hostRes);
    // Best-effort cleanup of the per-invocation wrapper/request/result.
    await rm(hostWrapper, { force: true });
    await rm(hostReq, { force: true });
    await rm(hostRes, { force: true });
    // Remove the per-invocation staging dir itself (it carries the installed Pi
    // package). Best-effort: ignore failures (e.g. a guest still holding a handle).
    await rm(hostStage, { recursive: true, force: true }).catch(() => {});

    if (resultText) {
      let parsed: { text?: string; finishReason?: string; usage?: AgentResult["usage"]; error?: string };
      try {
        parsed = JSON.parse(resultText) as typeof parsed;
      } catch {
        throw new UserFacingError(`in-guest agent returned malformed result JSON (exit ${run.exitCode})`);
      }
      if (parsed.error) throw new UserFacingError(`in-guest agent failed: ${parsed.error}`);
      if (typeof parsed.text === "string") {
        return {
          text: parsed.text,
          ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}),
          ...(parsed.usage ? { usage: parsed.usage } : {}),
        };
      }
    }
    throw new UserFacingError(
      `in-guest agent produced no result (exit ${run.exitCode})${run.stderr ? `: ${run.stderr.slice(0, 300)}` : ""}`,
    );
  }
}

/** Read the in-guest result, refusing to follow a symlink at the result path: a
 *  prompt-injected agent (full toolset over the shared mount) could plant
 *  `res-<id>.json -> <host file>` mid-run so the wrapper's write / our read escape
 *  the workspace. The wrapper only ever creates a regular file, so a symlink is
 *  hostile. Returns undefined when no result was produced. */
async function readResultFile(hostRes: string): Promise<string | undefined> {
  let st;
  try {
    st = await lstat(hostRes);
  } catch {
    return undefined; // no result file
  }
  if (st.isSymbolicLink()) {
    throw new UserFacingError("in-guest agent result path is a symlink (refusing to follow it out of the workspace)");
  }
  return readFile(hostRes, "utf-8").catch(() => undefined);
}
