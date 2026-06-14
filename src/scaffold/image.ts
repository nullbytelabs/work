/**
 * `work create image <name>` — scaffold a custom `work:<name>` image: a Gondolin
 * build-config under `.workflows/images/<name>/` that a job selects with
 * `runs-on: work:<name>` (see docs/gondolin-custom-images.md).
 *
 * Why a generator (vs. "copy the doc"): a *committed* build-config must be
 * arch-agnostic — the engine injects the host arch right before `gondolin build`.
 * The doc's prose example carries an `arch` field for illustration; a user who
 * copies it pins the wrong arch and the image fails to build on a different host.
 * Emitting the proven arch-agnostic shape (the `work:base` floor, minus `arch`)
 * is the whole point of this command: a working starting point to *extend*, not a
 * hand-assembled toolchain.
 *
 * The skeleton is embedded as a TS object rather than read from the bundled
 * built-in at runtime: the published `dist/cli.js` bundle has no predictable path
 * to `src/images/image-builtin/base/build-config.json`, so reading it would break
 * the installed package.
 */
import { UserFacingError } from "../errors.ts";
import { failUsage, prog } from "../cli-util.ts";
import { CODE, paint, shouldColor } from "../tui/palette.ts";
import { WORKFLOWS_DIR } from "../project.ts";
import { slug } from "./slug.ts";
import { planWrites, executeWrites } from "./write.ts";

interface CreateImageOptions {
  rawName: string;
  force: boolean;
  dryRun: boolean;
}

/**
 * The embedded build-config skeleton — the proven `work:base` shape (Alpine,
 * bootable kernel + rng, plus a lean "do real work" floor: bash, certs, curl,
 * a filesystem tool, git, jq). Deliberately arch-agnostic: NO `arch` field, since
 * the engine injects the host arch before `gondolin build`. The heavier language
 * runtimes (nodejs/npm/uv/python3) are left out to keep the starter lean — add
 * what you need to `alpine.rootfsPackages` or `postBuild.commands`.
 */
export const IMAGE_SKELETON = {
  distro: "alpine",
  alpine: {
    version: "3.23.0",
    kernelPackage: "linux-virt",
    kernelImage: "vmlinuz-virt",
    rootfsPackages: [
      "linux-virt",
      "rng-tools",
      "bash",
      "ca-certificates",
      "curl",
      "e2fsprogs",
      "git",
      "jq",
    ],
    initramfsPackages: [],
    krunfwVersion: "v5.2.1",
  },
  rootfs: { label: "gondolin-root" },
} as const;

/** Render the embedded skeleton to the build-config file text (trailing newline). */
export function imageConfigText(): string {
  return JSON.stringify(IMAGE_SKELETON, null, 2) + "\n";
}

/** Path (relative to project root) of a generated image's build-config. */
function imageConfigPath(name: string): string {
  return `${WORKFLOWS_DIR}/images/${name}/build-config.json`;
}

function parseCreateImageArgs(argv: string[]): CreateImageOptions {
  let rawName: string | undefined;
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      const p = prog();
      process.stdout.write(`Usage:\n  ${p} create image <name> [--force] [--dry-run]\n`);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      failUsage(`unknown flag for create image: ${arg}`);
    } else if (rawName === undefined) {
      rawName = arg;
    } else {
      failUsage(`unexpected argument: ${arg}`);
    }
  }

  if (rawName === undefined) failUsage("create image requires a name, e.g. `create image godot`");
  return { rawName, force, dryRun };
}

/** Run `create image`. Resolves with the process exit code. */
export async function runCreateImage(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const opts = parseCreateImageArgs(argv);
  const name = slug(opts.rawName);

  const rel = imageConfigPath(name);
  const files = new Map<string, string>([[rel, imageConfigText()]]);

  const color = shouldColor(Boolean(process.stdout.isTTY));
  const actions = planWrites(files, cwd, opts.force);

  // Refuse to clobber an existing build-config (it may hold real edits) unless
  // --force was passed — the writer already skips it, so surface a clear error
  // instead of a silent skip.
  if (!opts.dryRun) {
    const skipped = actions.find((a) => a.rel === rel && a.action === "skip");
    if (skipped) {
      throw new UserFacingError(
        `${rel} already exists — edit it directly, or pass --force to overwrite with a fresh skeleton`,
      );
    }
  }

  await executeWrites(files, actions, { dryRun: opts.dryRun, color });
  if (opts.dryRun) return 0;

  process.stdout.write(`\n${paint(color, CODE.bold, "Next steps:")}\n`);
  process.stdout.write(`  select it: set ${paint(color, CODE.cyan, `runs-on: work:${name}`)} on a job\n`);
  process.stdout.write(`  add tools: list apk packages in ${paint(color, CODE.cyan, "alpine.rootfsPackages")}, or use\n`);
  process.stdout.write(`             ${paint(color, CODE.cyan, "postBuild.commands")} for anything not in apk (npm i -g, a pinned tarball)\n`);
  process.stdout.write(`  build:     the image builds lazily the first time a job uses it\n`);
  process.stdout.write(`  docs:      docs/gondolin-custom-images.md\n`);
  return 0;
}
