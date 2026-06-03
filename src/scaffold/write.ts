/**
 * The write/skip/force/dry-run policy shared by `create` and `init`. Kept apart
 * from the pure `scaffoldFiles()` generator so the file set can be unit-tested
 * without touching disk, and so both commands clobber identically:
 *   - existing files are skipped-and-reported (never silently overwritten);
 *   - `--force` overwrites the scaffold's own files, EXCEPT the config, which is
 *     never overwritten (it may hold real credentials);
 *   - `--dry-run` prints what would happen and writes nothing.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CODE, paint } from "../tui/palette.ts";
import { CONFIG_FILENAME } from "./templates.ts";

export interface FileAction {
  /** Path relative to the project root. */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
  action: "create" | "overwrite" | "skip";
  reason?: string;
}

/** Decide what happens to each file (no FS writes). */
export function planWrites(files: Map<string, string>, cwd: string, force: boolean): FileAction[] {
  const actions: FileAction[] = [];
  for (const rel of files.keys()) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) {
      actions.push({ rel, abs, action: "create" });
    } else if (rel === CONFIG_FILENAME) {
      // Never overwrite config — it may hold real credentials.
      actions.push({ rel, abs, action: "skip", reason: "exists (config preserved)" });
    } else if (force) {
      actions.push({ rel, abs, action: "overwrite" });
    } else {
      actions.push({ rel, abs, action: "skip", reason: "exists (use --force to overwrite)" });
    }
  }
  return actions;
}

/**
 * Apply (or, for a dry run, just describe) the planned writes, printing a report
 * to stdout. Returns the actions so the caller can tailor its epilogue.
 */
export async function executeWrites(
  files: Map<string, string>,
  actions: FileAction[],
  opts: { dryRun: boolean; color: boolean },
): Promise<FileAction[]> {
  const { color } = opts;

  if (opts.dryRun) {
    process.stdout.write(`${paint(color, CODE.bold, "dry run")} — would write (nothing changed):\n`);
    for (const a of actions) {
      const tag =
        a.action === "skip"
          ? paint(color, CODE.yellow, `skip ${a.reason}`)
          : paint(color, CODE.green, a.action);
      process.stdout.write(`  ${tag}  ${a.rel}\n`);
    }
    return actions;
  }

  for (const a of actions) {
    if (a.action === "skip") continue;
    await mkdir(dirname(a.abs), { recursive: true });
    await writeFile(a.abs, files.get(a.rel)!);
  }

  for (const a of actions) {
    if (a.action === "skip") {
      process.stdout.write(`  ${paint(color, CODE.yellow, "⊘")} ${a.rel}  ${paint(color, CODE.dim, a.reason ?? "skipped")}\n`);
    } else {
      const verb = a.action === "overwrite" ? "overwrote" : "created";
      process.stdout.write(`  ${paint(color, CODE.green, "✓")} ${verb} ${a.rel}\n`);
    }
  }
  return actions;
}
