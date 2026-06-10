/**
 * Egress e2e — proves the MEDIATED-egress security contract on a REAL micro-VM.
 *
 * The property under test is narrow and specific: when a job is mediated (a model
 * host / datasource with an injected secret), the real secret is kept OUT of the
 * guest and only swapped in host-side, scoped to the allowed host. This is what
 * protects the API key from the agent — it is NOT a general network sandbox
 * (bare `run:` steps have open egress by design; that's how `npm install` works).
 *
 * It's the one place this is verified end-to-end rather than at the target
 * boundary (egress-wiring.test.ts spies on what's handed to the target; this
 * proves the target *honors* it):
 *
 *   1. the guest env holds a placeholder — the real secret never enters the VM;
 *   2. an outbound request to the allowlisted host arrives with the REAL secret
 *      (host-side header substitution);
 *   3. for a mediated job (allowlist set), a non-allowlisted host is refused and
 *      the upstream is never dialed.
 *
 * Hermetic on-box: the "model host" is a recording HTTP server on a host
 * interface IP. Guest traffic to that IP egresses through gondolin's host-side
 * network stack (guest loopback would not), so the host dials our server.
 * `allowedInternalHosts` is required because gondolin blocks private ranges by
 * default even when allowlisted. No external network is touched.
 *
 * Docs: docs/gondolin-secure-execution.md, docs/quality-gates-research.md §5.1.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { GondolinTarget } from "../src/targets/index.ts";
import { vmTestSkip } from "./_support.ts";

const SECRET_ENV = "WORK_E2E_MODEL_KEY";
const REAL_SECRET = "work-e2e-real-secret-3b9f17";

/** First non-internal IPv4 of this host — an address the gondolin host-side
 *  network stack can dial that still terminates on this machine. */
function hostLanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

const ip = hostLanIPv4();
const skip = vmTestSkip() || (ip ? false : "no non-loopback IPv4 interface on this host");

describe("egress e2e — mediated network + secret injection (real VM)", { skip }, () => {
  let server: Server;
  let port: number;
  let workdir: string;
  let target: GondolinTarget;
  /** Every request the fake model host actually received. */
  const seen: Array<{ url: string; authorization: string | undefined }> = [];
  /** The guest-visible placeholder, captured by the first test for the later ones. */
  let placeholder = "";

  before(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((res) => server.listen(0, ip!, res));
    port = (server.address() as { port: number }).port;

    workdir = await mkdtemp(join(tmpdir(), "pi-wf-egress-e2e-"));
    target = new GondolinTarget({
      workdir,
      allowedHosts: [ip!],
      allowedInternalHosts: [ip!],
      secrets: { [SECRET_ENV]: { hosts: [ip!], value: REAL_SECRET } },
    });
    await target.provision();
  });

  after(async () => {
    await target?.dispose();
    await new Promise<void>((res) => server.close(() => res()));
    await rm(workdir, { recursive: true, force: true });
  });

  it("the guest env holds a placeholder — the real secret never enters the VM", async () => {
    const r = await target.run(`printenv ${SECRET_ENV}`);
    assert.equal(r.ok, true, `printenv failed: ${r.stderr}`);
    placeholder = r.stdout.trim();
    assert.ok(placeholder.length > 0, "expected a placeholder value in the guest env");
    assert.notEqual(placeholder, REAL_SECRET, "the REAL secret leaked into the guest env");
  });

  it("an outbound request to the allowed host carries the real secret", async () => {
    const r = await target.run(
      `wget -qO- -T 15 --header "Authorization: Bearer $${SECRET_ENV}" http://${ip}:${port}/v1/check`,
    );
    assert.equal(r.ok, true, `guest wget failed: ${r.stderr}`);
    assert.equal(seen.length, 1, "the fake model host should have seen exactly one request");
    assert.equal(seen[0]!.url, "/v1/check");
    assert.equal(
      seen[0]!.authorization,
      `Bearer ${REAL_SECRET}`,
      "host-side substitution should swap the placeholder for the real secret",
    );
    assert.ok(
      !JSON.stringify(seen[0]).includes(placeholder),
      "the placeholder should never reach the upstream host",
    );
  });

  it("for a mediated job, a non-allowlisted host is refused — and never dialed", async () => {
    // This `target` is mediated (allowlist = [ip] only), so other hosts are
    // denied. 203.0.113.7 is TEST-NET-3 (RFC 5737): never routable, so if the
    // policy layer failed to block this pre-dial the request would hang, not
    // succeed. (Bare jobs without an allowlist have OPEN egress by design — that
    // is deliberately not asserted here.)
    const r = await target.run(`wget -qO- -T 15 http://203.0.113.7/`);
    assert.equal(r.ok, false, "a mediated job's request to a non-allowlisted host must fail");
    assert.equal(seen.length, 1, "no extra request may reach the fake model host");
  });
});
