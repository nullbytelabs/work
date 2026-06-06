import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTarget } from "../src/targets/index.ts";
import { HostTarget } from "./_support.ts";

// HostTarget is the test-only ExecutionTarget double (host child processes) that
// component/integration suites inject so they exercise the runtime↔target
// contract without a VM. Verify it honors that contract here.
describe("HostTarget (test contract double)", () => {
  let workdir: string;
  let target: HostTarget;

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-wf-test-"));
    target = new HostTarget(workdir);
    await target.provision();
  });

  after(async () => {
    await target.dispose();
    await rm(workdir, { recursive: true, force: true });
  });

  it("runs a command and captures stdout + exit 0", async () => {
    const r = await target.run("echo hello");
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), "hello");
  });

  it("exposes the workdir as its workspacePath (where $WORK_OUTPUT lives)", () => {
    assert.equal(target.workspacePath, workdir);
  });

  it("reports a non-zero exit code without throwing", async () => {
    const r = await target.run("echo oops >&2; exit 7");
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 7);
    assert.match(r.stderr, /oops/);
  });

  it("passes env vars into the command", async () => {
    const r = await target.run('echo "$GREETING"', { env: { GREETING: "hi there" } });
    assert.equal(r.stdout.trim(), "hi there");
  });

  it("streams output through onOutput", async () => {
    const chunks: string[] = [];
    await target.run("echo a; echo b", { onOutput: (c) => chunks.push(c.text) });
    assert.match(chunks.join(""), /a\nb/);
  });

  it("runs in the provided working directory", async () => {
    const r = await target.run("pwd");
    // `pwd` resolves symlinks (e.g. macOS /var -> /private/var), so compare
    // against the real path rather than the raw mkdtemp path.
    assert.equal(r.stdout.trim(), await realpath(workdir));
  });

  it("dispose is safe to call repeatedly", async () => {
    await target.dispose();
    await target.dispose();
  });
});

describe("makeTarget factory", () => {
  it("returns a GondolinTarget for runs-on gondolin (without loading the SDK)", () => {
    const t = makeTarget("gondolin", { workdir: "/tmp/x" });
    assert.equal(t.kind, "gondolin");
  });

  it("rejects runs-on local (the host target was removed — no foot-gun)", () => {
    assert.throws(() => makeTarget("local", { workdir: "/tmp/x" }), /only supported target is "gondolin"/);
  });

  it("rejects an unknown runs-on", () => {
    assert.throws(() => makeTarget("mars", { workdir: "/tmp/x" }), /unknown runs-on/);
  });
});
