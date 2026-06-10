#!/usr/bin/env node
// npm-bin entrypoint for `npx @nullbytelabs/work ...` and the `work` / `workflow`
// commands after `npm i -g`. The published package ships compiled `dist/cli.js`
// (Node won't strip types under node_modules); in the dev repo there's no dist/,
// so it falls back to running `src/cli.ts` via Node's native TypeScript support.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

// Preflight: gondolin (the only execution target) needs Node >= 23.6 — also where
// native TypeScript stripping is on by default. Fail fast and clear rather than
// crash later with a strip-types error or a cryptic VM failure.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 23 || (maj === 23 && min < 6)) {
  process.stderr.write(
    `work: requires Node >= 23.6 (found ${process.versions.node}). ` +
      `The gondolin sandbox needs it. Upgrade Node and re-run.\n`,
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist", "cli.js");
const cli = existsSync(dist) ? dist : resolve(here, "..", "src", "cli.ts");

// Surface the invoked command name (`work` / `workflow`) to the
// CLI so its usage text matches how the user called it.
const prog = basename(process.argv[1] ?? "work").replace(/\.mjs$/, "");

const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", cli, ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, PI_WF_PROG: prog } },
);
child.on("close", (code) => process.exit(code ?? 1));
