/**
 * `work.json` `secrets:` passthrough — the `${{ secrets.<name> }}` whitelist that
 * materializes a host secret into a step's guest env (path b), for CLIs that must
 * hold the credential to sign (aws/gcloud/kubectl). See docs/egress-walk-back.md.
 *
 * Covers every layer the value crosses:
 *   - expr     — `secrets.*` defers at compile, resolves at runtime, throws undeclared
 *   - condition — `secrets.*` is NOT a condition root (can't branch on / leak a secret)
 *   - config   — parse + merge of the `secrets:` block
 *   - wiring   — startRun threads expanded secrets into a run step's env/run, end to
 *                end through the HostTarget double; and the COMPILED PLAN keeps the
 *                literal `${{ secrets.* }}` (the value never bakes into the durable plan)
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpolate, type ExprContext } from "../src/compiler/expr.ts";
import { WorkflowCompileError } from "../src/compiler/compile.ts";
import { evaluateCondition, ConditionError } from "../src/compiler/condition.ts";
import { parsePartialConfig, mergeConfig } from "../src/config/index.ts";
import { compile } from "../src/compiler/index.ts";
import { parseWorkflow } from "../src/spec/index.ts";
import { createAbsurdEngine, type AbsurdEngine } from "../src/runtime/index.ts";
import { startRun } from "../src/run.ts";
import { hostTargetFactory } from "./_support.ts";

describe("secrets — expression resolution", () => {
  it("defers `secrets.*` when no secrets context is supplied (compile time)", () => {
    // Absent ctx.secrets → left verbatim, exactly like needs/steps/event. This is
    // what keeps the value out of the compiled plan.
    assert.equal(interpolate("k=${{ secrets.TOKEN }}", {}), "k=${{ secrets.TOKEN }}");
  });

  it("resolves `secrets.*` from a supplied context (runtime)", () => {
    const ctx: ExprContext = { secrets: { TOKEN: "s3cr3t" } };
    assert.equal(interpolate("k=${{ secrets.TOKEN }}", ctx), "k=s3cr3t");
    // Bracket form too, for non-bare-identifier keys.
    assert.equal(interpolate("${{ secrets['TOKEN'] }}", ctx), "s3cr3t");
  });

  it("throws on an undeclared secret when the context is present", () => {
    const ctx: ExprContext = { secrets: { TOKEN: "x" } };
    assert.throws(() => interpolate("${{ secrets.NOPE }}", ctx), WorkflowCompileError);
  });
});

describe("secrets — not a condition root", () => {
  it("`if: secrets.X` is rejected (a condition can't branch on a secret)", () => {
    assert.throws(() => evaluateCondition("secrets.TOKEN == 'x'"), ConditionError);
  });
});

describe("secrets — config parse + merge", () => {
  it("parses a `secrets:` block of name → value strings", () => {
    const c = parsePartialConfig({
      providers: {},
      models: {},
      secrets: { AWS_ACCESS_KEY_ID: "$AWS_ACCESS_KEY_ID", DEPLOY_PAT: "ghp_literal" },
    });
    assert.deepEqual(c.secrets, { AWS_ACCESS_KEY_ID: "$AWS_ACCESS_KEY_ID", DEPLOY_PAT: "ghp_literal" });
  });

  it("rejects a non-string secret value", () => {
    assert.throws(
      () => parsePartialConfig({ providers: {}, models: {}, secrets: { BAD: 123 } }),
      /config\.secrets\.BAD must be a string/,
    );
  });

  it("merges by key — the project layer overrides global", () => {
    const base = parsePartialConfig({ providers: {}, models: {}, secrets: { A: "global-a", B: "global-b" } });
    const over = parsePartialConfig({ providers: {}, models: {}, secrets: { B: "proj-b" } });
    assert.deepEqual(mergeConfig(base, over).secrets, { A: "global-a", B: "proj-b" });
  });
});

describe("secrets — end-to-end passthrough into a run step", () => {
  let engine: AbsurdEngine;
  before(async () => {
    process.env["SECRETS_TEST_AWS"] = "AKIA-from-env";
    engine = await createAbsurdEngine();
  });
  after(async () => {
    await engine.close();
    delete process.env["SECRETS_TEST_AWS"];
  });

  const YAML = `name: sec
jobs:
  use:
    runs-on: gondolin
    steps:
      - id: viaRun
        run: echo "run=\${{ secrets.AWS }}"
      - id: viaEnv
        env:
          PASSED: "\${{ secrets.AWS }}"
        run: echo "env=$PASSED"
`;

  it("materializes `${{ secrets.* }}` (env-expanded) into run: and env:, but not the plan", async () => {
    const config = parsePartialConfig({ providers: {}, models: {}, secrets: { AWS: "$SECRETS_TEST_AWS" } });

    // The compiled plan must KEEP the literal — the value never bakes in (it would
    // otherwise persist to PGLite / a plan dump).
    const plan = compile(parseWorkflow(YAML));
    const planJson = JSON.stringify(plan);
    assert.ok(planJson.includes("${{ secrets.AWS }}"), "plan should retain the literal expression");
    assert.ok(!planJson.includes("AKIA-from-env"), "plan must NOT contain the resolved secret value");

    const workRoot = await mkdtemp(join(tmpdir(), "pi-wf-sec-"));
    try {
      const result = await startRun({ plan, workdir: workRoot, engine, config, makeTarget: hostTargetFactory });
      assert.equal(result.status, "success");
      const steps = result.jobs.find((j) => j.id === "use")!.steps;
      const out = (name: string) => steps.find((s) => s.name.endsWith(name))!.stdout;
      assert.match(out("viaRun"), /run=AKIA-from-env/);
      assert.match(out("viaEnv"), /env=AKIA-from-env/);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
