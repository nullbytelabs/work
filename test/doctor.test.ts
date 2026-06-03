import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runChecks,
  overallStatus,
  qemuBinaryFor,
  type Check,
  type DoctorProbes,
} from "../src/doctor/checks.ts";
import { UserFacingError } from "../src/errors.ts";

/** A healthy macOS host with everything in place and no project context. */
function baseProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: "23.6.0",
    platform: "darwin",
    arch: "arm64",
    cwd: "/proj",
    importGondolin: async () => ({ hasGuestAssets: () => true }),
    spawnVersion: async () => ({ ok: true, errorCode: null, stdout: "QEMU emulator version 9.1.0" }),
    pathAccess: () => true,
    exists: () => false, // no config, no .workflows by default
    loadConfig: async () => ({}),
    ...over,
  };
}

function byId(checks: Check[], id: string): Check {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `expected a check with id "${id}"`);
  return c;
}

describe("qemuBinaryFor", () => {
  it("maps host arch to the QEMU system binary gondolin launches", () => {
    assert.equal(qemuBinaryFor("arm64"), "qemu-system-aarch64");
    assert.equal(qemuBinaryFor("x64"), "qemu-system-x86_64");
    assert.equal(qemuBinaryFor("riscv64"), "qemu-system-riscv64"); // unknown → host arch string
  });
});

describe("runChecks — Node floor", () => {
  it("passes on >= 23.6", async () => {
    const checks = await runChecks(baseProbes({ nodeVersion: "24.0.1" }));
    assert.equal(byId(checks, "node").status, "pass");
  });
  it("fails below 23.6 with a remediation", async () => {
    const checks = await runChecks(baseProbes({ nodeVersion: "23.5.0" }));
    const c = byId(checks, "node");
    assert.equal(c.status, "fail");
    assert.match(c.remediation ?? "", /upgrade Node/);
  });
  it("treats 23.6 exactly as the floor (pass)", async () => {
    const checks = await runChecks(baseProbes({ nodeVersion: "23.6.0" }));
    assert.equal(byId(checks, "node").status, "pass");
  });
});

describe("runChecks — gondolin SDK + guest image", () => {
  it("passes when importable and reports cached assets", async () => {
    const checks = await runChecks(baseProbes());
    assert.equal(byId(checks, "gondolin").status, "pass");
    assert.equal(byId(checks, "guest-image").status, "pass");
  });
  it("warns (not fails) on guest image when assets are absent", async () => {
    const checks = await runChecks(baseProbes({ importGondolin: async () => ({ hasGuestAssets: () => false }) }));
    const c = byId(checks, "guest-image");
    assert.equal(c.status, "warn");
    assert.match(c.detail ?? "", /200 MB/);
  });
  it("fails gondolin and downgrades guest-image to warn when the SDK is missing", async () => {
    const checks = await runChecks(
      baseProbes({
        importGondolin: async () => {
          throw new Error("Cannot find package '@earendil-works/gondolin'");
        },
      }),
    );
    const g = byId(checks, "gondolin");
    assert.equal(g.status, "fail");
    assert.match(g.remediation ?? "", /npm install @earendil-works\/gondolin/);
    assert.equal(byId(checks, "guest-image").status, "warn");
  });
});

describe("runChecks — QEMU", () => {
  it("passes and extracts the version", async () => {
    const checks = await runChecks(baseProbes());
    const c = byId(checks, "qemu");
    assert.equal(c.status, "pass");
    assert.equal(c.detail, "qemu-system-aarch64 9.1.0");
  });
  it("fails when the binary is missing (ENOENT) with an OS-specific install hint", async () => {
    const checks = await runChecks(
      baseProbes({ spawnVersion: async () => ({ ok: false, errorCode: "ENOENT", stdout: "" }) }),
    );
    const c = byId(checks, "qemu");
    assert.equal(c.status, "fail");
    assert.equal(c.remediation, "brew install qemu");
  });
  it("picks the apt/dnf hint on linux", async () => {
    const checks = await runChecks(
      baseProbes({ platform: "linux", spawnVersion: async () => ({ ok: false, errorCode: "ENOENT", stdout: "" }) }),
    );
    assert.match(byId(checks, "qemu").remediation ?? "", /apt install|dnf install/);
  });
  it("warns (not fails) when output is unrecognized", async () => {
    const checks = await runChecks(
      baseProbes({ spawnVersion: async () => ({ ok: true, errorCode: null, stdout: "something else" }) }),
    );
    assert.equal(byId(checks, "qemu").status, "warn");
  });
});

describe("runChecks — hardware acceleration", () => {
  it("passes on macOS (HVF)", async () => {
    const checks = await runChecks(baseProbes({ platform: "darwin" }));
    assert.equal(byId(checks, "accel").status, "pass");
  });
  it("passes on linux with /dev/kvm access", async () => {
    const checks = await runChecks(baseProbes({ platform: "linux", pathAccess: () => true }));
    const c = byId(checks, "accel");
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /KVM/);
  });
  it("warns on linux without /dev/kvm (never fails)", async () => {
    const checks = await runChecks(baseProbes({ platform: "linux", pathAccess: () => false }));
    assert.equal(byId(checks, "accel").status, "warn");
  });
  it("warns on an unknown platform", async () => {
    const checks = await runChecks(baseProbes({ platform: "win32" }));
    assert.equal(byId(checks, "accel").status, "warn");
  });
});

describe("runChecks — config", () => {
  it("passes (optional) when no config file is present", async () => {
    const checks = await runChecks(baseProbes({ exists: () => false }));
    const c = byId(checks, "config");
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /optional/);
  });
  it("passes when a present config loads cleanly", async () => {
    const checks = await runChecks(
      baseProbes({ exists: (p) => p.endsWith("pi-workflows.config.json"), loadConfig: async () => ({ providers: {}, models: {} }) }),
    );
    assert.equal(byId(checks, "config").status, "pass");
  });
  it("fails and echoes the message when a present config is broken", async () => {
    const checks = await runChecks(
      baseProbes({
        exists: (p) => p.endsWith("pi-workflows.config.json"),
        loadConfig: async () => {
          throw new UserFacingError("config.models.x references unknown provider \"y\"");
        },
      }),
    );
    const c = byId(checks, "config");
    assert.equal(c.status, "fail");
    assert.match(c.detail ?? "", /unknown provider/);
  });
  it("honours $PI_WORKFLOWS_CONFIG over the default path", async () => {
    const seen: string[] = [];
    await runChecks(
      baseProbes({
        configEnv: "/custom/my.json",
        exists: (p) => {
          seen.push(p);
          return false;
        },
      }),
    );
    assert.ok(seen.some((p) => p.endsWith("/custom/my.json")), "should probe the env-specified config path");
  });
});

describe("runChecks — .workflows/ presence", () => {
  it("warns when absent", async () => {
    const checks = await runChecks(baseProbes({ exists: () => false }));
    assert.equal(byId(checks, "workflows-dir").status, "warn");
  });
  it("passes when present", async () => {
    const checks = await runChecks(baseProbes({ exists: (p) => p.endsWith(".workflows") }));
    assert.equal(byId(checks, "workflows-dir").status, "pass");
  });
});

describe("overallStatus", () => {
  it("returns pass only when every check passes", () => {
    assert.equal(overallStatus([{ id: "a", title: "", status: "pass" }]), "pass");
  });
  it("warn beats pass", () => {
    assert.equal(
      overallStatus([
        { id: "a", title: "", status: "pass" },
        { id: "b", title: "", status: "warn" },
      ]),
      "warn",
    );
  });
  it("fail beats everything", () => {
    assert.equal(
      overallStatus([
        { id: "a", title: "", status: "warn" },
        { id: "b", title: "", status: "fail" },
        { id: "c", title: "", status: "pass" },
      ]),
      "fail",
    );
  });

  it("a fully healthy host reports pass across the whole list", async () => {
    const checks = await runChecks(
      baseProbes({
        platform: "linux",
        pathAccess: () => true,
        exists: (p) => p.endsWith(".workflows") || p.endsWith("pi-workflows.config.json"),
        loadConfig: async () => ({ providers: {}, models: {} }),
      }),
    );
    assert.equal(overallStatus(checks), "pass");
  });
});
