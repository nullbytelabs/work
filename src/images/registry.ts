/**
 * Resolve a `work:<variant>` image to its Gondolin build-config. Two sources, in
 * order — a **user** image overrides a **bundled** built-in, exactly how user vs
 * built-in actions resolve:
 *
 *   <workspace>/.workflows/images/<variant>/build-config.json   # user-defined
 *   src/images/builtin/<variant>/build-config.json              # bundled (work:base)
 *
 * The build-config is Gondolin's own format (`gondolin build --init-config`); we
 * never parse its meaning, only locate it. `work:base` is dogfood — an ordinary
 * bundled build-config, built through the same path a user image is.
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { UserFacingError } from "../errors.ts";

/** The bundled built-in images directory. Named distinctly from the actions'
 *  `builtin/` because esbuild bundles everything into one `dist/cli.js`, so both
 *  `new URL("./X", import.meta.url)` resolve under `dist/` and must not collide. */
function builtinDir(): string {
  return fileURLToPath(new URL("./image-builtin", import.meta.url));
}

/** The user images directory for a workspace, or undefined when there's no checkout. */
function userDir(workspaceSource: string | undefined): string | undefined {
  return workspaceSource ? join(workspaceSource, ".workflows", "images") : undefined;
}

/**
 * Resolve a `work:<variant>` to its build-config path. A user image
 * (`.workflows/images/<variant>/`) wins over a bundled built-in. Throws a
 * `UserFacingError` listing the available images when the variant is unknown.
 */
export function resolveImageConfig(variant: string, workspaceSource: string | undefined): string {
  const ud = userDir(workspaceSource);
  const candidates = [
    ...(ud ? [join(ud, variant, "build-config.json")] : []),
    join(builtinDir(), variant, "build-config.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const avail = listImages(workspaceSource);
  throw new UserFacingError(
    `unknown work image "work:${variant}"` +
      (avail.length ? ` — available: ${avail.map((v) => `work:${v}`).join(", ")}` : "") +
      `. Add one under .workflows/images/${variant}/build-config.json.`,
  );
}

/** The available image variants (bundled ∪ user), sorted — for hints and `image ls`. */
export function listImages(workspaceSource: string | undefined): string[] {
  const names = new Set<string>(variantsIn(builtinDir()));
  const ud = userDir(workspaceSource);
  if (ud) for (const v of variantsIn(ud)) names.add(v);
  return [...names].sort();
}

/** Subdirectories of `parent` that contain a `build-config.json`. */
function variantsIn(parent: string): string[] {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(parent, e.name, "build-config.json")))
    .map((e) => e.name);
}
