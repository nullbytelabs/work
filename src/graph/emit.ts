/**
 * `pi-workflows graph` — render the compiled `needs` DAG for inspection, separate
 * from a run. The graph matters most *before* execution (does the shape match
 * intent?), and a static export sidesteps the live-terminal reflow problems that
 * keep the run view a status list rather than a drawn graph (see
 * docs/tui-iteration-2.md).
 *
 * Four formats: `mermaid` and `dot` for real rendering (browser / Graphviz),
 * `json` for tooling, and `ascii` for a quick, dependency-free terminal glance.
 * With `steps: true`, each job is expanded to its ordered steps (run vs
 * `uses agent/…`). All emitters are pure functions of the compiled plan.
 */
import type { ExecutionPlan } from "../compiler/index.ts";
import { levelize } from "../tui/levels.ts";

export type GraphFormat = "mermaid" | "dot" | "json" | "ascii";

export const GRAPH_FORMATS: readonly GraphFormat[] = ["mermaid", "dot", "json", "ascii"];

export function isGraphFormat(s: string): s is GraphFormat {
  return (GRAPH_FORMATS as readonly string[]).includes(s);
}

export interface GraphOptions {
  /** Expand each job to its ordered steps. */
  steps: boolean;
}

export function emitGraph(plan: ExecutionPlan, format: GraphFormat, opts: GraphOptions = { steps: false }): string {
  switch (format) {
    case "mermaid":
      return toMermaid(plan, opts);
    case "dot":
      return toDot(plan, opts);
    case "json":
      return toJson(plan, opts);
    case "ascii":
      return toAscii(plan, opts);
  }
}

interface JobMeta {
  runsOn: string;
  steps: number;
}

function metaOf(plan: ExecutionPlan, id: string): JobMeta {
  const job = plan.jobs[id];
  return { runsOn: job?.runsOn ?? "?", steps: job?.steps.length ?? 0 };
}

function stepsLabel(n: number): string {
  return `${n} step${n === 1 ? "" : "s"}`;
}

interface StepInfo {
  ordinal: number;
  /** Human label: the author `name:`, else the step id, else its index. */
  label: string;
  kind: "run" | "uses";
  uses?: string;
  id?: string;
}

function stepInfos(plan: ExecutionPlan, id: string): StepInfo[] {
  const steps = plan.jobs[id]?.steps ?? [];
  return steps.map((s, i) => {
    const info: StepInfo = {
      ordinal: i + 1,
      label: s.title ?? s.id ?? String(i),
      kind: s.uses !== undefined ? "uses" : "run",
    };
    if (s.uses !== undefined) info.uses = s.uses;
    if (s.id !== undefined) info.id = s.id;
    return info;
  });
}

/** Mermaid flowchart. Jobs get synthetic ids (`n0`…) so names never clash with
 *  Mermaid's id grammar; the real name lives in the label. Without `steps`, one
 *  node per job. With `steps`, each job becomes a subgraph whose nodes are its
 *  ordered steps (chained), `uses` steps drawn as a distinct stadium shape, and
 *  job dependencies connect the subgraphs. */
function toMermaid(plan: ExecutionPlan, opts: GraphOptions): string {
  const nodeId = new Map<string, string>();
  plan.jobOrder.forEach((id, i) => nodeId.set(id, `n${i}`));

  const lines: string[] = ["flowchart TD"];

  if (!opts.steps) {
    for (const id of plan.jobOrder) {
      const m = metaOf(plan, id);
      lines.push(`  ${nodeId.get(id)}["${escapeMermaid(id)}<br/>${m.runsOn} · ${stepsLabel(m.steps)}"]`);
    }
  } else {
    for (const id of plan.jobOrder) {
      const nid = nodeId.get(id)!;
      const m = metaOf(plan, id);
      lines.push(`  subgraph ${nid}["${escapeMermaid(id)} · ${m.runsOn}"]`);
      lines.push(`    direction TB`);
      const infos = stepInfos(plan, id);
      if (infos.length === 0) {
        lines.push(`    ${nid}_s0["(no steps)"]`);
      } else {
        for (const s of infos) {
          const tag = s.id !== undefined ? ` #91;${escapeMermaid(s.id)}#93;` : "";
          const usesLine = s.kind === "uses" ? `<br/><em>uses ${escapeMermaid(s.uses ?? "")}</em>` : "";
          const text = `${s.ordinal}. ${escapeMermaid(s.label)}${tag}${usesLine}`;
          // Stadium shape for `uses` steps; rectangle for `run`.
          lines.push(s.kind === "uses" ? `    ${nid}_s${s.ordinal}(["${text}"])` : `    ${nid}_s${s.ordinal}["${text}"]`);
        }
        if (infos.length > 1) {
          lines.push(`    ${infos.map((s) => `${nid}_s${s.ordinal}`).join(" --> ")}`);
        }
      }
      lines.push(`  end`);
    }
  }

  for (const id of plan.jobOrder) {
    for (const need of plan.jobs[id]?.needs ?? []) {
      const from = nodeId.get(need);
      const to = nodeId.get(id);
      if (from && to) lines.push(`  ${from} --> ${to}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Graphviz DOT. Without `steps`, one node per job. With `steps`, each job is a
 *  `cluster_<i>` containing its ordered step nodes (chained); job dependencies
 *  are drawn cluster-to-cluster via `compound=true` + `lhead`/`ltail`. Synthetic
 *  ids (`j0s1`, `cluster_0`) keep names valid regardless of job-id characters. */
function toDot(plan: ExecutionPlan, opts: GraphOptions): string {
  const lines: string[] = [`digraph "${escapeDot(plan.name)}" {`, "  rankdir=TB;"];
  if (opts.steps) lines.push("  compound=true;");
  lines.push("  node [shape=box, style=rounded];");
  lines.push(...(opts.steps ? dotClusters(plan) : dotJobsOnly(plan)));
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** DOT body without `steps`: one node per job, plain job-to-job edges. */
function dotJobsOnly(plan: ExecutionPlan): string[] {
  const lines: string[] = [];
  for (const id of plan.jobOrder) {
    const m = metaOf(plan, id);
    lines.push(`  "${escapeDot(id)}" [label="${escapeDot(id)}\\n${m.runsOn} · ${stepsLabel(m.steps)}"];`);
  }
  for (const id of plan.jobOrder) {
    for (const need of plan.jobs[id]?.needs ?? []) {
      lines.push(`  "${escapeDot(need)}" -> "${escapeDot(id)}";`);
    }
  }
  return lines;
}

/** DOT body with `steps`: a `cluster_<i>` per job, then cluster-to-cluster edges. */
function dotClusters(plan: ExecutionPlan): string[] {
  const idx = new Map<string, number>();
  plan.jobOrder.forEach((id, i) => idx.set(id, i));

  const lines: string[] = [];
  for (const id of plan.jobOrder) lines.push(...dotCluster(plan, id, idx.get(id)!));
  lines.push(...dotClusterEdges(plan, idx));
  return lines;
}

/** One job's `cluster_<i>` subgraph: its ordered step nodes, chained. */
function dotCluster(plan: ExecutionPlan, id: string, i: number): string[] {
  const m = metaOf(plan, id);
  const lines: string[] = [`  subgraph cluster_${i} {`, `    label="${escapeDot(id)} · ${m.runsOn}";`, `    style=rounded;`];
  const infos = stepInfos(plan, id);
  if (infos.length === 0) {
    lines.push(`    j${i}s0 [label="(no steps)"];`);
  } else {
    for (const s of infos) {
      const tag = s.id !== undefined ? ` [${escapeDot(s.id)}]` : "";
      const usesLine = s.kind === "uses" ? `\\n(uses ${escapeDot(s.uses ?? "")})` : "";
      const style = s.kind === "uses" ? `, style="rounded,filled", fillcolor="#eaf2ff"` : "";
      lines.push(`    j${i}s${s.ordinal} [label="${s.ordinal}. ${escapeDot(s.label)}${tag}${usesLine}"${style}];`);
    }
    for (let k = 0; k < infos.length - 1; k++) {
      lines.push(`    j${i}s${infos[k]!.ordinal} -> j${i}s${infos[k + 1]!.ordinal};`);
    }
  }
  lines.push(`  }`);
  return lines;
}

/** Cross-cluster dependency edges (last step of `need` → first step of `id`). */
function dotClusterEdges(plan: ExecutionPlan, idx: Map<string, number>): string[] {
  const lines: string[] = [];
  for (const id of plan.jobOrder) {
    const ti = idx.get(id)!;
    const toFirst = `j${ti}s${plan.jobs[id]!.steps.length === 0 ? 0 : 1}`;
    for (const need of plan.jobs[id]?.needs ?? []) {
      const fi = idx.get(need)!;
      const fromSteps = plan.jobs[need]!.steps.length;
      const fromLast = `j${fi}s${fromSteps === 0 ? 0 : fromSteps}`;
      lines.push(`  ${fromLast} -> ${toFirst} [ltail=cluster_${fi}, lhead=cluster_${ti}];`);
    }
  }
  return lines;
}

/** Structured form for tooling: the plan's shape plus computed levels. With
 *  `steps`, each job gains an ordered `stepList`. */
function toJson(plan: ExecutionPlan, opts: GraphOptions): string {
  const { level } = levelize(plan);
  const jobs: Record<string, unknown> = {};
  for (const id of plan.jobOrder) {
    const m = metaOf(plan, id);
    const entry: Record<string, unknown> = {
      runsOn: m.runsOn,
      steps: m.steps,
      needs: plan.jobs[id]?.needs ?? [],
      level: level.get(id) ?? 0,
    };
    if (opts.steps) {
      entry["stepList"] = stepInfos(plan, id).map((s) => ({
        name: s.label,
        kind: s.kind,
        ...(s.uses !== undefined ? { uses: s.uses } : {}),
        ...(s.id !== undefined ? { id: s.id } : {}),
      }));
    }
    jobs[id] = entry;
  }
  return JSON.stringify({ name: plan.name, jobOrder: plan.jobOrder, jobs }, null, 2) + "\n";
}

/** A quick terminal glance: jobs grouped by topological level, each annotated
 *  with the upstream jobs it waits on. With `steps`, the ordered steps are
 *  listed under each job. Plain text — safe to pipe or paste. */
function toAscii(plan: ExecutionPlan, opts: GraphOptions): string {
  const { byLevel } = levelize(plan);
  const nameW = plan.jobOrder.reduce((w, id) => Math.max(w, id.length), 0);
  const levelCount = byLevel.length;

  const lines: string[] = [`${plan.name}  (${plan.jobOrder.length} jobs, ${levelCount} level${levelCount === 1 ? "" : "s"})`, ""];
  for (let lvl = 0; lvl < byLevel.length; lvl++) {
    lines.push(`level ${lvl}:`);
    for (const id of byLevel[lvl]!.slice().sort()) {
      const m = metaOf(plan, id);
      const needs = plan.jobs[id]?.needs ?? [];
      const upstream = needs.length ? `  ← ${needs.slice().sort().join(", ")}` : "";
      const cols = `${id.padEnd(nameW)}  ${m.runsOn.padEnd(8)}  ${stepsLabel(m.steps)}`;
      lines.push(`  • ${cols}${upstream}`);
      if (opts.steps) {
        for (const s of stepInfos(plan, id)) {
          const ref = s.kind === "uses" ? `  → uses ${s.uses}` : "";
          const tag = s.id !== undefined ? `  [${s.id}]` : "";
          lines.push(`      ${s.ordinal}. ${s.label}${ref}${tag}`);
        }
      }
    }
  }
  return lines.join("\n") + "\n";
}

function escapeMermaid(s: string): string {
  // Inside a quoted label, neutralise quotes; Mermaid renders #quot; etc.
  return s.replace(/"/g, "#quot;");
}

function escapeDot(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
