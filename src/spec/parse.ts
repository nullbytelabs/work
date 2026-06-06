/**
 * YAML -> WorkflowSpec parsing + validation.
 *
 * Validation is intentionally strict and human-friendly: errors collect a path
 * (e.g. `jobs.build.steps[0]`) so authoring mistakes are easy to locate. The
 * parser does NOT execute anything — it only produces a validated spec object.
 */
import { parse as parseYaml } from "yaml";
import type { EnvMap, InputSpec, JobSpec, MatrixSpec, MatrixValue, OnSpec, StepSpec, StrategySpec, WebhookTrigger, WorkflowSpec } from "./types.ts";

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
function parseInputs(raw: unknown, path: string): Record<string, InputSpec> | undefined {
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
 * Accepted (GitHub-ish) forms, all opting the workflow in to webhook triggering:
 *   - `on: webhook`                                    (string → `{ webhook: true }`)
 *   - `on: { webhook: true }` / `on: { webhook: false }`
 *   - `on: { webhook: { secret: "name", source: "alertmanager" } }`
 *
 * We are deliberately **liberal about unknown top-level keys** under `on:` — an
 * older or future spec may carry other trigger names we don't model yet, and
 * `on:` is non-load-bearing for execution, so we don't want to break those
 * workflows. But once a `webhook` block is present we validate it **strictly**:
 * a malformed webhook declaration is an authoring error worth surfacing, since
 * it gates a security-sensitive remote trigger. Returns undefined when `on:` is
 * absent so the caller can leave `spec.on` unset.
 */
function parseOn(raw: unknown, path: string): OnSpec | undefined {
  if (raw === undefined || raw === null) return undefined;

  // String shorthand: `on: webhook` — the only bare trigger name we recognise.
  if (typeof raw === "string") {
    if (raw === "webhook") return { webhook: true };
    throw new WorkflowParseError(`unknown trigger "${raw}" (the only supported trigger is "webhook")`, path);
  }

  if (!isPlainObject(raw)) {
    throw new WorkflowParseError('on must be "webhook" or a mapping of triggers', path);
  }

  // Be liberal: pass through unknown trigger keys untouched (we only model
  // `webhook`). Absence of `webhook` is fine — it just means not webhook-triggerable.
  if (raw.webhook === undefined) return {};

  const wp = `${path}.webhook`;
  const wh = raw.webhook;

  // Boolean opt-in/out: `webhook: true` / `webhook: false`.
  if (typeof wh === "boolean") return { webhook: wh };

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
  return { webhook: trigger };
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

function parseJob(raw: unknown, path: string): JobSpec {
  if (!isPlainObject(raw)) throw new WorkflowParseError("job must be a mapping", path);

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

  if (raw.runsOn !== undefined || raw["runs-on"] !== undefined) {
    const runsOn = raw.runsOn ?? raw["runs-on"];
    if (typeof runsOn !== "string") {
      throw new WorkflowParseError("runs-on must be a string", `${path}.runs-on`);
    }
    job.runsOn = runsOn;
  }

  if (raw.needs !== undefined) {
    const needs = Array.isArray(raw.needs) ? raw.needs : [raw.needs];
    if (!needs.every((n) => typeof n === "string")) {
      throw new WorkflowParseError("needs must be a string or array of strings", `${path}.needs`);
    }
    job.needs = needs as string[];
  }

  const env = parseEnv(raw.env, `${path}.env`);
  if (env) job.env = env;

  if (raw.outputs !== undefined) {
    if (!isPlainObject(raw.outputs)) {
      throw new WorkflowParseError("outputs must be a mapping of name -> expression", `${path}.outputs`);
    }
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.outputs)) {
      if (typeof v !== "string") throw new WorkflowParseError(`output "${k}" must be a string expression`, `${path}.outputs`);
      outputs[k] = v;
    }
    job.outputs = outputs;
  }

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
