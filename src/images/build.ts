/**
 * Build a `work:<variant>` image via Gondolin and return the selector to boot it.
 *
 * There is one builder — Gondolin's. We resolve the build-config, inject the host
 * arch (Gondolin requires `arch` in the config; ours ship arch-agnostic so one
 * file builds on either platform), and run `gondolin build --config <cfg> --tag
 * work:<variant>`, which imports the result into Gondolin's local image store.
 * Booting then uses the tag as the image selector (`imagePath: "work:<variant>"`).
 *
 * Building is lazy: a tag already in the store for the host arch is reused, so the
 * (slow) build happens once per variant per machine. Concurrent jobs asking for
 * the same image share a single in-flight build.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { UserFacingError } from "../errors.ts";

/** Map Node's `process.arch` to Gondolin's arch name. */
export function gondolinArch(): "aarch64" | "x86_64" {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

/** Resolve the `gondolin` CLI entry from the installed optional dependency. */
function gondolinBin(): string {
  const require = createRequire(import.meta.url);
  try {
    const pkg = require.resolve("@earendil-works/gondolin/package.json");
    return join(dirname(pkg), "dist", "bin", "gondolin.js");
  } catch (err) {
    throw new UserFacingError(
      `a "work:<image>" job needs the optional dependency "@earendil-works/gondolin" (its \`gondolin\` CLI). ` +
        "Install it with:\n  npm install @earendil-works/gondolin\n" +
        `underlying error: ${(err as Error).message}`,
    );
  }
}

/** Run the gondolin CLI (via node), capturing output; reject on a non-zero exit. */
function runGondolin(args: string[], onLine?: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gondolinBin(), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      const t = b.toString();
      out += t;
      onLine?.(t);
    });
    child.stderr.on("data", (b: Buffer) => {
      const t = b.toString();
      err += t;
      onLine?.(t);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new UserFacingError(`gondolin ${args[0]} failed (exit ${code}):\n${(err || out).trim()}`)),
    );
  });
}

/** Whether the image tag already has an object for this arch in the local store. */
async function tagExists(tag: string, arch: string): Promise<boolean> {
  const out = await runGondolin(["image", "ls"]).catch(() => "");
  return out.split("\n").some((line) => {
    const cols = line.trim().split(/\s+/);
    return cols[0] === tag && cols.slice(1).some((c) => c.startsWith(`${arch}=`));
  });
}

/** In-flight builds, keyed by tag#arch, so concurrent jobs don't double-build. */
const building = new Map<string, Promise<void>>();

/**
 * Ensure the `work:<variant>` image is built for the host arch and return the
 * selector to boot it (`"work:<variant>"`). Reuses an already-built tag; otherwise
 * builds it from `buildConfigPath`. `emit` streams build progress to the caller.
 */
export async function ensureImageTag(variant: string, buildConfigPath: string, emit?: (text: string) => void): Promise<string> {
  const arch = gondolinArch();
  const tag = `work:${variant}`;
  if (await tagExists(tag, arch)) return tag;
  const key = `${tag}#${arch}`;
  let inflight = building.get(key);
  if (!inflight) {
    inflight = buildImage(buildConfigPath, tag, arch, emit);
    building.set(key, inflight);
    void inflight.finally(() => building.delete(key));
  }
  await inflight;
  return tag;
}

/** Build one image: inject the host arch into a temp copy of the config, then `gondolin build`. */
async function buildImage(buildConfigPath: string, tag: string, arch: string, emit?: (text: string) => void): Promise<void> {
  const cfg = JSON.parse(await readFile(buildConfigPath, "utf-8")) as Record<string, unknown>;
  cfg["arch"] = arch; // ours are arch-agnostic; Gondolin requires arch in the config
  const dir = await mkdtemp(join(tmpdir(), "work-image-"));
  const tmpCfg = join(dir, "build-config.json");
  await writeFile(tmpCfg, JSON.stringify(cfg));
  try {
    emit?.(`building ${tag} (${arch}) — first use on this machine, this can take a few minutes…\n`);
    await runGondolin(["build", "--config", tmpCfg, "--tag", tag], emit);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
