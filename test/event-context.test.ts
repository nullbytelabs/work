/**
 * The `event` context — the webhook/dispatch payload exposed as `${{ event.* }}`
 * in interpolation and `event.*` in `if:`/`when:` conditions.
 *
 * Covers the three surfaces of the trigger spine:
 *   - `interpolate(...)` path-walking + array indexing + stringification + deferral
 *   - `evaluateCondition(...)` with the `event` root and array indexing
 *   - `parseOn()` (via `parseWorkflow`) accepting the GitHub-ish `on: webhook` forms
 *   - `compile(spec, { event })` baking event into run/with strings end-to-end
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interpolate, evaluateCondition, compile, WorkflowCompileError } from "../src/compiler/index.ts";
import { parseWorkflow, WorkflowParseError } from "../src/spec/index.ts";

// A representative Alertmanager-shaped payload.
const PAYLOAD = {
  version: "4",
  status: "firing",
  commonLabels: { severity: "critical", service: "checkout" },
  alerts: [
    { labels: { severity: "page", alertname: "HighErrorRate" }, fingerprint: "abc" },
    { labels: { severity: "warn" } },
  ],
  "weird key": "ok",
};

describe("interpolate — event context", () => {
  it("walks nested dotted paths to scalars", () => {
    assert.equal(interpolate("${{ event.commonLabels.severity }}", { event: PAYLOAD }), "critical");
    assert.equal(interpolate("${{ event.status }}", { event: PAYLOAD }), "firing");
  });

  it("supports array indexing and mixed key/index paths", () => {
    assert.equal(interpolate("${{ event.alerts[0].labels.severity }}", { event: PAYLOAD }), "page");
    assert.equal(interpolate("${{ event.alerts[1].labels.severity }}", { event: PAYLOAD }), "warn");
    assert.equal(interpolate("${{ event.alerts[0].fingerprint }}", { event: PAYLOAD }), "abc");
  });

  it("supports bracketed quoted keys", () => {
    assert.equal(interpolate("${{ event['commonLabels'].severity }}", { event: PAYLOAD }), "critical");
    assert.equal(interpolate(`${"${{ event[\"weird key\"] }}"}`, { event: PAYLOAD }), "ok");
  });

  it("supports a bracketed quoted key that itself contains ]", () => {
    // The `]` inside the quotes must not be mistaken for the closing bracket.
    assert.equal(interpolate("${{ event['a]b'] }}", { event: { "a]b": "X" } }), "X");
  });

  it("stringifies the whole object / arrays as JSON", () => {
    assert.equal(interpolate("${{ event }}", { event: PAYLOAD }), JSON.stringify(PAYLOAD));
    assert.equal(
      interpolate("${{ event.alerts[0] }}", { event: PAYLOAD }),
      JSON.stringify(PAYLOAD.alerts[0]),
    );
    assert.equal(
      interpolate("${{ event.commonLabels }}", { event: PAYLOAD }),
      JSON.stringify(PAYLOAD.commonLabels),
    );
  });

  it("renders missing / null members as empty string", () => {
    assert.equal(interpolate("${{ event.nope }}", { event: PAYLOAD }), "");
    assert.equal(interpolate("${{ event.alerts[9].labels.severity }}", { event: PAYLOAD }), "");
    assert.equal(interpolate("${{ event.commonLabels.nope.deep }}", { event: PAYLOAD }), "");
    assert.equal(interpolate("${{ event.status.nope }}", { event: PAYLOAD }), ""); // scalar intermediate
  });

  it("coerces numeric/boolean scalars with String()", () => {
    assert.equal(interpolate("${{ event.n }}", { event: { n: 42 } }), "42");
    assert.equal(interpolate("${{ event.b }}", { event: { b: false } }), "false");
  });

  it("interpolates event inline within a larger string", () => {
    assert.equal(
      interpolate("sev=${{ event.commonLabels.severity }} svc=${{ event.commonLabels.service }}", { event: PAYLOAD }),
      "sev=critical svc=checkout",
    );
  });

  it("DEFERS (leaves intact) when ctx.event is absent", () => {
    // No event in context → expression survives for a later phase, like needs/steps.
    assert.equal(interpolate("${{ event.commonLabels.severity }}", {}), "${{ event.commonLabels.severity }}");
    assert.equal(interpolate("a ${{ event.x }} b", { inputs: {} }), "a ${{ event.x }} b");
  });

  it("still resolves inputs/matrix alongside event, and defers needs/steps", () => {
    const out = interpolate("${{ inputs.region }}/${{ event.status }}", {
      inputs: { region: "us" },
      event: PAYLOAD,
    });
    assert.equal(out, "us/firing");
    // needs left intact when not supplied
    assert.equal(
      interpolate("${{ needs.a.outputs.b }}|${{ event.status }}", { event: PAYLOAD }),
      "${{ needs.a.outputs.b }}|firing",
    );
  });

  it("rejects a malformed index", () => {
    assert.throws(() => interpolate("${{ event.alerts[x] }}", { event: PAYLOAD }), WorkflowCompileError);
  });

  it("unknown non-event roots still throw", () => {
    assert.throws(() => interpolate("${{ github.sha }}", { event: PAYLOAD }), WorkflowCompileError);
  });
});

describe("evaluateCondition — event root + array indexing", () => {
  const ctx = { event: PAYLOAD };

  it("reads nested event scalars", () => {
    assert.equal(evaluateCondition("event.commonLabels.severity == 'critical'", ctx), true);
    assert.equal(evaluateCondition("event.status == 'resolved'", ctx), false);
  });

  it("reads array-indexed event paths", () => {
    assert.equal(evaluateCondition("event.alerts[0].labels.severity == 'page'", ctx), true);
    assert.equal(evaluateCondition("event.alerts[1].labels.severity == 'page'", ctx), false);
    assert.equal(evaluateCondition("event.alerts[0].labels.severity == 'page' && event.status == 'firing'", ctx), true);
  });

  it("treats missing members as falsey", () => {
    assert.equal(evaluateCondition("event.nope", ctx), false);
    assert.equal(evaluateCondition("event.alerts[9].labels.severity == 'page'", ctx), false);
  });

  it("supports bracketed quoted keys in conditions", () => {
    assert.equal(evaluateCondition("event['commonLabels'].severity == 'critical'", ctx), true);
  });

  it("supports a bracketed quoted key that contains ] in conditions", () => {
    assert.equal(evaluateCondition("event['a]b'] == 'X'", { event: { "a]b": "X" } }), true);
  });

  it("array indexing works for other roots too (tokenizer-level feature)", () => {
    // `inputs` isn't an array here, but indexing into a present array member works.
    const c = { needs: { build: { result: "success", outputs: { dist: "./out" } } } };
    assert.equal(evaluateCondition("needs.build.result == 'success'", c), true);
  });

  it("unknown root still errors", () => {
    assert.throws(() => evaluateCondition("event2.x == 'y'", ctx));
    assert.throws(() => evaluateCondition("github.event.x == 'y'", ctx));
  });
});

describe("parseOn — on: webhook trigger forms", () => {
  const wrap = (on: string) => `
name: w
on:
${on}
jobs:
  a:
    steps:
      - run: "true"
`;

  it("accepts the string shorthand `on: webhook`", () => {
    const spec = parseWorkflow("name: w\non: webhook\njobs:\n  a:\n    steps:\n      - run: \"true\"\n");
    assert.deepEqual(spec.on, { webhook: true });
  });

  it("accepts `on: { webhook: true }` / `false`", () => {
    assert.deepEqual(parseWorkflow(wrap("  webhook: true")).on, { webhook: true });
    assert.deepEqual(parseWorkflow(wrap("  webhook: false")).on, { webhook: false });
  });

  it("accepts the expanded mapping with secret + source", () => {
    const spec = parseWorkflow(wrap("  webhook:\n    secret: deploy-incident\n    source: alertmanager"));
    assert.deepEqual(spec.on, { webhook: { secret: "deploy-incident", source: "alertmanager" } });
  });

  it("is liberal about unknown trigger keys (no webhook → empty OnSpec)", () => {
    const spec = parseWorkflow(wrap("  push: true"));
    assert.deepEqual(spec.on, {});
  });

  it("leaves spec.on unset when `on:` is absent", () => {
    const spec = parseWorkflow("name: w\njobs:\n  a:\n    steps:\n      - run: \"true\"\n");
    assert.equal(spec.on, undefined);
  });

  it("rejects an unknown bare trigger string", () => {
    assert.throws(() => parseWorkflow("name: w\non: push\njobs:\n  a:\n    steps:\n      - run: \"true\"\n"), WorkflowParseError);
  });

  it("rejects a malformed webhook block", () => {
    assert.throws(() => parseWorkflow(wrap("  webhook: 42")), WorkflowParseError);
    assert.throws(() => parseWorkflow(wrap("  webhook:\n    secret: 5")), WorkflowParseError);
    assert.throws(() => parseWorkflow(wrap("  webhook:\n    source: \"\"")), WorkflowParseError);
  });
});

describe("parseOn — on: schedule trigger forms", () => {
  const wrap = (on: string) => `
name: w
on:
${on}
jobs:
  a:
    steps:
      - run: "true"
`;

  it("accepts a single-entry schedule list", () => {
    const spec = parseWorkflow(wrap("  schedule:\n    - cron: '0 0 * * *'"));
    assert.deepEqual(spec.on, { schedule: [{ cron: "0 0 * * *" }] });
  });

  it("accepts multiple cron entries in order", () => {
    const spec = parseWorkflow(wrap("  schedule:\n    - cron: '30 5 * * 1-5'\n    - cron: '0 0 * * *'"));
    assert.deepEqual(spec.on, { schedule: [{ cron: "30 5 * * 1-5" }, { cron: "0 0 * * *" }] });
  });

  it("coexists with other triggers", () => {
    const spec = parseWorkflow(wrap("  webhook: true\n  schedule:\n    - cron: '0 0 * * *'"));
    assert.deepEqual(spec.on, { webhook: true, schedule: [{ cron: "0 0 * * *" }] });
  });

  it("rejects the bare string `on: schedule` with a form hint", () => {
    assert.throws(
      () => parseWorkflow("name: w\non: schedule\njobs:\n  a:\n    steps:\n      - run: \"true\"\n"),
      /list of cron entries/,
    );
  });

  it("rejects a non-list schedule", () => {
    assert.throws(() => parseWorkflow(wrap("  schedule: '0 0 * * *'")), WorkflowParseError);
  });

  it("rejects an empty schedule list", () => {
    assert.throws(() => parseWorkflow(wrap("  schedule: []")), WorkflowParseError);
  });

  it("rejects an entry without a cron field", () => {
    assert.throws(() => parseWorkflow(wrap("  schedule:\n    - tz: UTC")), WorkflowParseError);
  });

  it("rejects a non-string / empty cron", () => {
    assert.throws(() => parseWorkflow(wrap("  schedule:\n    - cron: 5")), WorkflowParseError);
    assert.throws(() => parseWorkflow(wrap("  schedule:\n    - cron: ''")), WorkflowParseError);
  });

  it("rejects an invalid cron expression at parse time", () => {
    assert.throws(
      () => parseWorkflow(wrap("  schedule:\n    - cron: 'not a cron'")),
      /invalid cron expression/,
    );
  });
});

describe("compile(spec, { event }) — bakes event into the plan", () => {
  it("resolves event.* in run / env / with / outputs at compile time", () => {
    const spec = parseWorkflow(`
name: incident
on: webhook
jobs:
  triage:
    outputs:
      sev: "\${{ event.commonLabels.severity }}"
    steps:
      - id: q
        env:
          SVC: "\${{ event.commonLabels.service }}"
        run: 'echo sev=\${{ event.alerts[0].labels.severity }}'
      - uses: action/triage
        with:
          alert: "\${{ event }}"
`);
    const plan = compile(spec, { event: PAYLOAD });
    const job = plan.jobs["triage"]!;
    assert.equal(job.steps[0]!.run, "echo sev=page");
    assert.equal(job.steps[0]!.env["SVC"], "checkout");
    assert.equal(job.steps[1]!.with!["alert"], JSON.stringify(PAYLOAD));
    assert.equal(job.outputs!["sev"], "critical");
    assert.deepEqual(plan.event, PAYLOAD);
  });

  it("leaves event.* intact when no event is supplied", () => {
    const spec = parseWorkflow(`
name: incident
on: webhook
jobs:
  a:
    steps:
      - run: 'echo \${{ event.status }}'
`);
    const plan = compile(spec);
    assert.equal(plan.jobs["a"]!.steps[0]!.run, "echo ${{ event.status }}");
    assert.equal(plan.event, undefined);
  });
});

describe("event context — expression-injection neutralization", () => {
  // Regression (security): `event` is the ONE untrusted root — an internet-facing
  // webhook body. A payload value of `${{ secrets.token }}` used to bake VERBATIM
  // into the plan's run/env/with strings, which the runtime re-interpolates with
  // `secrets` in scope — resolving attacker text into the real secret (the GHA
  // pull_request_target injection class). Event-sourced `${{` must be neutralized.

  it("a payload ${{ secrets.* }} baked into run: does NOT resolve at runtime", () => {
    const spec = parseWorkflow(`
name: incident
on: webhook
jobs:
  echo:
    steps:
      - run: 'echo "\${{ event.alerts[0].labels.severity }}"'
`);
    const evil = { alerts: [{ labels: { severity: "${{ secrets.token }}" } }] };
    const plan = compile(spec, { event: evil });
    const baked = plan.jobs["echo"]!.steps[0]!.run!;
    // The opener is broken at bake time — no live `${{ }}` span survives.
    assert.ok(!baked.includes("${{"), `plan still contains a live opener: ${baked}`);
    // The runtime re-interpolation (needs/steps/secrets in scope) resolves nothing.
    const resolved = interpolate(baked, { secrets: { token: "SUPERSECRET-abc-123" } });
    assert.ok(!resolved.includes("SUPERSECRET"), `secret exfiltrated: ${resolved}`);
  });

  it("neutralizes ${{ in JSON-stringified whole-event/object values too", () => {
    const evil = { note: "${{ needs.build.outputs.version }}" };
    const asJson = interpolate("${{ event }}", { event: evil });
    assert.ok(!asJson.includes("${{"), `JSON branch leaked an opener: ${asJson}`);
    assert.match(asJson, /needs\.build\.outputs\.version/);
  });

  it("benign payload text (no ${{ ) passes through byte-for-byte", () => {
    assert.equal(
      interpolate("${{ event.msg }}", { event: { msg: "deploy ${VERSION} now { } $$" } }),
      "deploy ${VERSION} now { } $$",
    );
  });
});
