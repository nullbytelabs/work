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

/** Mermaid flowchart. Nodes get synthetic ids (`n0`…) so job names never clash
 *  with Mermaid's id grammar; the real name lives in the label. */
function toMermaid(plan: ExecutionPlan, opts: GraphOptions): string {
  const nodeId = new Map<string, string>();
  plan.jobOrder.forEach((id, i) => nodeId.set(id, `n${i}`));

  const lines: string[] = ["flowchart TD"];
  for (const id of plan.jobOrder) {
    const m = metaOf(plan, id);
    let label = `${escapeMermaid(id)}<br/>${m.runsOn} · ${stepsLabel(m.steps)}`;
    if (opts.steps) {
      for (const s of stepInfos(plan, id)) {
        const suffix = s.kind === "uses" ? ` <em>uses ${escapeMermaid(s.uses ?? "")}</em>` : "";
        label += `<br/>${s.ordinal}. ${escapeMermaid(s.label)}${suffix}`;
      }
    }
    lines.push(`  ${nodeId.get(id)}["${label}"]`);
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

/** Graphviz DOT. Job names are valid quoted node ids; escape quotes/backslashes. */
function toDot(plan: ExecutionPlan, opts: GraphOptions): string {
  const lines: string[] = [`digraph "${escapeDot(plan.name)}" {`, "  rankdir=TB;", "  node [shape=box, style=rounded];"];
  for (const id of plan.jobOrder) {
    const m = metaOf(plan, id);
    let label = `${escapeDot(id)}\\n${m.runsOn} · ${stepsLabel(m.steps)}`;
    if (opts.steps) {
      // Left-justify multi-line node labels (\l) so the step list reads cleanly.
      label = `${escapeDot(id)}\\n${m.runsOn} · ${stepsLabel(m.steps)}\\l`;
      for (const s of stepInfos(plan, id)) {
        const suffix = s.kind === "uses" ? `  (uses ${escapeDot(s.uses ?? "")})` : "";
        label += `${s.ordinal}. ${escapeDot(s.label)}${suffix}\\l`;
      }
    }
    lines.push(`  "${escapeDot(id)}" [label="${label}"];`);
  }
  for (const id of plan.jobOrder) {
    for (const need of plan.jobs[id]?.needs ?? []) {
      lines.push(`  "${escapeDot(need)}" -> "${escapeDot(id)}";`);
    }
  }
  lines.push("}");
  return lines.join("\n") + "\n";
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
