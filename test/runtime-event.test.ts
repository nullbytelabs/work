/**
 * Runtime `event` context — the webhook payload threaded into `if:` evaluation.
 *
 * `${{ event.* }}` in `run`/`with`/`env` strings is baked at compile time (covered
 * by event-context.test.ts). This file covers the *runtime* half: a job/step `if:`
 * that reads `event.*` is evaluated against the payload threaded onto the plan, so
 * an alert's severity can gate whether a job runs — the incident-response pattern.
 * Uses the host-process target double (no VM).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/spec/index.ts";
import { compile } from "../src/compiler/index.ts";
import type { WorkflowResult } from "../src/runtime/index.ts";
import { useSharedRuntime } from "./_support.ts";

const runtime = useSharedRuntime();

const YAML = `name: incident
on: webhook
jobs:
  triage:
    runs-on: gondolin
    steps:
      - name: echo-sev
        run: echo "sev=\${{ event.commonLabels.severity }}"
  page:
    runs-on: gondolin
    if: \${{ event.commonLabels.severity == 'critical' }}
    steps:
      - name: page
        run: echo PAGING
`;

async function runWith(event: Record<string, unknown>): Promise<{ result: WorkflowResult; output: string }> {
  const plan = compile(parseWorkflow(YAML), { event });
  const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-evt-"));
  let output = "";
  try {
    const result = await runtime.run(plan, {
      workRoot,
      hooks: { onOutput: (_j, _s, c) => (output += c.text) },
    });
    return { result, output };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

function job(result: WorkflowResult, id: string) {
  const j = result.jobs.find((x) => x.id === id);
  assert.ok(j, `no job ${id}`);
  return j;
}

describe("runtime event context", () => {
  it("bakes event.* into a run step AND gates an if: job that evaluates true", async () => {
    const { result, output } = await runWith({ commonLabels: { severity: "critical" } });
    assert.equal(result.status, "success");
    assert.match(output, /sev=critical/); // compile-time bake
    assert.equal(job(result, "page").status, "success"); // runtime if: true → ran
    assert.match(output, /PAGING/);
  });

  it("skips an if: job whose event.* condition evaluates false at runtime", async () => {
    const { result, output } = await runWith({ commonLabels: { severity: "info" } });
    assert.equal(result.status, "success");
    assert.match(output, /sev=info/);
    assert.equal(job(result, "page").status, "skipped"); // runtime if: false → skipped
    assert.doesNotMatch(output, /PAGING/);
  });
});
