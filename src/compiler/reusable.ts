/**
 * Reusable-workflow inlining by **substitution** (see docs/reusable-workflows.md).
 *
 * A `uses:` job calls a whole workflow as a unit. The compiler resolves the
 * callee, binds the caller's `with:` to its inputs, **recursively compiles it**,
 * and splices its jobs into the caller's flat plan — as if the callee's jobs had
 * been written in place. There is no synthetic "join" node: the call is replaced
 * by the callee's actual jobs.
 *
 * Two shapes, one rule (collapse when unambiguous):
 *
 *  - **Single-job callee** → that one job *adopts the call's id*. `uses: workflow/checks`
 *    where `checks.yaml` has a lone job `static` compiles to a single real job
 *    `checks` (with `static`'s steps). A downstream `needs: [checks]` and
 *    `needs.checks.outputs.*` resolve against it directly — the call id *is* the job.
 *
 *  - **Multi-job callee** → its jobs are inlined with namespaced ids `<call>__<job>`.
 *    A downstream `needs: [C]` attaches to the callee's leaf jobs (its terminal
 *    nodes); `needs.C.outputs.<name>` is rewritten by the compiler onto the job
 *    that actually produces it. The call boundary disappears into the DAG.
 *
 * In both cases the caller's `needs:` flow into the callee's root jobs and a
 * call-level `if:` propagates to them, so runtime data and gating reach the
 * callee through the normal `needs` graph (see §8).
 *
 * ## Namespacing separator
 * Inlined sub-jobs (multi-job case) get ids `<call>__<subjob>`. We deliberately
 * use `__` (not matrix's `::`): a callee's jobs reference each other at runtime
 * via `${{ needs.<job>.outputs.* }}` / `if: needs.<job>.result`, and those ids
 * must be re-pointed at the namespaced ids and stay parseable by the `needs.<id>`
 * expression/condition grammar — which only accepts `[\w-]`. `::` would not parse
 * there; `__` does, with no change to the shared expression language.
 */
import type { JobSpec, WorkflowSpec, WorkflowCallSpec } from "../spec/index.ts";
import type { PlannedJob, PlannedStep } from "./plan.ts";
import type { MatrixCell } from "./matrix.ts";
import { resolveInputs, type ResolvedInputs } from "./inputs.ts";
import { interpolate, expressionBodies, replaceExpressions, parseAccessPath, type ExprContext } from "./expr.ts";
import { compile, WorkflowCompileError, type CompileOptions } from "./compile.ts";

/** A resolved callee workflow: its parsed spec, its directory (the next level's
 *  base for relative `./` refs), and its canonical file path (the cycle key). */
export interface ResolvedWorkflow {
  spec: WorkflowSpec;
  dir: string;
  file: string;
}

/** Resolve a `uses:` reference (`workflow/<name>` or `./path.yaml`) to a callee,
 *  relative to `fromDir`. Injected into `compile()` so the compiler stays
 *  filesystem-pure; the CLI supplies the real (synchronous) implementation. */
export type ResolveWorkflow = (ref: string, fromDir: string) => ResolvedWorkflow;

/** Separator joining a call's id to its inlined sub-job ids (multi-job case). */
const NS_SEP = "__";

/** Max reusable-workflow nesting depth (GitHub.com cloud parity). */
export const REUSABLE_DEPTH_CAP = 10;

export interface InlineParams {
  /** The caller job's id (`C`). */
  baseId: string;
  /** The `uses:` job spec. */
  job: JobSpec;
  /** This call leg — `{ id: C }` non-matrix, `{ id: C::<cell>, cell, title }` per matrix cell. */
  leg: { id: string; title?: string; cell?: MatrixCell };
  /** The caller's resolved inputs (compile-time context for binding `with:`). */
  inputs: ResolvedInputs;
  /** The run's event payload, threaded into the callee unchanged. */
  event: Record<string, unknown> | undefined;
  /** The caller's compile options (carries the resolver + recursion state). */
  opts: CompileOptions;
}

/** The result of inlining one call leg. The caller (`compile`) wires the roots'
 *  `needs` (and a call-level `if:`) once the whole DAG's leg ids are known. */
export interface InlineResult {
  /** The inlined jobs (ids final). Root jobs carry `needs: []` here. */
  jobs: PlannedJob[];
  /** Root job ids (no intra-callee `needs`) — they receive the caller's `needs`. */
  rootIds: string[];
  /** Ids a downstream `needs: [<call>]` attaches to: the collapsed job, or the
   *  multi-job callee's leaves plus any job producing an exposed output. */
  legIds: string[];
  /** Caller-side rewrites: `needs.<call>.outputs.<name>` → `needs.<producer>.outputs.<key>`.
   *  Empty for the single-job collapse (the producer id *is* the call id). */
  outputRewrites: Record<string, string>;
  /** Authoring warnings bubbled up from the recursive callee compile. */
  warnings: string[];
}

/** Inline one call leg via substitution. */
export function inlineCall(p: InlineParams): InlineResult {
  const legId = p.leg.id; // `C` or `C::<cell>`
  const nsPrefix = legId.split("::").join(NS_SEP);
  const ns = (id: string): string => `${nsPrefix}${NS_SEP}${id}`;

  // A. Resolve the callee + assert it opted in.
  const resolve = p.opts.resolveWorkflow;
  if (!resolve) {
    throw new WorkflowCompileError(
      `job "${p.baseId}": reusable workflows (uses: <workflow>) are not available in this context`,
    );
  }
  const { spec: W, dir, file } = resolve(p.job.uses!, p.opts._fromDir ?? "");
  const chain = p.opts._chain ?? [];
  if (chain.includes(file)) {
    throw new WorkflowCompileError(`reusable-workflow cycle detected: ${[...chain, file].join(" -> ")}`);
  }
  const wc = W.on?.workflow_call;
  if (!wc) {
    throw new WorkflowCompileError(`job "${p.baseId}": workflow "${W.name}" is not callable — add 'on: workflow_call' to ${file}`);
  }

  // B. Bind `with:`: resolve compile-time roots now; carry runtime (`needs.*`)
  //    values through as deferred input expressions.
  const { boundWith, deferred } = bindWith(p, W);

  // C. Recursively compile the callee with the bound inputs.
  const sub = compile(W, {
    inputs: boundWith,
    ...(deferred.size > 0 ? { _deferredInputs: deferred } : {}),
    ...(p.event ? { event: p.event } : {}),
    resolveWorkflow: resolve,
    _fromDir: dir,
    _chain: [...chain, file],
    _depth: (p.opts._depth ?? 0) + 1,
  });
  const warnings = sub.warnings ?? [];
  const subIds = Object.keys(sub.jobs);

  // D1. Single-job callee → the one job adopts the call's id (the leg id).
  if (subIds.length === 1) {
    const only = sub.jobs[subIds[0]!]!;
    const job = collapseSingle(only, legId, p.leg, wc, W);
    return { jobs: [job], rootIds: [legId], legIds: [legId], outputRewrites: {}, warnings };
  }

  // D2. Multi-job callee → namespace every sub-job; no join node. A downstream
  // `needs: [C]` attaches to the leaves (and any exposed-output producer).
  const rename = (id: string): string | undefined => (subIds.includes(id) ? ns(id) : undefined);
  const titlePrefix = p.leg.title ?? p.baseId;
  const subJobs = Object.values(sub.jobs).map((sj) => renameJob(sj, ns, rename, titlePrefix));

  const nsIds = new Set(subJobs.map((j) => j.id));
  const referenced = new Set<string>();
  for (const sj of subJobs) for (const n of sj.needs) if (nsIds.has(n)) referenced.add(n);
  const rootIds = subJobs.filter((j) => j.needs.length === 0).map((j) => j.id);
  const leafIds = subJobs.filter((j) => !referenced.has(j.id)).map((j) => j.id);

  // Matrix calls can't expose outputs unambiguously (one set per cell), so only a
  // single-leg (non-matrix) call rewrites caller-side output references.
  const { outputRewrites, producers } = p.leg.cell ? { outputRewrites: {}, producers: [] } : buildOutputRewrites(wc, ns, W);
  const legIds = [...new Set([...leafIds, ...producers])];
  return { jobs: subJobs, rootIds, legIds, outputRewrites, warnings };
}

/**
 * Collapse a single-job callee: its lone job becomes the call node, taking the
 * call's id (`C` / `C::cell`) and exposing the callee's curated `workflow_call`
 * outputs. Its `needs` are cleared (the caller injects its own); a call-level
 * `if:` is applied by the caller alongside that.
 */
function collapseSingle(
  only: PlannedJob,
  legId: string,
  leg: { title?: string; cell?: MatrixCell },
  wc: WorkflowCallSpec | boolean,
  W: WorkflowSpec,
): PlannedJob {
  const out: PlannedJob = {
    ...only,
    id: legId,
    needs: [],
    title: leg.title ?? legId,
    // The lone job has no siblings, so no intra-callee `needs.*` refs to re-point.
    steps: only.steps.map((st) => renameStep(st, only.id, legId, () => undefined)),
  };
  const outputs = curateSingleOutputs(wc, only, W);
  if (outputs) out.outputs = outputs;
  else delete out.outputs;
  if (leg.cell) out.matrix = leg.cell;
  return out;
}

/**
 * Bind a call's `with:` and report which inputs are runtime-deferred.
 *
 * Compile-time roots (`inputs`/`matrix`/`event`) are resolved here; a
 * `needs.<job>.outputs.*` reference is left intact and the input is marked
 * **deferred** — the recursive compile substitutes it into `${{ inputs.<name> }}`
 * so it resolves at runtime through the callee's inherited `needs`. This is how
 * runtime data flows into a reusable workflow: explicitly, via the call site's
 * `with:`, matching GitHub Actions — no implicit reaching into a caller-side job
 * from inside the callee.
 *
 * Two guards keep it honest:
 *  - a referenced `needs.<job>` must be in *this call's* `needs:`, or the value
 *    can't resolve at runtime (the callee's roots only inherit those needs);
 *  - `steps.*` is rejected — a `uses:` job has no steps of its own.
 */
function bindWith(p: InlineParams, W: WorkflowSpec): { boundWith: Record<string, unknown>; deferred: Set<string> } {
  const ictx: ExprContext = {
    inputs: p.inputs,
    ...(p.leg.cell ? { matrix: p.leg.cell } : {}),
    ...(p.event ? { event: p.event } : {}),
  };
  const callerNeeds = new Set(p.job.needs ?? []);
  const boundWith: Record<string, unknown> = {};
  const deferred = new Set<string>();
  for (const [k, v] of Object.entries(p.job.with ?? {})) {
    if (typeof v === "string") {
      for (const body of expressionBodies(v)) {
        const root = parseAccessPath(body)[0];
        if (!root || root.kind !== "key") continue;
        if (root.name === "steps") {
          throw new WorkflowCompileError(
            `job "${p.baseId}": with.${k} may not reference "steps.*" — a reusable call has no steps; ` +
              `pass step output through a job output and 'needs' instead.`,
          );
        }
        if (root.name === "needs") {
          const dep = /^needs\.([A-Za-z_][\w-]*)/.exec(body)?.[1];
          if (dep && !callerNeeds.has(dep)) {
            throw new WorkflowCompileError(
              `job "${p.baseId}": with.${k} references "needs.${dep}" but "${dep}" is not in this job's 'needs:' — ` +
                `add it so the value is available when the call runs.`,
            );
          }
          deferred.add(k);
        }
      }
      // Resolve compile-time roots; a deferred value keeps its `${{ needs.* }}` text.
      boundWith[k] = interpolate(v, ictx);
    } else {
      boundWith[k] = v;
    }
  }
  try {
    resolveInputs(W.inputs, boundWith, deferred);
  } catch (err) {
    if (err instanceof WorkflowCompileError) {
      throw new WorkflowCompileError(`job "${p.baseId}" calling workflow "${W.name}": ${err.message}`);
    }
    throw err;
  }
  return { boundWith, deferred };
}

/** Parse a `workflow_call.outputs` value, which must be `${{ jobs.<id>.outputs.<key> }}`,
 *  into `{ jobId, key }`. Throws (citing `name`) on any other shape or unknown/matrix job. */
function parseOutputProducer(
  expr: string,
  name: string,
  W: WorkflowSpec,
): { jobId: string; key: string } {
  let result: { jobId: string; key: string } | undefined;
  replaceExpressions(expr, (body) => {
    const m = /^jobs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(body);
    if (!m) {
      throw new WorkflowCompileError(
        `workflow "${W.name}" workflow_call.outputs.${name}: only "\${{ jobs.<id>.outputs.<key> }}" is allowed (got "\${{ ${body} }}")`,
      );
    }
    const jobId = m[1]!;
    if (!(jobId in W.jobs)) {
      throw new WorkflowCompileError(`workflow "${W.name}" workflow_call.outputs.${name} references unknown job "${jobId}"`);
    }
    if (W.jobs[jobId]!.strategy?.matrix) {
      throw new WorkflowCompileError(
        `workflow "${W.name}" workflow_call.outputs.${name} cannot reference matrix job "${jobId}" (ambiguous across legs)`,
      );
    }
    result = { jobId, key: m[2]! };
    return body;
  });
  if (!result) {
    throw new WorkflowCompileError(`workflow "${W.name}" workflow_call.outputs.${name} must be a single \${{ }} expression`);
  }
  return result;
}

/**
 * Curated exposed outputs for a collapsed single-job callee: each
 * `workflow_call.outputs.<name>: ${{ jobs.<only>.outputs.<key> }}` becomes
 * `<name>: <the job's own output value for <key>>`, so the collapsed node (id =
 * call id) exposes exactly the call's declared surface.
 */
function curateSingleOutputs(
  wc: WorkflowCallSpec | boolean,
  only: PlannedJob,
  W: WorkflowSpec,
): Record<string, string> | undefined {
  if (wc === true || wc === false || !wc.outputs) return undefined;
  const out: Record<string, string> = {};
  for (const [name, expr] of Object.entries(wc.outputs)) {
    const { jobId, key } = parseOutputProducer(expr, name, W);
    if (jobId !== only.id) {
      throw new WorkflowCompileError(`workflow "${W.name}" workflow_call.outputs.${name} references unknown job "${jobId}"`);
    }
    const value = only.outputs?.[key];
    if (value === undefined) {
      throw new WorkflowCompileError(
        `workflow "${W.name}" workflow_call.outputs.${name}: job "${jobId}" does not declare output "${key}"`,
      );
    }
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Caller-side rewrites for a multi-job callee's exposed outputs. Each
 * `workflow_call.outputs.<name>: ${{ jobs.<id>.outputs.<key> }}` yields
 * `needs.<call>.outputs.<name>` → `needs.<ns(id)>.outputs.<key>`, applied by the
 * compiler to the caller's downstream jobs. Returns every producer so the caller
 * can attach it to the downstream `needs` (a mid-DAG producer may not be a leaf).
 */
function buildOutputRewrites(
  wc: WorkflowCallSpec | boolean,
  ns: (id: string) => string,
  W: WorkflowSpec,
): { outputRewrites: Record<string, string>; producers: string[] } {
  if (wc === true || wc === false || !wc.outputs) return { outputRewrites: {}, producers: [] };
  const outputRewrites: Record<string, string> = {};
  const producers = new Set<string>();
  for (const [name, expr] of Object.entries(wc.outputs)) {
    const { jobId, key } = parseOutputProducer(expr, name, W);
    const producer = ns(jobId);
    producers.add(producer);
    outputRewrites[name] = `needs.${producer}.outputs.${key}`;
  }
  return { outputRewrites, producers: [...producers] };
}

/** Namespace one sub-job: rename its id, its intra-call `needs`, its step names,
 *  and re-point every deferred `needs.*` reference in its steps/outputs/if. */
function renameJob(
  sj: PlannedJob,
  ns: (id: string) => string,
  rename: (id: string) => string | undefined,
  titlePrefix: string,
): PlannedJob {
  const newId = ns(sj.id);
  const out: PlannedJob = {
    ...sj,
    id: newId,
    needs: sj.needs.map((n) => rename(n) ?? n),
    title: `${titlePrefix} / ${sj.title ?? sj.id}`,
    steps: sj.steps.map((st) => renameStep(st, sj.id, newId, rename)),
  };
  if (sj.outputs) out.outputs = mapStr(sj.outputs, (v) => renameNeeds(v, rename));
  if (sj.if !== undefined) out.if = renameNeeds(sj.if, rename);
  return out;
}

/** Re-prefix a step's checkpoint name and re-point its deferred `needs.*` refs. */
function renameStep(
  st: PlannedStep,
  oldJobId: string,
  newJobId: string,
  rename: (id: string) => string | undefined,
): PlannedStep {
  const out: PlannedStep = { ...st };
  // step.name is `<jobId>/<stepKey>`; re-prefix it with the namespaced job id.
  if (st.name.startsWith(`${oldJobId}/`)) {
    out.name = `${newJobId}/${st.name.slice(oldJobId.length + 1)}`;
  }
  if (st.run !== undefined) out.run = renameNeeds(st.run, rename);
  out.env = mapStr(st.env, (v) => renameNeeds(v, rename));
  if (st.if !== undefined) out.if = renameNeeds(st.if, rename);
  if (st.with !== undefined) {
    const w: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(st.with)) w[k] = typeof v === "string" ? renameNeeds(v, rename) : v;
    out.with = w;
  }
  return out;
}

/** Re-point `needs.<id>` references (in both `${{ }}` expressions and bare `if:`
 *  conditions) to their namespaced ids. Only known callee job ids are rewritten;
 *  anything else is left intact. The trailing `.outputs.x` / `.result` is kept. */
function renameNeeds(s: string, rename: (id: string) => string | undefined): string {
  return s.replace(/needs\.([A-Za-z_][\w-]*)/g, (whole, id: string) => {
    const renamed = rename(id);
    return renamed ? `needs.${renamed}` : whole;
  });
}

function mapStr(obj: Record<string, string>, fn: (v: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}

/** Rewrite caller-side `needs.<call>.outputs.<name>` references onto the callee's
 *  real producers, using the map an `InlineResult` returned for that call. Applied
 *  by `compile()` to the caller's own jobs (`run`/`env`/`if`/`with`/`outputs`). */
export function rewriteOutputRefs(s: string, callId: string, rewrites: Record<string, string>): string {
  let out = s;
  for (const [name, replacement] of Object.entries(rewrites)) {
    out = out.replace(new RegExp(`needs\\.${escapeRe(callId)}\\.outputs\\.${escapeRe(name)}\\b`, "g"), replacement);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
