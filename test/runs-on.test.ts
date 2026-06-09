import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRunsOn } from "../src/compiler/runs-on.ts";

describe("parseRunsOn", () => {
  it("parses the stock gondolin namespace", () => {
    assert.deepEqual(parseRunsOn("gondolin"), { namespace: "gondolin" });
  });

  it("parses work:<variant> with a kebab-case variant", () => {
    assert.deepEqual(parseRunsOn("work:base"), { namespace: "work", variant: "base" });
    assert.deepEqual(parseRunsOn("work:node-25"), { namespace: "work", variant: "node-25" });
  });

  it("rejects a malformed work variant", () => {
    assert.throws(() => parseRunsOn("work:Base"), /invalid work image/);
    assert.throws(() => parseRunsOn("work:"), /invalid work image/);
    assert.throws(() => parseRunsOn("work:a_b"), /invalid work image/);
  });

  it("keeps the `local`-removed message", () => {
    assert.throws(() => parseRunsOn("local"), /has been removed/);
  });

  it("rejects an unknown namespace", () => {
    assert.throws(() => parseRunsOn("docker"), /unknown runs-on/);
  });
});
