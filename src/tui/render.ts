/**
 * Pure rendering of the layered run board — no I/O, no timers. Given a snapshot
 * of `JobState`s it returns the lines to draw; the presenter owns when and where.
 *
 * The layout encodes the DAG as indentation: a job's column is its topological
 * depth, so siblings line up and dependents step right. State is a glyph +
 * colour, with a compact metadata row (target, step progress, elapsed) and a
 * dim "waiting on …" for jobs still blocked. Lines are truncated to the terminal
 * width so nothing wraps (which would corrupt the in-place cursor math).
 */
import type { JobPhase, JobState } from "./store.ts";

export interface RenderOpts {
  /** Emit ANSI colour codes. */
  color: boolean;
  /** Current spinner glyph for running rows. */
  spinner: string;
  /** Terminal width; rows are truncated to width - 1. */
  width: number;
  /** Clock used for live elapsed times. */
  now: number;
  /** Final frame: no spinner, render running rows as a neutral dot. */
  final: boolean;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const CODE = {
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
};

// eslint-disable-next-line no-control-regex -- matching ANSI SGR escape sequences requires the ESC byte
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function paint(on: boolean, code: string, s: string): string {
  return on ? `${code}${s}${RESET}` : s;
}

function visLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** Truncate to `max` *visible* columns, preserving ANSI sequences. */
export function truncVisible(s: string, max: number): string {
  if (max <= 0) return "";
  if (visLen(s) <= max) return s;
  let out = "";
  let count = 0;
  let i = 0;
  while (i < s.length && count < max - 1) {
    if (s[i] === "\x1b") {
      // eslint-disable-next-line no-control-regex -- ANSI SGR sequence starts with the ESC byte
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    count++;
    i++;
  }
  return `${out}…${RESET}`;
}

function fmtElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface Glyph {
  ch: string;
  code: string;
}

function glyphFor(phase: JobPhase, opts: RenderOpts): Glyph {
  switch (phase) {
    case "success":
      return { ch: "✓", code: CODE.green };
    case "failure":
      return { ch: "✗", code: CODE.red };
    case "skipped":
      return { ch: "⊘", code: CODE.yellow };
    case "running":
      return { ch: opts.final ? "•" : opts.spinner, code: CODE.cyan };
    default:
      return { ch: "◌", code: CODE.gray };
  }
}

function elapsedOf(j: JobState, now: number): number | undefined {
  if (j.startedAt === undefined) return undefined;
  return (j.endedAt ?? now) - j.startedAt;
}

export function renderBoard(name: string, jobs: JobState[], opts: RenderOpts): string[] {
  const c = opts.color;
  const cap = Math.max(8, opts.width - 1);

  const phaseOf = new Map<string, JobPhase>();
  for (const j of jobs) phaseOf.set(j.id, j.phase);

  const counts = { running: 0, success: 0, failure: 0, skipped: 0, pending: 0 };
  let earliest: number | undefined;
  let latest = 0;
  for (const j of jobs) {
    counts[j.phase]++;
    if (j.startedAt !== undefined) earliest = earliest === undefined ? j.startedAt : Math.min(earliest, j.startedAt);
    if (j.endedAt !== undefined) latest = Math.max(latest, j.endedAt);
  }
  const wallMs = earliest === undefined ? 0 : Math.max(latest, opts.now) - earliest;

  const idW = jobs.reduce((m, j) => Math.max(m, j.id.length), 0);

  const lines: string[] = [];

  // Header: workflow name + state chips + total wall time.
  const chips = [
    paint(c, CODE.cyan, `▶${counts.running}`),
    paint(c, CODE.green, `✓${counts.success}`),
    paint(c, CODE.red, `✗${counts.failure}`),
    paint(c, CODE.yellow, `⊘${counts.skipped}`),
    paint(c, CODE.gray, `◌${counts.pending}`),
  ].join(" ");
  const header = `${paint(c, CODE.bold, `workflow: ${name}`)}   ${chips}   ${paint(c, CODE.dim, fmtElapsed(wallMs))}`;
  lines.push(truncVisible(header, cap));

  for (const j of jobs) {
    const indent = "  ".repeat(j.level);
    const branch = j.level > 0 ? paint(c, CODE.gray, "└ ") : "";
    const g = glyphFor(j.phase, opts);
    const glyph = paint(c, g.code, g.ch);
    const id = paint(c, j.phase === "pending" ? CODE.gray : CODE.bold, j.id.padEnd(idW));
    const target = paint(c, CODE.gray, j.runsOn.padEnd(8));

    let status: string;
    if (j.phase === "pending") {
      const unmet = j.needs.filter((n) => phaseOf.get(n) !== "success");
      status = unmet.length
        ? paint(c, CODE.gray, `blocked on ${unmet.join(", ")}`)
        : paint(c, CODE.gray, "ready");
    } else if (j.phase === "skipped") {
      status = paint(c, CODE.yellow, "skipped");
    } else {
      status = paint(c, CODE.dim, `${j.doneSteps}/${j.totalSteps} steps`);
    }

    const el = elapsedOf(j, opts.now);
    const elapsed = el === undefined ? "" : paint(c, CODE.gray, fmtElapsed(el));

    const row = `${indent}${branch}${glyph} ${id}  ${target}  ${status}  ${elapsed}`;
    lines.push(truncVisible(row.trimEnd(), cap));

    // Live sub-line for the running step.
    if (j.phase === "running" && j.currentStep) {
      const sub = `${indent}     ${paint(c, CODE.cyan, "›")} ${paint(c, CODE.dim, j.currentStep)}`;
      lines.push(truncVisible(sub, cap));
    }
  }

  return lines;
}
