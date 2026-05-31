#!/usr/bin/env node
// npm-bin entrypoint. Runs the CLI on Node's native TypeScript support so
// `npx pi-workflows ...` behaves the same as the repo launcher — no native deps.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "src", "cli.ts");

const major = Number(process.versions.node.split(".")[0]);
const flags = ["--disable-warning=ExperimentalWarning"];
if (major < 23) flags.push("--experimental-strip-types");

const child = spawn(process.execPath, [...flags, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("close", (code) => process.exit(code ?? 1));
