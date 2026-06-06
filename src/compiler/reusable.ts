/**
 * Reusable-workflow inlining (Strategy A — see docs/reusable-workflows.md).
 *
 * A `uses:` job calls a whole workflow as a unit. The compiler resolves the
 * callee, binds the caller's `with:` to its inputs, **recursively compiles it**,
 * and splices its jobs into the caller's flat plan with namespaced ids — then
 * synthesizes a single *virtual join* node (keeping the caller job's id) that
 * aggregates the callee's declared outputs. Downstream `needs: [C]` and
 * `needs.C.outputs.x` therefore resolve unchanged: the call is transparent.
 *
 * This mirrors how matrix already flattens one spec job into many `PlannedJob`s —
 * it's a sibling expansion step, not a rewrite of the matrix path.
 *
 * ## Namespacing separator
 * Inlined sub-jobs get ids `<call>__<subjob>`. We deliberately use `__` (not
 * matrix's `::`): a callee's jobs reference each other at runtime via
 * `${{ needs.<job>.outputs.* }}` / `if: needs.<job>.result`, and those ids must
 * be re-pointed at the namespaced ids and stay parseable by the `needs.<id>`
 * expression/condition grammar — which only accepts `[\w-]`. `::` would not
 * parse there; `__` does, with no change to the shared expression language.
 * (Matrix gets away with `::` because a matrix leg's *outputs* are never
 * referenced in an expression.)
 */
import type { JobSpec, WorkflowSpec, WorkflowCallSpec } from "../spec/index.ts";
import type { PlannedJob, PlannedStep } from "./plan.ts";
import type { MatrixCell } from "./matrix.ts";
import { resolveInputs, type ResolvedInputs } from "./inputs.ts";
import { resolveMachine } from "./machines.ts";
import { interpolate, expressionBodies, replaceExpressions, parseAccessPath, type ExprContext } from "./expr.ts";
import { compile, WorkflowCompileError, DEFAULT_RUNS_ON, type CompileOptions } from "./compile.ts";

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

/** Separator joining a call's id to its inlined sub-job ids (see file header). */
const NS_SEP = "__";

/** Max reusable-workflow nesting depth (GitHub.com cloud parity). */
export const REUSABLE_DEPTH_CAP = 10;

export interface InlineParams {
  /** The caller job's id (`C`). */
  baseId: string;
  /** The `uses:` job spec. */
  job: JobSpec;
  /** This call leg — `{ id: C }` non-matrix, `{ id: C::<cell>, cell, title }` per matrix cell. The id is the join's id. */
  leg: { id: string; title?: string; cell?: MatrixCell };
  /** The caller job's `needs`, already expanded to concrete leg ids. */
  callerNeeds: string[];
  /** The caller's resolved inputs (compile-time context for binding `with:`). */
  inputs: ResolvedInputs;
  /** The run's event payload, threaded into the callee unchanged. */
  event: Record<string, unknown> | undefined;
  /** The caller's compile options (carries the resolver + recursion state). */
  opts: CompileOptions;
}

/** Inline one call leg: returns the namespaced sub-jobs and the virtual join. */
export function inlineCall(p: InlineParams): { subJobs: PlannedJob[]; join: PlannedJob; warnings: string[] } {
  // The join keeps the call leg's id (`C` or, for a matrix call, `C::<cell>`) so
  // downstream `needs: [C]` converges on it. Sub-jobs hang off a `\w`-safe prefix
  // (matrix's `::` swapped to `__`) so the join's `needs.<sub>` output references
  // parse — `::` is not valid in the `needs.<id>` expression grammar.
  const nsId = p.leg.id;
  const nsPrefix = nsId.split("::").join(NS_SEP);
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

  // B. Bind `with:` against compile-time context only.
  const boundWith = bindWith(p, W);

  // C. Recursively compile the callee with the bound inputs.
  const sub = compile(W, {
    inputs: boundWith,
    ...(p.event ? { event: p.event } : {}),
    resolveWorkflow: resolve,
    _fromDir: dir,
    _chain: [...chain, file],
    _depth: (p.opts._depth ?? 0) + 1,
  });

  // D. Namespace every sub-job id + re-point its deferred `needs.*` references.
  const subIds = new Set(Object.keys(sub.jobs));
  const rename = (id: string): string | undefined => (subIds.has(id) ? ns(id) : undefined);
  const titlePrefix = p.leg.title ?? p.baseId;
  const subJobs: PlannedJob[] = Object.values(sub.jobs).map((sj) => renameJob(sj, ns, rename, titlePrefix));

  // E + F. Rewire the call boundary and synthesize the virtual join.
  const join = rewireAndBuildJoin(subJobs, p, wc, W, nsId, nsPrefix);
  return { subJobs, join, warnings: sub.warnings ?? [] };
}

/**
 * Rewire the inlined sub-DAG to the call boundary and build the virtual join.
 * Mutates `subJobs` in place: roots inherit the call's `needs`, and a call-level
 * `if:` propagates onto roots. Returns the virtual join (keeps the call's id).
 */
function rewireAndBuildJoin(
  subJobs: PlannedJob[],
  p: InlineParams,
  wc: WorkflowCallSpec | boolean,
  W: WorkflowSpec,
  nsId: string,
  nsPrefix: string,
): PlannedJob {
  // Roots/leaves on the namespaced intra-call graph.
  const nsIds = new Set(subJobs.map((j) => j.id));
  const referenced = new Set<string>();
  for (const sj of subJobs) for (const n of sj.needs) if (nsIds.has(n)) referenced.add(n);
  const rootJobs = subJobs.filter((j) => j.needs.length === 0);
  const leafIds = subJobs.filter((j) => !referenced.has(j.id)).map((j) => j.id);

  // Sub-DAG roots inherit the call's `needs` — this is how runtime data reaches
  // the callee, through the normal needs graph (see §8). A call-level `if:` gates
  // the whole call, so it propagates to roots (skip) and the join (downstream
  // sees it skipped); v1 rejects the case where a root already carries its own.
  for (const r of rootJobs) {
    r.needs = [...p.callerNeeds];
    if (p.job.if !== undefined) {
      if (r.if !== undefined) {
        throw new WorkflowCompileError(
          `job "${p.baseId}": if: on a reusable call is not supported when callee root job "${r.id}" has its own if: (v1)`,
        );
      }
      r.if = p.job.if;
    }
  }

  const { outputs, referencedProducers } = rewriteCallOutputs(wc, nsPrefix, W);
  const joinNeeds = subJobs.length === 0 ? [...p.callerNeeds] : [...new Set([...leafIds, ...referencedProducers])];
  const join: PlannedJob = {
    id: nsId,
    runsOn: DEFAULT_RUNS_ON,
    machine: resolveMachine(undefined, nsId),
    needs: joinNeeds,
    virtual: true,
    steps: [],
  };
  if (outputs) join.outputs = outputs;
  if (p.leg.cell) join.matrix = p.leg.cell;
  if (p.leg.title) join.title = p.leg.title;
  if (p.job.if !== undefined) join.if = p.job.if;
  return join;
}

/** Bind a call's `with:` against the caller's compile-time context, rejecting any
 *  runtime (`needs`/`steps`) reference, then validate against the callee's inputs. */
function bindWith(p: InlineParams, W: WorkflowSpec): Record<string, unknown> {
  const ictx: ExprContext = {
    inputs: p.inputs,
    ...(p.leg.cell ? { matrix: p.leg.cell } : {}),
    ...(p.event ? { event: p.event } : {}),
  };
  const boundWith: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.job.with ?? {})) {
    if (typeof v === "string") {
      // Reject runtime roots BEFORE interpolation — `interpolate` would silently
      // defer `needs.*`/`steps.*`, letting them slip past input validation.
      for (const body of expressionBodies(v)) {
        const root = parseAccessPath(body)[0];
        if (root && root.kind === "key" && (root.name === "needs" || root.name === "steps")) {
          throw new WorkflowCompileError(
            `job "${p.baseId}": with.${k} may not reference a runtime value ("\${{ ${body} }}"). ` +
              `'with' is bound at compile time — pass runtime data through 'needs' instead (see docs/reusable-workflows.md §8).`,
          );
        }
      }
      boundWith[k] = interpolate(v, ictx);
    } else {
      boundWith[k] = v;
    }
  }
  try {
    resolveInputs(W.inputs, boundWith);
  } catch (err) {
    if (err instanceof WorkflowCompileError) {
      throw new WorkflowCompileError(`job "${p.baseId}" calling workflow "${W.name}": ${err.message}`);
    }
    throw err;
  }
  return boundWith;
}

/**
 * Rewrite a callee's declared `workflow_call.outputs` onto the virtual join.
 * Each value must be `${{ jobs.<id>.outputs.<key> }}` (a callee-vocabulary root
 * the engine does NOT otherwise support) — a purely syntactic compile-time
 * rewrite turns it into `${{ needs.<call>__<id>.outputs.<key> }}`, which the
 * runtime resolves over the join's `needs`. Every referenced producer is returned
 * so the caller can add it to the join's `needs` (a curated mid-DAG output's job
 * may not be a leaf).
 */
function rewriteCallOutputs(
  wc: WorkflowCallSpec | boolean,
  nsPrefix: string,
  W: WorkflowSpec,
): { outputs?: Record<string, string>; referencedProducers: string[] } {
  if (wc === true || wc === false || !wc.outputs) return { referencedProducers: [] };
  const wJobIds = new Set(Object.keys(W.jobs));
  const matrixJobIds = new Set(
    Object.entries(W.jobs)
      .filter(([, j]) => j.strategy?.matrix)
      .map(([id]) => id),
  );
  const referenced = new Set<string>();
  const outputs: Record<string, string> = {};
  for (const [name, expr] of Object.entries(wc.outputs)) {
    outputs[name] = replaceExpressions(expr, (body) => {
      const m = /^jobs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(body);
      if (!m) {
        throw new WorkflowCompileError(
          `workflow "${W.name}" workflow_call.outputs.${name}: only "\${{ jobs.<id>.outputs.<key> }}" is allowed (got "\${{ ${body} }}")`,
        );
      }
      const wJobId = m[1]!;
      const key = m[2]!;
      if (!wJobIds.has(wJobId)) {
        throw new WorkflowCompileError(`workflow "${W.name}" workflow_call.outputs.${name} references unknown job "${wJobId}"`);
      }
      if (matrixJobIds.has(wJobId)) {
        throw new WorkflowCompileError(
          `workflow "${W.name}" workflow_call.outputs.${name} cannot reference matrix job "${wJobId}" (ambiguous across legs)`,
        );
      }
      const producer = `${nsPrefix}${NS_SEP}${wJobId}`;
      referenced.add(producer);
      return `\${{ needs.${producer}.outputs.${key} }}`;
    });
  }
  return { outputs, referencedProducers: [...referenced] };
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
