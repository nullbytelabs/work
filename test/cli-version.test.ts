// `work version` / `--version` / `-v` and the doctor version line — exercised
// through the real bin so the dispatch, output format, and exit codes are the
// ones users actually get. The expected value is read from package.json (not
// hard-coded) so a version bump never breaks these.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "work.mjs");
const EXPECTED = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

describe("work version", () => {
  for (const form of [["version"], ["--version"], ["-v"]]) {
    it(`\`work ${form.join(" ")}\` prints the bare version and exits 0`, () => {
      const r = spawnSync(BIN, form, { encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, `${EXPECTED}\n`); // bare, scriptable like `node -v`
      assert.equal(r.stderr, "");
    });
  }
});

describe("doctor reports the version", () => {
  it("leads the text output with the version", () => {
    const r = spawnSync(BIN, ["doctor"], { encoding: "utf8" });
    assert.match(r.stdout, new RegExp(`^\\s*work ${EXPECTED.replace(/\./g, "\\.")}\\n`));
  });

  it("includes a version field in --json", () => {
    const r = spawnSync(BIN, ["doctor", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.version, EXPECTED);
  });
});
