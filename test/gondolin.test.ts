import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GondolinTarget, buildExecArgs } from "../src/targets/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { DirectRuntime } from "../src/runtime/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("GondolinTarget — unit (no VM)", () => {
  it("uses /bin/sh -lc so the minimal Alpine guest can run the command", () => {
    assert.deepEqual(buildExecArgs("echo $HELLO"), ["/bin/sh", "-lc", "echo $HELLO"]);
  });

  it("constructs without loading the optional SDK or booting a VM", () => {
    const t = new GondolinTarget({ workdir: "/tmp/x" });
    assert.equal(t.kind, "gondolin");
  });

  it("run() before provision() throws a clear error", async () => {
    const t = new GondolinTarget({ workdir: "/tmp/x" });
    await assert.rejects(() => t.run("echo hi"), /before provision/);
  });
});

/**
 * Real micro-VM execution. Skipped by default — it needs Node >= 23.6, QEMU,
 * and the optional @earendil-works/gondolin package. Opt in with:
 *
 *   PI_WF_TEST_GONDOLIN=1 npm test
 */
const RUN_VM = process.env["PI_WF_TEST_GONDOLIN"] === "1";

describe("GondolinTarget — VM smoke (opt-in)", { skip: !RUN_VM }, () => {
  it("runs the test/e2e/hello-world-gondolin.yaml workflow in a VM", async () => {
    const yaml = await readFile(resolve(HERE, "e2e", "hello-world-gondolin.yaml"), "utf-8");
    const plan = compile(parseWorkflow(yaml));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-gondolin-"));
    let output = "";
    try {
      const result = await new DirectRuntime().run(plan, {
        workRoot,
        hooks: { onOutput: (_j, _s, c) => (output += c.text) },
      });
      assert.equal(result.status, "success");
      assert.match(output, /hello world/);
      assert.match(output, /hello world, josh/);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
