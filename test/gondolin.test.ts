import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GondolinTarget, buildExecArgs, makeResolveHook } from "../src/targets/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import { AbsurdRuntime } from "../src/runtime/index.ts";
import { vmTestSkip } from "./_support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("GondolinTarget — unit (no VM)", () => {
  it("uses /bin/sh -lc for portable command execution in the guest", () => {
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

describe("makeResolveHook — host pin rewrite (no VM)", () => {
  const hook = makeResolveHook({ "work-triage.internal": "127.0.0.1" });

  it("rewrites a pinned hostname to the IP, keeping port/path/method/headers", async () => {
    const req = new Request("https://Work-Triage.INTERNAL:7443/api/v1/pods?limit=1", {
      headers: { authorization: "Bearer placeholder" },
    });
    const out = (await hook(req)) as Request;
    assert.equal(out.url, "https://127.0.0.1:7443/api/v1/pods?limit=1");
    assert.equal(out.method, "GET");
    assert.equal(out.headers.get("authorization"), "Bearer placeholder");
  });

  it("carries the body through for methods that may have one", async () => {
    const req = new Request("https://work-triage.internal:7443/api", { method: "POST", body: "spec" });
    const out = (await hook(req)) as Request;
    assert.equal(await out.text(), "spec");
  });

  it("leaves non-pinned hosts untouched", async () => {
    assert.equal(hook(new Request("https://api.fireworks.ai/v1")), undefined);
  });
});

/**
 * Real micro-VM execution. Needs Node >= 23.6, QEMU, and the optional
 * @earendil-works/gondolin package. Self-skips without QEMU (or under
 * WORK_SKIP_VM, the non-qemu `test:unit` target); the full `npm test` runs it
 * wherever QEMU is installed.
 */
describe("GondolinTarget — VM smoke", { skip: vmTestSkip() }, () => {
  it("runs the test/e2e/hello-world-gondolin/workflow.yaml workflow in a VM", async () => {
    const dir = resolve(HERE, "e2e", "hello-world-gondolin");
    const plan = compile(parseWorkflow(await readFile(resolve(dir, "workflow.yaml"), "utf-8")));
    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-gondolin-"));
    const runtime = new AbsurdRuntime();
    let output = "";
    try {
      const result = await runtime.run(plan, {
        workRoot,
        workspaceSource: dir,
        hooks: { onOutput: (_j, _s, c) => (output += c.text) },
      });
      assert.equal(result.status, "success");
      assert.match(output, /hello world/);
      assert.match(output, /hello world, josh/);
    } finally {
      await runtime.close();
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
