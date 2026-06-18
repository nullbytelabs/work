/**
 * `work` operator extension.
 *
 * Makes this pi agent a first-class operator of the local `work` engine:
 *   - Deterministic, structured tools over the CLI (no stdout scraping):
 *       work_runs   — run history as structured rows
 *       work_graph  — a workflow's compiled DAG as JSON
 *       work_doctor — preflight status as JSON
 *       work_review — extract verified REVIEW JSON (findings) from a run log
 *   - A live run-status widget (unfinished runs surfaced above the editor).
 *   - Guardrails for the two known footguns:
 *       1. `dist/` shadowing `src/` — block real runs while dist/ exists.
 *       2. `work.json` holds API keys — block reads, steer to work.example.json.
 *
 * Read-only tools only: actual runs stay in bash (they boot VMs and stream for
 * minutes — a blocking tool is the wrong shape for that).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pexec = promisify(execFile);

/** Walk up from a start dir to the nearest ancestor containing `bin/work.mjs`. */
function findWorkRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "bin", "work.mjs"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Run the dev shim and return combined output. */
async function runWork(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const opts: Parameters<typeof pexec>[2] = { cwd: root, maxBuffer: 32 * 1024 * 1024 };
  if (signal) opts.signal = signal;
  try {
    const { stdout, stderr } = await pexec(join(root, "bin", "work.mjs"), args, opts);
    return `${stdout}${stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`;
  }
}

interface RunRow {
  id: string;
  workflow: string;
  status: string;
  when: string;
}

/** Parse the aligned table `work runs` prints. */
function parseRuns(out: string): RunRow[] {
  const rows: RunRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim() || line.startsWith("ID") || line.includes("unfinished")) continue;
    if (/^no .*runs/i.test(line)) continue;
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length >= 4 && cols[0] && /^[0-9a-f]+$/i.test(cols[0])) {
      rows.push({ id: cols[0], workflow: cols[1]!, status: cols[2]!, when: cols.slice(3).join(" ") });
    }
  }
  return rows;
}

const UNFINISHED = new Set(["interrupted", "running", "queued"]);

/** Extract every REVIEW JSON sentinel block (aggregate + labeled) from a log. */
function extractReviews(log: string): Array<{ scope: string; data: unknown; raw: string }> {
  const re =
    /=====\s*REVIEW JSON(?:\s*\[([^\]]+)\])?\s*BEGIN\s*=====([\s\S]*?)=====\s*REVIEW JSON(?:\s*\[[^\]]+\])?\s*END\s*=====/g;
  const out: Array<{ scope: string; data: unknown; raw: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const scope = m[1] ?? "aggregate";
    const raw = (m[2] ?? "").trim();
    let data: unknown = undefined;
    try {
      data = JSON.parse(raw);
    } catch {
      const s = raw.indexOf("{");
      const e = raw.lastIndexOf("}");
      if (s >= 0 && e > s) {
        try {
          data = JSON.parse(raw.slice(s, e + 1));
        } catch {
          /* leave undefined; raw is still returned */
        }
      }
    }
    out.push({ scope, data, raw });
  }
  return out;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}

/** Refresh the unfinished-runs widget (best-effort, never throws). */
async function refreshWidget(root: string, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  if (!existsSync(join(root, ".workflows", "db"))) return;
  try {
    const rows = parseRuns(await runWork(root, ["runs"])).filter((r) => UNFINISHED.has(r.status));
    if (rows.length === 0) {
      ctx.ui.setWidget("work-runs", []);
      ctx.ui.setStatus("work", "");
      return;
    }
    ctx.ui.setWidget(
      "work-runs",
      [
        `⏳ ${rows.length} unfinished work run${rows.length > 1 ? "s" : ""} — resume with \`work resume <id>\``,
        ...rows.slice(0, 4).map((r) => `   ${r.id}  ${r.workflow}  ${r.status}  ${r.when}`),
      ],
    );
    ctx.ui.setStatus("work", `work: ${rows.length} unfinished`);
  } catch {
    /* ignore */
  }
}

export default function (pi: ExtensionAPI) {
  // Per-session: have we already run the `work doctor` preflight before a real run?
  let preflightChecked = false;
  pi.on("session_start", async (_event, ctx) => {
    preflightChecked = false;
    const root = findWorkRoot(ctx.cwd);
    if (root) await refreshWidget(root, ctx);
  });

  // ---- Guardrails ----------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const cmd = event.input.command;
    const root = findWorkRoot(ctx.cwd);

    // Footgun 1: dist/ shadows src/. Block real runs while dist/ exists.
    const isRealRun = /\b(work\.mjs|work|npm start --)\s+(--\S+\s+)*\b(run|resume|rerun)\b/.test(cmd);
    if (isRealRun && root && existsSync(join(root, "dist"))) {
      return {
        block: true,
        reason:
          "dist/ exists and the bin shim prefers dist/cli.js, which shadows your src/ edits. Run `rm -rf dist` first, then re-run.",
      };
    }

    // Footgun 2: work.json holds API keys. Block reads; steer to the example.
    if (/\b(cat|less|more|head|tail|bat|nl)\b[^|;&]*\bwork\.json\b/.test(cmd)) {
      return {
        block: true,
        reason:
          "work.json is gitignored because it holds API keys — don't print it. Read work.example.json for the config shape, or grep for a specific non-secret key.",
      };
    }

    // Preflight: before the FIRST real run of a session, run `work doctor`. If the
    // environment can't boot VMs, block early with the failing checks rather than
    // letting the run fail minutes in. Only blocks on a hard failure.
    if (isRealRun && root && !preflightChecked) {
      preflightChecked = true; // attempt once; don't re-gate on transient doctor errors
      try {
        const out = await runWork(root, ["doctor", "--json"], ctx.signal);
        const s = out.indexOf("{");
        const e = out.lastIndexOf("}");
        if (s >= 0 && e > s) {
          const report = JSON.parse(out.slice(s, e + 1)) as {
            ok?: boolean;
            checks?: Array<{ title?: string; status?: string; detail?: string }>;
          };
          if (report.ok === false) {
            const failing = (report.checks ?? [])
              .filter((c) => c.status && c.status !== "pass")
              .map((c) => `  • ${c.title ?? "check"}: ${c.status}${c.detail ? ` (${c.detail})` : ""}`)
              .join("\n");
            return {
              block: true,
              reason:
                `\`work doctor\` reports the environment can't run a real workflow yet:\n${failing}\n` +
                "Fix these (or run `work doctor` to see details) before launching a real run.",
            };
          }
        }
      } catch {
        /* doctor itself failed to run — don't block the user's run on that */
      }
    }
  });

  // ---- Deterministic tools -------------------------------------------------
  pi.registerTool({
    name: "work_runs",
    label: "Work Runs",
    description:
      "List the local work engine's run history as structured rows (id, workflow, status, when). Read-only. Use to find a run id to resume/rerun/inspect, or to check what finished.",
    promptSnippet: "List work run history (id/workflow/status); find resumable runs",
    promptGuidelines: [
      "Use work_runs to get authoritative run ids and statuses instead of parsing `work runs` stdout.",
    ],
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "Filter: queued|running|success|failure|interrupted" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = findWorkRoot(ctx.cwd);
      if (!root) return text("Not inside a work checkout (no bin/work.mjs found).");
      const args = ["runs", ...(params.status ? ["--status", params.status] : [])];
      const out = await runWork(root, args, signal);
      const rows = parseRuns(out);
      const unfinished = rows.filter((r) => UNFINISHED.has(r.status));
      const lines = rows.length
        ? rows.map((r) => `${r.id}  ${r.workflow}  ${r.status}  ${r.when}`).join("\n")
        : "(no runs)";
      const hint = unfinished.length
        ? `\n\n${unfinished.length} unfinished — resume: work resume ${unfinished[0]!.id}`
        : "";
      return {
        content: [{ type: "text" as const, text: lines + hint }],
        details: { rows, unfinished },
      };
    },
  });

  pi.registerTool({
    name: "work_graph",
    label: "Work Graph",
    description:
      "Compile a work workflow (by name or file path) and return its DAG as JSON WITHOUT running it. Read-only pre-flight: inspect jobs, needs edges, steps, runs-on, and machine sizes before a real run.",
    promptSnippet: "Compile a workflow to JSON DAG (no run) — inspect jobs/steps/needs",
    parameters: Type.Object({
      target: Type.String({ description: "Workflow name (e.g. ci) or a .yaml file path" }),
      steps: Type.Optional(Type.Boolean({ description: "Include step-level detail (default true)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = findWorkRoot(ctx.cwd);
      if (!root) return text("Not inside a work checkout (no bin/work.mjs found).");
      const args = ["graph", params.target, "--format", "json"];
      if (params.steps !== false) args.push("--steps");
      const out = await runWork(root, args, signal);
      const s = out.indexOf("{");
      const e = out.lastIndexOf("}");
      if (s < 0 || e <= s) return text(`Could not parse DAG JSON. Raw output:\n${out}`);
      let data: unknown;
      try {
        data = JSON.parse(out.slice(s, e + 1));
      } catch {
        return text(`Could not parse DAG JSON. Raw output:\n${out}`);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: { graph: data } };
    },
  });

  pi.registerTool({
    name: "work_doctor",
    label: "Work Doctor",
    description:
      "Run the work engine preflight (Node version, gondolin SDK, QEMU, config) and return the structured result. Use before a real run when boot/QEMU issues are suspected.",
    promptSnippet: "Work preflight: Node/gondolin/QEMU/config status",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const root = findWorkRoot(ctx.cwd);
      if (!root) return text("Not inside a work checkout (no bin/work.mjs found).");
      const out = await runWork(root, ["doctor", "--json"], signal);
      const s = out.indexOf("{");
      const e = out.lastIndexOf("}");
      if (s >= 0 && e > s) {
        try {
          const data = JSON.parse(out.slice(s, e + 1));
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: { doctor: data } };
        } catch {
          /* fall through to raw */
        }
      }
      return text(out);
    },
  });

  pi.registerTool({
    name: "work_review",
    label: "Work Review",
    description:
      "Extract the VERIFIED review findings (REVIEW JSON sentinel blocks) from a work review/ci run log. Returns each scope's findings (aggregate + per-subsystem) plus whether a TOOLING FAILED banner is present. Use to triage `work run review|ci` output instead of regexing by hand.",
    promptSnippet: "Extract verified REVIEW JSON findings from a run log",
    promptGuidelines: [
      "Use work_review to parse review/ci run logs; each finding must still be independently confirmed in the code before fixing or rejecting.",
    ],
    parameters: Type.Object({
      logPath: Type.String({ description: "Path to a teed run log (e.g. /tmp/work-review.log)" }),
    }),
    async execute(_id, params) {
      if (!existsSync(params.logPath)) return text(`Log not found: ${params.logPath}`);
      const log = readFileSync(params.logPath, "utf8");
      const blocks = extractReviews(log);
      const toolingFailed = /⚠\s*TOOLING FAILED/.test(log);
      if (blocks.length === 0) {
        return text(
          `No REVIEW JSON sentinel blocks found in ${params.logPath}.` +
            (toolingFailed ? " (A ⚠ TOOLING FAILED banner IS present — a tool/test step failed.)" : "") +
            " The run may be incomplete or not a review/ci run.",
        );
      }
      const summary = blocks
        .map((b) => {
          const d = b.data as { verdict?: string; findings?: unknown[]; summary?: string } | undefined;
          const n = Array.isArray(d?.findings) ? d!.findings!.length : "?";
          return `[${b.scope}] verdict=${d?.verdict ?? "?"} findings=${n}${d?.summary ? ` — ${d.summary}` : ""}`;
        })
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text:
              (toolingFailed ? "⚠ TOOLING FAILED banner present.\n\n" : "") +
              summary +
              "\n\n" +
              JSON.stringify(blocks.map((b) => ({ scope: b.scope, data: b.data })), null, 2),
          },
        ],
        details: { toolingFailed, blocks },
      };
    },
  });

  // Manual widget refresh (e.g. after kicking off a run in another shell).
  pi.registerCommand("work-status", {
    description: "Refresh the unfinished work-runs widget",
    handler: async (_args, ctx) => {
      const root = findWorkRoot(ctx.cwd);
      if (root) await refreshWidget(root, ctx);
    },
  });
}
