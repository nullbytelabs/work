import { readFileSync } from "node:fs";

/**
 * The package version, read from `package.json` at startup.
 *
 * Resolved relative to `import.meta.url` — this file in dev, the bundled `dist/cli.js`
 * once built. Both sit one level under the package root, and npm always ships
 * `package.json` next to `dist/`, so `../package.json` resolves in both. We read the
 * file rather than `process.env.npm_package_version` because that var is only set when
 * the CLI is launched via an npm script — for the installed `work` bin it is undefined,
 * which previously made every real run report `service.version=dev` in OTel traces.
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "dev";
  } catch {
    return "dev";
  }
})();
