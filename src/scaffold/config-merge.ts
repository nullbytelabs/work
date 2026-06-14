/**
 * Merge a keyed section (`datasources` / `webhooks`) into an existing `work.json`
 * without clobbering the rest of it.
 *
 * This is the deliberate counterpart to the scaffold writer (`write.ts`), which
 * NEVER touches an existing `work.json` because it may hold creds. The *merge*
 * writer intentionally edits `work.json` by adding exactly one keyed entry, and
 * earns the right to by:
 *   - operating on the raw parsed JSON object, so unknown / future top-level keys
 *     (and any hand-formatted entries) survive the round-trip;
 *   - refusing to overwrite an entry that already exists unless `--force`;
 *   - validating the merged result through the real config parser before any
 *     write — a malformed entry refuses to write rather than corrupting the file.
 *
 * `mergeConfigSection` is pure (no FS) so the merge logic is unit-testable; the
 * plan/write pair owns the disk read, the JSON round-trip, and the report line.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePartialConfig, PROJECT_CONFIG_FILENAME } from "../config/index.ts";
import { UserFacingError } from "../errors.ts";
import { CODE, paint } from "../tui/palette.ts";

/** The keyed config maps a generator may upsert into. */
export type ConfigSection = "datasources" | "webhooks";

export interface ConfigMergePlan {
  /** Path relative to the project root (always `work.json`). */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
  /** True when `work.json` did not exist and this merge creates it. */
  created: boolean;
  section: ConfigSection;
  key: string;
  /** The full new file contents to write (pretty JSON, trailing newline). */
  text: string;
  /** The single merged-in entry, compact JSON on one line — for a bounded dry-run summary. */
  entryText: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pure merge: return a new raw config object with `section[key] = entry` added.
 * Throws on a collision (unless `force`) and validates the merged shape through
 * `parsePartialConfig` — shape-only on purpose, so a user's pre-existing
 * cross-layer reference (a model whose provider lives in the global layer) isn't
 * rejected by an unrelated `create datasource`.
 */
export function mergeConfigSection(
  current: unknown,
  section: ConfigSection,
  key: string,
  entry: Record<string, unknown>,
  force: boolean,
): Record<string, unknown> {
  const raw: Record<string, unknown> = isObject(current) ? { ...current } : {};
  const existing = isObject(raw[section]) ? { ...(raw[section] as Record<string, unknown>) } : {};
  if (key in existing && !force) {
    throw new UserFacingError(
      `${section}.${key} already exists in ${PROJECT_CONFIG_FILENAME} — pass --force to overwrite it`,
    );
  }
  existing[key] = entry;
  raw[section] = existing;
  // Safety net: the merged config must still parse. parsePartialConfig validates
  // the entry's shape (and the rest of the file) without enforcing cross-refs.
  parsePartialConfig(raw);
  return raw;
}

/**
 * Read `work.json` (if present), merge in the entry, and return a write plan —
 * no FS write. A `work.json` that exists but is unreadable / not JSON is a
 * user-facing error rather than something we silently overwrite.
 */
export async function planConfigMerge(
  cwd: string,
  section: ConfigSection,
  key: string,
  entry: Record<string, unknown>,
  force: boolean,
): Promise<ConfigMergePlan> {
  const abs = join(cwd, PROJECT_CONFIG_FILENAME);
  const created = !existsSync(abs);
  let current: unknown;
  if (!created) {
    let text: string;
    try {
      text = await readFile(abs, "utf-8");
    } catch {
      throw new UserFacingError(`cannot read ${PROJECT_CONFIG_FILENAME}`);
    }
    try {
      current = JSON.parse(text);
    } catch {
      throw new UserFacingError(
        `${PROJECT_CONFIG_FILENAME} is not valid JSON — fix it before adding to ${section}`,
      );
    }
  }
  const merged = mergeConfigSection(current, section, key, entry, force);
  const text = JSON.stringify(merged, null, 2) + "\n";
  return { rel: PROJECT_CONFIG_FILENAME, abs, created, section, key, text, entryText: JSON.stringify(entry) };
}

/** Apply (or, for a dry run, describe) a config-merge plan, printing a report line. */
export async function writeConfigMerge(
  plan: ConfigMergePlan,
  opts: { dryRun: boolean; color: boolean },
): Promise<void> {
  const { color } = opts;
  if (opts.dryRun) {
    // A bounded one-line summary (the action + the merged-in entry), mirroring the
    // scaffold writer's dry run — not a dump of the whole merged file.
    const verb = plan.created ? "create" : "update";
    process.stdout.write(
      `${paint(color, CODE.bold, "dry run")} — would ${verb} ${plan.rel}: ` +
        `${paint(color, CODE.green, `${plan.section}.${plan.key}`)} = ${plan.entryText}\n`,
    );
    return;
  }
  await mkdir(dirname(plan.abs), { recursive: true });
  await writeFile(plan.abs, plan.text);
  const verb = plan.created ? "created" : "updated";
  process.stdout.write(
    `  ${paint(color, CODE.green, "✓")} ${verb} ${plan.rel}  ${paint(color, CODE.dim, `(${plan.section}.${plan.key})`)}\n`,
  );
}
