// Publish-time build. The package runs TypeScript directly during development,
// but a *published* package lives under `node_modules`, where Node refuses to
// strip types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). So `npm pack` /
// `npm publish` (via the `prepack` hook) bundle the CLI to plain JS here. Dev is
// unaffected — `./work` and the npm scripts still run `src/` build-free.
import { build } from "esbuild";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Bundle our own code into one file; keep node_modules deps external (pglite,
// gondolin, pi, … resolve from the installed package's node_modules at runtime).
await build({
  entryPoints: [resolve(root, "src/cli.ts")],
  outfile: resolve(dist, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
});

// Two non-TS runtime assets are loaded relative to their module via
// `import.meta.url`. After bundling, that resolves to `dist/`, so copy them flat
// next to `cli.js`:
//   - schema.sql               (engine.ts: join(dirname(import.meta.url), "schema.sql"))
//   - guest-runner-script.mjs  (guest-pi-runner.ts: new URL("./guest-runner-script.mjs", import.meta.url))
await copyFile(resolve(root, "src/runtime/absurd/schema.sql"), resolve(dist, "schema.sql"));
await copyFile(resolve(root, "src/agent/guest-runner-script.mjs"), resolve(dist, "guest-runner-script.mjs"));

// Built-in actions (work/checkout, work/install-node) are bundled action packages
// loaded via `new URL("./builtin", import.meta.url)`, which resolves to `dist/`
// after bundling — so copy the whole tree flat next to cli.js.
await cp(resolve(root, "src/actions/builtin"), resolve(dist, "builtin"), { recursive: true });

// Bundled image build-configs (work:base) are loaded via
// `new URL("./image-builtin", import.meta.url)` — a distinct name from the
// actions' `builtin/` so the two don't collide under `dist/`.
await cp(resolve(root, "src/images/image-builtin"), resolve(dist, "image-builtin"), { recursive: true });

console.log("built dist/cli.js (+ schema.sql, guest-runner-script.mjs, builtin/, image-builtin/)");
