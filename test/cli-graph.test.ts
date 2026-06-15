/**
 * `work graph <file|name>` — CLI target resolution. The target is treated as a
 * file path when it *looks like one* (a `.yaml`/`.yml` extension or a path
 * separator), else resolved by `name:` within the workspace's `.workflows/`,
 * defaulting to cwd — so `work graph ci` works without `--workspace`, exactly
 * like `work run ci`. Driven as a subprocess against a seeded workspace.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "work.mjs");

const WORKFLOW = `name: ci
jobs:
  build:
    steps:
      - run: echo hi
  deploy:
    needs: [build]
    steps:
      - run: echo bye
`;

async function workspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "pi-wf-cligraph-"));
  await mkdir(join(ws, ".workflows"), { recursive: true });
  await writeFile(join(ws, ".workflows", "ci.yaml"), WORKFLOW);
  return ws;
}

describe("work graph", () => {
  it("resolves a bare name from cwd's .workflows/ without --workspace", async () => {
    const ws = await workspace();
    try {
      const r = spawnSync(BIN, ["graph", "ci"], { cwd: ws, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /flowchart TD/);
      assert.match(r.stdout, /build/);
      assert.match(r.stdout, /deploy/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("resolves a bare name via explicit --workspace", async () => {
    const ws = await workspace();
    try {
      const r = spawnSync(BIN, ["--workspace", ws, "graph", "ci"], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /flowchart TD/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("treats a path-shaped target as a file", async () => {
    const ws = await workspace();
    try {
      const r = spawnSync(BIN, ["graph", ".workflows/ci.yaml"], { cwd: ws, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /flowchart TD/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("errors clearly when a bare name has no match", async () => {
    const ws = await workspace();
    try {
      const r = spawnSync(BIN, ["graph", "nope"], { cwd: ws, encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no workflow named "nope"/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
