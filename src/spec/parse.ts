/**
 * YAML -> WorkflowSpec parsing + validation.
 *
 * Validation is intentionally strict and human-friendly: errors collect a path
 * (e.g. `jobs.build.steps[0]`) so authoring mistakes are easy to locate. The
 * parser does NOT execute anything — it only produces a validated spec object.
 */
import { parse as parseYaml } from "yaml";
import type { EnvMap, InputSpec, JobSpec, MachineSpec, MatrixSpec, MatrixValue, OnSpec, StepSpec, StrategySpec, WebhookTrigger, WorkflowCallSpec, WorkflowSpec } from "./types.ts";

/** Thrown when a workflow file is structurally invalid. */
export class WorkflowParseError extends Error {
  readonly path?: string;
  constructor(message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "WorkflowParseError";
    this.path = path;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a YAML scalar map into a string->string env map. */
function parseEnv(raw: unknown, path: string): EnvMap | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new WorkflowParseError("must be a mapping of name -> value", path);
  const out: EnvMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || typeof v === "object") {
      throw new WorkflowParseError(`value for "${k}" must be a scalar`, path);
    }
    out[k] = String(v);
  }
  return out;
}

const INPUT_TYPES = new Set(["string", "boolean", "number"]);

/** Parse the workflow `inputs:` block. `name:` (null) is shorthand for an optional string. */
export function parseInputs(raw: unknown, path: string): Record<string, InputSpec> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new WorkflowParseError("inputs must be a mapping of name -> declaration", path);

  const out: Record<string, InputSpec> = {};
  for (const [name, decl] of Object.entries(raw)) {
    out[name] = parseInputDecl(decl, name, `${path}.${name}`);
  }
  return out;
}

/** One input declaration: null (optional string), a scalar default, or a mapping. */
function parseInputDecl(decl: unknown, name: string, ip: string): InputSpec {
  if (decl === null || decl === undefined) return {}; // shorthand: optional string
  // Scalar shorthand: `age: 36` => a number input defaulting to 36; the type
  // is inferred from the scalar (string | number | boolean).
  if (typeof decl === "string" || typeof decl === "number" || typeof decl === "boolean") {
    return { type: typeof decl as InputSpec["type"], default: decl };
  }
  if (!isPlainObject(decl)) {
    throw new WorkflowParseError(`input "${name}" must be a mapping, a scalar default, or empty`, ip);
  }
  return parseInputMapping(decl, ip);
}

/** The full mapping form of an input declaration. */
function parseInputMapping(decl: Record<string, unknown>, ip: string): InputSpec {
  const spec: InputSpec = {};
  if (decl.type !== undefined) {
    if (typeof decl.type !== "string" || !INPUT_TYPES.has(decl.type)) {
      throw new WorkflowParseError('type must be one of "string", "boolean", "number"', `${ip}.type`);
    }
    spec.type = decl.type as InputSpec["type"];
  }
  if (decl.required !== undefined) {
    if (typeof decl.required !== "boolean") throw new WorkflowParseError("required must be a boolean", `${ip}.required`);
    spec.required = decl.required;
  }
  if (decl.default !== undefined) {
    const t = typeof decl.default;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      throw new WorkflowParseError("default must be a scalar", `${ip}.default`);
    }
    spec.default = decl.default as InputSpec["default"];
  }
  if (decl.description !== undefined) {
    if (typeof decl.description !== "string") throw new WorkflowParseError("description must be a string", `${ip}.description`);
    spec.description = decl.description;
  }

  const effectiveType = spec.type ?? "string";
  if (decl.options !== undefined) spec.options = parseInputOptions(decl.options, effectiveType, `${ip}.options`);
  if (decl.pattern !== undefined) spec.pattern = parseInputPattern(decl.pattern, effectiveType, ip);
  return spec;
}

/** Validate `options:` — a non-empty array of scalars matching the input's type. */
function parseInputOptions(options: unknown, effectiveType: string, path: string): InputSpec["options"] {
  if (!Array.isArray(options) || options.length === 0) {
    throw new WorkflowParseError("options must be a non-empty array", path);
  }
  for (const o of options) {
    if (typeof o !== effectiveType) {
      throw new WorkflowParseError(`options entries must be of type ${effectiveType}`, path);
    }
  }
  return options as InputSpec["options"];
}

/** Validate `pattern:` — a valid regex, string inputs only. */
function parseInputPattern(pattern: unknown, effectiveType: string, ip: string): string {
  if (typeof pattern !== "string") throw new WorkflowParseError("pattern must be a string", `${ip}.pattern`);
  try {
    new RegExp(pattern);
  } catch {
    throw new WorkflowParseError("pattern is not a valid regular expression", `${ip}.pattern`);
  }
  if (effectiveType !== "string") {
    throw new WorkflowParseError("pattern only applies to string inputs", ip);
  }
  return pattern;
}

/**
 * Parse a conditional guard. `if:` and `when:` are accepted as synonyms (a step
 * or job may use either, but not both). The value is a string expression,
 * evaluated at runtime; the spec only validates its shape here. A boolean
 * literal is allowed as a convenience (`if: true`) and stringified.
 */
function parseCondition(raw: Record<string, unknown>, path: string): string | undefined {
  if (raw.if !== undefined && raw.when !== undefined) {
    throw new WorkflowParseError('use either "if" or "when", not both', path);
  }
  const cond = raw.if ?? raw.when;
  if (cond === undefined) return undefined;
  if (typeof cond === "boolean" || typeof cond === "number") return String(cond);
  if (typeof cond !== "string") {
    throw new WorkflowParseError('"if"/"when" must be a string expression', path);
  }
  if (cond.trim() === "") throw new WorkflowParseError('"if"/"when" must not be empty', path);
  return cond;
}

/** Parse a single matrix cell (`include`/`exclude` entry): a mapping of scalars. */
function parseMatrixCell(raw: unknown, path: string): Record<string, MatrixValue> {
  if (!isPlainObject(raw)) throw new WorkflowParseError("must be a mapping of axis -> value", path);
  const cell: Record<string, MatrixValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || typeof v === "object") {
      throw new WorkflowParseError(`value for "${k}" must be a scalar`, path);
    }
    cell[k] = v as MatrixValue;
  }
  return cell;
}

/** Parse `strategy:` (currently just `matrix`). Returns undefined when absent. */
function parseStrategy(raw: unknown, path: string): StrategySpec | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new WorkflowParseError("strategy must be a mapping", path);
  if (raw.matrix === undefined) return undefined;

  const mp = `${path}.matrix`;
  if (!isPlainObject(raw.matrix)) throw new WorkflowParseError("matrix must be a mapping", mp);

  const axes: Record<string, MatrixValue[]> = {};
  let include: Record<string, MatrixValue>[] | undefined;
  let exclude: Record<string, MatrixValue>[] | undefined;

  for (const [key, val] of Object.entries(raw.matrix)) {
    if (key === "include" || key === "exclude") {
      if (!Array.isArray(val)) throw new WorkflowParseError(`${key} must be an array of cells`, `${mp}.${key}`);
      const cells = val.map((c, i) => parseMatrixCell(c, `${mp}.${key}[${i}]`));
      if (key === "include") include = cells;
      else exclude = cells;
      continue;
    }
    // An axis: name -> non-empty array of scalars.
    if (!Array.isArray(val) || val.length === 0) {
      throw new WorkflowParseError(`axis "${key}" must be a non-empty array of values`, `${mp}.${key}`);
    }
    for (const v of val) {
      if (v === null || typeof v === "object") {
        throw new WorkflowParseError(`axis "${key}" values must be scalars`, `${mp}.${key}`);
      }
    }
    axes[key] = val as MatrixValue[];
  }

  if (Object.keys(axes).length === 0 && include === undefined) {
    throw new WorkflowParseError("matrix must declare at least one axis or an include", mp);
  }

  const matrix: MatrixSpec = { axes };
  if (include) matrix.include = include;
  if (exclude) matrix.exclude = exclude;
  return { matrix };
}

/**
 * Parse the `on:` trigger block into a typed `OnSpec`.
 *
 * Accepted (GitHub-ish) forms:
 *   - `on: webhook` / `on: workflow_call`              (string → `{ <t>: true }`)
 *   - `on: { webhook: true }` / `on: { webhook: false }`
 *   - `on: { webhook: { secret: "name", source: "alertmanager" } }`
 *   - `on: { workflow_call: true }` / `on: { workflow_call: { outputs: {...} } }`
 *
 * We are deliberately **liberal about unknown top-level keys** under `on:` — an
 * older or future spec may carry other trigger names we don't model yet, and
 * `on:` is non-load-bearing for the receiver side, so we don't want to break
 * those workflows. But once a modeled block (`webhook`, `workflow_call`) is
 * present we validate it **strictly**: a malformed declaration is an authoring
 * error worth surfacing — `webhook` gates a security-sensitive remote trigger,
 * and `workflow_call` gates reusable-workflow callability. Returns undefined when
 * `on:` is absent so the caller can leave `spec.on` unset.
 */
function parseOn(raw: unknown, path: string): OnSpec | undefined {
  if (raw === undefined || raw === null) return undefined;

  // String shorthand: a bare trigger name.
  if (typeof raw === "string") {
    if (raw === "webhook") return { webhook: true };
    if (raw === "workflow_call") return { workflow_call: true };
    throw new WorkflowParseError(`unknown trigger "${raw}" (supported triggers are "webhook", "workflow_call")`, path);
  }

  if (!isPlainObject(raw)) {
    throw new WorkflowParseError("on must be a trigger name or a mapping of triggers", path);
  }

  // Be liberal: pass through unknown trigger keys untouched. Absence of every
  // modeled trigger is fine — it just means none of them are opted into.
  const on: OnSpec = {};
  if (raw.webhook !== undefined) on.webhook = parseWebhook(raw.webhook, `${path}.webhook`);
  if (raw.workflow_call !== undefined) on.workflow_call = parseWorkflowCall(raw.workflow_call, `${path}.workflow_call`);
  return on;
}

/** Parse the `webhook` trigger: boolean opt-in/out, or a `{ secret, source }` mapping. */
function parseWebhook(wh: unknown, wp: string): WebhookTrigger | boolean {
  if (typeof wh === "boolean") return wh;
  if (!isPlainObject(wh)) {
    throw new WorkflowParseError("webhook must be a boolean or a mapping (secret, source)", wp);
  }
  const trigger: WebhookTrigger = {};
  if (wh.secret !== undefined) {
    if (typeof wh.secret !== "string" || wh.secret.trim() === "") {
      throw new WorkflowParseError("secret must be a non-empty string naming a config entry", `${wp}.secret`);
    }
    trigger.secret = wh.secret;
  }
  if (wh.source !== undefined) {
    if (typeof wh.source !== "string" || wh.source.trim() === "") {
      throw new WorkflowParseError("source must be a non-empty string", `${wp}.source`);
    }
    trigger.source = wh.source;
  }
  return trigger;
}

/**
 * Parse the `workflow_call` trigger: boolean opt-in/out, or a `{ outputs }`
 * mapping declaring the flat output surface the callee exposes to its caller.
 * Output *values* are `${{ }}` expressions validated structurally here (strings);
 * the compiler rewrites them onto the callee's real producer job when inlining.
 */
function parseWorkflowCall(wc: unknown, wp: string): WorkflowCallSpec | boolean {
  if (typeof wc === "boolean") return wc;
  if (!isPlainObject(wc)) {
    throw new WorkflowParseError("workflow_call must be a boolean or a mapping (outputs)", wp);
  }
  const spec: WorkflowCallSpec = {};
  if (wc.outputs !== undefined) {
    if (!isPlainObject(wc.outputs)) {
      throw new WorkflowParseError("outputs must be a mapping of name -> expression", `${wp}.outputs`);
    }
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(wc.outputs)) {
      if (typeof v !== "string" || v.trim() === "") {
        throw new WorkflowParseError(`output "${k}" must be a non-empty string expression`, `${wp}.outputs`);
      }
      outputs[k] = v;
    }
    spec.outputs = outputs;
  }
  return spec;
}

function parseStep(raw: unknown, path: string): StepSpec {
  if (!isPlainObject(raw)) throw new WorkflowParseError("step must be a mapping", path);

  const hasRun = typeof raw.run === "string";
  const hasUses = typeof raw.uses === "string";
  if (!hasRun && !hasUses) {
    throw new WorkflowParseError('step must define either "run" or "uses"', path);
  }
  if (hasRun && hasUses) {
    throw new WorkflowParseError('step cannot define both "run" and "uses"', path);
  }

  const step: StepSpec = {};
  if (typeof raw.name === "string") step.name = raw.name;
  if (typeof raw.id === "string") step.id = raw.id;
  if (hasRun) step.run = raw.run as string;
  if (hasUses) step.uses = raw.uses as string;
  if (isPlainObject(raw.with)) step.with = raw.with;
  const cond = parseCondition(raw, path);
  if (cond !== undefined) step.if = cond;
  const env = parseEnv(raw.env, `${path}.env`);
  if (env) step.env = env;
  return step;
}

/**
 * Parse `machine:` — a string (named type) or a mapping of cpus/memory. This
 * validates only the *shape*; the compiler resolves named types and checks value
 * ranges/formats against the catalog.
 */
function parseMachine(raw: unknown, path: string): MachineSpec | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  if (!isPlainObject(raw)) {
    throw new WorkflowParseError("machine must be a string (named type) or a mapping (cpus/memory)", path);
  }
  const spec: { cpus?: number; memory?: string } = {};
  if (raw.cpus !== undefined) {
    if (typeof raw.cpus !== "number") throw new WorkflowParseError("machine.cpus must be a number", `${path}.cpus`);
    spec.cpus = raw.cpus;
  }
  if (raw.memory !== undefined) {
    if (typeof raw.memory !== "string") throw new WorkflowParseError('machine.memory must be a string (e.g. "8G")', `${path}.memory`);
    spec.memory = raw.memory;
  }
  return spec;
}

/** Parse the `needs:` of a job (string or array of strings) onto `job`. Shared by both job kinds. */
function parseNeeds(raw: Record<string, unknown>, job: JobSpec, path: string): void {
  if (raw.needs === undefined) return;
  const needs = Array.isArray(raw.needs) ? raw.needs : [raw.needs];
  if (!needs.every((n) => typeof n === "string")) {
    throw new WorkflowParseError("needs must be a string or array of strings", `${path}.needs`);
  }
  job.needs = needs as string[];
}

/**
 * A job is **either** a `steps:` job or a `uses:` job (a reusable-workflow call),
 * never both — mirroring the `run`-xor-`uses` rule on a step. Both kinds may carry
 * `needs`/`if`/`strategy`; a `uses:` job additionally takes `with:` and forbids
 * the execution-shaped keys (`runs-on`/`machine`/`env`/`outputs`) because those
 * belong to the called workflow's own jobs, not the call site.
 */
function parseJob(raw: unknown, path: string): JobSpec {
  if (!isPlainObject(raw)) throw new WorkflowParseError("job must be a mapping", path);

  const hasUses = typeof raw.uses === "string";
  const hasSteps = raw.steps !== undefined;
  if (hasUses && hasSteps) {
    throw new WorkflowParseError('job cannot define both "steps" and "uses"', path);
  }
  if (!hasUses && !hasSteps) {
    throw new WorkflowParseError('job must define either "steps" or "uses"', path);
  }

  return hasUses ? parseUsesJob(raw, path) : parseStepsJob(raw, path);
}

/** A `steps:` job: ordered steps plus the optional sizing/env/outputs/needs/if/strategy. */
function parseStepsJob(raw: Record<string, unknown>, path: string): JobSpec {
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new WorkflowParseError("job must have a non-empty steps array", `${path}.steps`);
  }
  const job: JobSpec = {
    steps: raw.steps.map((s, i) => parseStep(s, `${path}.steps[${i}]`)),
  };

  const cond = parseCondition(raw, path);
  if (cond !== undefined) job.if = cond;

  const strategy = parseStrategy(raw.strategy, `${path}.strategy`);
  if (strategy) job.strategy = strategy;

  if (raw.with !== undefined) {
    throw new WorkflowParseError('"with" is only valid on a "uses" job', `${path}.with`);
  }

  if (raw.runsOn !== undefined || raw["runs-on"] !== undefined) {
    const runsOn = raw.runsOn ?? raw["runs-on"];
    if (typeof runsOn !== "string") {
      throw new WorkflowParseError("runs-on must be a string", `${path}.runs-on`);
    }
    job.runsOn = runsOn;
  }

  const machine = parseMachine(raw.machine, `${path}.machine`);
  if (machine !== undefined) job.machine = machine;

  parseNeeds(raw, job, path);

  const env = parseEnv(raw.env, `${path}.env`);
  if (env) job.env = env;

  if (raw.outputs !== undefined) {
    job.outputs = parseJobOutputs(raw.outputs, `${path}.outputs`);
  }

  return job;
}

/** Parse a `steps:` job's `outputs:` (name -> expression string). */
function parseJobOutputs(raw: unknown, path: string): Record<string, string> {
  if (!isPlainObject(raw)) {
    throw new WorkflowParseError("outputs must be a mapping of name -> expression", path);
  }
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new WorkflowParseError(`output "${k}" must be a string expression`, path);
    outputs[k] = v;
  }
  return outputs;
}

/** A reusable-workflow caller job: `uses:` + optional `with`/`needs`/`if`/`strategy`. */
function parseUsesJob(raw: Record<string, unknown>, path: string): JobSpec {
  const job: JobSpec = { uses: raw.uses as string };

  // Execution-shaped keys belong to the callee's jobs, not the call site.
  for (const k of ["runs-on", "runsOn", "machine", "env", "outputs"]) {
    if (raw[k] !== undefined) {
      throw new WorkflowParseError(`"${k}" is not allowed on a "uses" job — it belongs to the called workflow`, `${path}.${k}`);
    }
  }

  if (raw.with !== undefined) {
    if (!isPlainObject(raw.with)) {
      throw new WorkflowParseError("with must be a mapping of input -> value", `${path}.with`);
    }
    job.with = raw.with;
  }

  const cond = parseCondition(raw, path);
  if (cond !== undefined) job.if = cond;

  const strategy = parseStrategy(raw.strategy, `${path}.strategy`);
  if (strategy) job.strategy = strategy;

  parseNeeds(raw, job, path);

  return job;
}

/** Parse and validate a workflow YAML document into a WorkflowSpec. */
export function parseWorkflow(yamlText: string): WorkflowSpec {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    throw new WorkflowParseError(`invalid YAML: ${(err as Error).message}`);
  }

  if (!isPlainObject(doc)) throw new WorkflowParseError("workflow must be a mapping at the top level");

  if (typeof doc.name !== "string" || doc.name.trim() === "") {
    throw new WorkflowParseError('missing required string field "name"');
  }

  if (!isPlainObject(doc.jobs) || Object.keys(doc.jobs).length === 0) {
    throw new WorkflowParseError('missing required field "jobs" (must have at least one job)', "jobs");
  }

  // `runs-on` is per-job only — there is no workflow-level default.
  if (doc.runsOn !== undefined || doc["runs-on"] !== undefined) {
    throw new WorkflowParseError(
      "runs-on is defined per job, not at the workflow level — move it under each job",
      "runs-on",
    );
  }

  const jobs: Record<string, JobSpec> = {};
  for (const [jobId, rawJob] of Object.entries(doc.jobs)) {
    // Common authoring slip: `runs-on` placed as a key inside `jobs:` instead of
    // on a job. Detect it and point at the right spot.
    if ((jobId === "runs-on" || jobId === "runsOn") && typeof rawJob === "string") {
      throw new WorkflowParseError(
        "runs-on belongs on an individual job, not directly under the jobs map",
        `jobs.${jobId}`,
      );
    }
    jobs[jobId] = parseJob(rawJob, `jobs.${jobId}`);
  }

  // Validate `needs` references point at real jobs.
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const dep of job.needs ?? []) {
      if (!(dep in jobs)) {
        throw new WorkflowParseError(`unknown job in needs: "${dep}"`, `jobs.${jobId}.needs`);
      }
    }
  }

  const spec: WorkflowSpec = { name: doc.name, jobs };
  const on = parseOn(doc.on, "on");
  if (on !== undefined) spec.on = on;
  const inputs = parseInputs(doc.inputs, "inputs");
  if (inputs) spec.inputs = inputs;
  const env = parseEnv(doc.env, "env");
  if (env) spec.env = env;

  return spec;
}
