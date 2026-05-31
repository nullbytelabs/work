/**
 * YAML -> WorkflowSpec parsing + validation.
 *
 * Validation is intentionally strict and human-friendly: errors collect a path
 * (e.g. `jobs.build.steps[0]`) so authoring mistakes are easy to locate. The
 * parser does NOT execute anything — it only produces a validated spec object.
 */
import { parse as parseYaml } from "yaml";
import type { EnvMap, InputSpec, JobSpec, StepSpec, WorkflowSpec } from "./types.ts";

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
    const ip = `${path}.${name}`;
    if (decl === null || decl === undefined) {
      out[name] = {}; // shorthand: optional string
      continue;
    }
    // Scalar shorthand: `age: 36` => a number input defaulting to 36; the type
    // is inferred from the scalar (string | number | boolean).
    if (typeof decl === "string" || typeof decl === "number" || typeof decl === "boolean") {
      out[name] = { type: typeof decl as InputSpec["type"], default: decl };
      continue;
    }
    if (!isPlainObject(decl)) {
      throw new WorkflowParseError(`input "${name}" must be a mapping, a scalar default, or empty`, ip);
    }
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

    if (decl.options !== undefined) {
      if (!Array.isArray(decl.options) || decl.options.length === 0) {
        throw new WorkflowParseError("options must be a non-empty array", `${ip}.options`);
      }
      for (const o of decl.options) {
        if (typeof o !== effectiveType) {
          throw new WorkflowParseError(`options entries must be of type ${effectiveType}`, `${ip}.options`);
        }
      }
      spec.options = decl.options as InputSpec["options"];
    }
    if (decl.pattern !== undefined) {
      if (typeof decl.pattern !== "string") throw new WorkflowParseError("pattern must be a string", `${ip}.pattern`);
      try {
        new RegExp(decl.pattern);
      } catch {
        throw new WorkflowParseError("pattern is not a valid regular expression", `${ip}.pattern`);
      }
      if (effectiveType !== "string") {
        throw new WorkflowParseError("pattern only applies to string inputs", ip);
      }
      spec.pattern = decl.pattern;
    }

    out[name] = spec;
  }
  return out;
}

/**
 * Conditionals (`if` / `when`) are modeled in the spec but NOT yet evaluated by
 * the runtime. Reject them at parse time so a condition is never silently
 * ignored (which would be worse than not supporting it).
 */
function rejectConditionals(raw: Record<string, unknown>, path: string): void {
  if (raw.if !== undefined || raw.when !== undefined) {
    throw new WorkflowParseError(
      "conditionals (if/when) aren't supported yet — remove the condition",
      path,
    );
  }
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
  rejectConditionals(raw, path);

  const step: StepSpec = {};
  if (typeof raw.name === "string") step.name = raw.name;
  if (typeof raw.id === "string") step.id = raw.id;
  if (hasRun) step.run = raw.run as string;
  if (hasUses) step.uses = raw.uses as string;
  if (isPlainObject(raw.with)) step.with = raw.with;
  const env = parseEnv(raw.env, `${path}.env`);
  if (env) step.env = env;
  return step;
}

function parseJob(raw: unknown, path: string): JobSpec {
  if (!isPlainObject(raw)) throw new WorkflowParseError("job must be a mapping", path);
  rejectConditionals(raw, path);

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new WorkflowParseError("job must have a non-empty steps array", `${path}.steps`);
  }

  const job: JobSpec = {
    steps: raw.steps.map((s, i) => parseStep(s, `${path}.steps[${i}]`)),
  };

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
  if (doc.on !== undefined) spec.on = doc.on;
  const inputs = parseInputs(doc.inputs, "inputs");
  if (inputs) spec.inputs = inputs;
  const env = parseEnv(doc.env, "env");
  if (env) spec.env = env;

  return spec;
}
