/**
 * `work doctor` — environment & host verification.
 *
 * Read-only by design: it reports what's wrong and prints the exact remediation
 * command, but never mutates the host (no `--fix`). That keeps it trustworthy as
 * a CI gate and aligns with the project's "never do surprising things" stance.
 *
 *   exit 0  — no hard failures (warnings are allowed)
 *   exit 1  — at least one failed check
 *   exit 2  — a usage error (unknown flag), via the shared `fail`
 */
import { CODE, paint, shouldColor } from "../tui/palette.ts";
import { failUsage, prog } from "../cli-util.ts";
import { type Check, type CheckStatus, type DoctorProbes, defaultProbes, overallStatus, runChecks } from "./checks.ts";

interface DoctorOptions {
  json: boolean;
}

function parseDoctorArgs(argv: string[]): DoctorOptions {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:\n  ${prog()} doctor [--json]\n\nChecks this machine can run gondolin workflows. Read-only.\n`);
      process.exit(0);
    } else if (arg === "--fix") {
      failUsage("doctor has no --fix: it never mutates your host. It prints the exact remediation command for each ✗ — run that yourself.");
    } else {
      failUsage(`unknown flag for doctor: ${arg}`);
    }
  }
  return { json };
}

const GLYPH: Record<CheckStatus, { ch: string; code: string }> = {
  pass: { ch: "✓", code: CODE.green },
  warn: { ch: "⊘", code: CODE.yellow },
  fail: { ch: "✗", code: CODE.red },
};

function renderText(checks: Check[], color: boolean): string {
  const titleW = checks.reduce((m, c) => Math.max(m, c.title.length), 0);
  const lines: string[] = [];
  for (const c of checks) {
    const g = GLYPH[c.status];
    const glyph = paint(color, g.code, g.ch);
    const title = c.title.padEnd(titleW);
    const detail = c.detail ? `  ${paint(color, CODE.dim, c.detail)}` : "";
    lines.push(`  ${glyph} ${title}${detail}`);
    if (c.remediation && c.status !== "pass") {
      lines.push(`      ${paint(color, CODE.gray, `→ ${c.remediation}`)}`);
    }
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const summary =
    fails > 0
      ? paint(color, CODE.red, `${fails} failed${warns ? `, ${warns} warning${warns > 1 ? "s" : ""}` : ""} — not ready`)
      : warns > 0
        ? paint(color, CODE.yellow, `ready with ${warns} warning${warns > 1 ? "s" : ""}`)
        : paint(color, CODE.green, "all checks passed");
  lines.push("", `  ${summary}`);
  return lines.join("\n") + "\n";
}

/** Run the doctor command. Resolves with the process exit code. */
export async function runDoctor(argv: string[], probes: DoctorProbes = defaultProbes()): Promise<number> {
  const opts = parseDoctorArgs(argv);
  const checks = await runChecks(probes);
  const status = overallStatus(checks);
  const exitCode = status === "fail" ? 1 : 0;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: status !== "fail",
          status,
          checks: checks.map((c) => ({
            id: c.id,
            title: c.title,
            status: c.status,
            ...(c.detail ? { detail: c.detail } : {}),
            ...(c.remediation ? { remediation: c.remediation } : {}),
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    // Auto-plain when piped/redirected or --json; honour NO_COLOR/FORCE_COLOR.
    process.stdout.write(renderText(checks, shouldColor(Boolean(process.stdout.isTTY))));
  }

  return exitCode;
}
