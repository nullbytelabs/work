// SLOC distribution — the "where does the weight sit?" question.
//
// For every owned TypeScript file (src/ + test/, the tsconfig file set), count
// SOURCE lines — lines bearing at least one real code token, excluding blanks and
// comment-only lines. Then report them in two separate views so the signal isn't
// swamped: APP CODE (src/) on its own — largest files, percentiles, by-subsystem
// rollup — and TEST CODE broken down by discipline (unit / property / e2e /
// support). Mixing them buries the app-code smells under the (larger, more
// numerous) test files, which defeats the point.
//
// Report-only: always exits 0. Wired into `npm run check` and CI right after
// fan-in to stay visible next to the other structural numbers — but it is NOT a
// gate. File size has no natural pass/fail line; we track the shape over time and
// judge the tail by hand.
//
// Dependency-free: uses the project's own `typescript` via the SCANNER, so string
// and comment boundaries are exact. That matters here — src/web/client.ts is one
// huge embedded-HTML template literal, and a naive `//`/`/* */` stripper would
// miscount it wildly. The scanner knows a `//` inside a string is not a comment.
import ts from "typescript";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const APP_TOP = Number(process.env.SLOC_TOP ?? 25);
const TEST_TOP = Number(process.env.SLOC_TEST_TOP ?? 12);

// --- Load tsconfig and resolve the owned file set ---------------------------
const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);

const rel = (f) => path.relative(root, f).split(path.sep).join("/");

// Bucket a file into app code, or a test sub-discipline. Order matters: e2e dirs
// before the `.test.ts` suffix checks, support last (any other owned test .ts,
// e.g. _support.ts).
function groupOf(file) {
  if (file.startsWith("src/")) return "app";
  if (file.startsWith("test/e2e/") || file.startsWith("test/web-e2e/")) return "test:e2e";
  if (file.endsWith(".property.test.ts")) return "test:property";
  if (file.endsWith(".test.ts")) return "test:unit";
  return "test:support";
}

// A trivia token carries no code. Lines made up only of these don't count as SLOC.
const TRIVIA = new Set([
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia,
  ts.SyntaxKind.ConflictMarkerTrivia,
]);

// Count source lines: scan the file and mark every line that any non-trivia token
// touches. A token can span multiple lines (a multi-line template literal), and
// each line it covers is authored source, so all of them count.
function slocOf(text) {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, /*setParentNodes*/ false);
  const lineAt = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ false, ts.LanguageVariant.Standard, text);
  const codeLines = new Set();
  for (let tok = scanner.scan(); tok !== ts.SyntaxKind.EndOfFileToken; tok = scanner.scan()) {
    if (TRIVIA.has(tok)) continue;
    const start = scanner.getTokenStart?.() ?? scanner.getTokenPos();
    const end = scanner.getTextPos();
    const firstLine = lineAt(start);
    const lastLine = lineAt(Math.max(start, end - 1));
    for (let l = firstLine; l <= lastLine; l++) codeLines.add(l);
  }
  const totalLines = sf.getLineStarts().length;
  return { sloc: codeLines.size, totalLines };
}

const rows = [];
for (const fileName of parsed.fileNames) {
  const file = rel(fileName);
  if (!file.match(/^(src|test)\//)) continue;
  const text = ts.sys.readFile(fileName);
  if (text === undefined) continue;
  const { sloc, totalLines } = slocOf(text);
  rows.push({ file, sloc, totalLines, group: groupOf(file) });
}

// --- Report helpers ---------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const fmt = (n) => n.toLocaleString("en-US");

// Nearest-rank percentiles + total/mean over a set of rows.
function stats(group) {
  const s = group.map((r) => r.sloc).sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  const q = (p) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
  return { total, mean: group.length ? Math.round(total / group.length) : 0, p50: q(50), p75: q(75), p90: q(90), p95: q(95), p99: q(99), max: s.at(-1) ?? 0 };
}

// Largest N files of a group (assumed pre-sorted desc) as a table.
function largest(group, n, label) {
  console.log(`\nlargest ${Math.min(n, group.length)} ${label} by SLOC`);
  console.log(lpad("sloc", 7) + lpad("lines", 8) + lpad("code%", 8) + "  file");
  console.log("-".repeat(80));
  for (const r of group.slice(0, n)) {
    const codePct = r.totalLines ? Math.round((100 * r.sloc) / r.totalLines) : 0;
    console.log(lpad(fmt(r.sloc), 7) + lpad(fmt(r.totalLines), 8) + lpad(codePct + "%", 8) + "  " + r.file);
  }
}

// --- Report -----------------------------------------------------------------
const app = rows.filter((r) => r.group === "app").sort((a, b) => b.sloc - a.sloc);
const test = rows.filter((r) => r.group !== "app").sort((a, b) => b.sloc - a.sloc);
const appTotal = app.reduce((a, r) => a + r.sloc, 0);
const testTotal = test.reduce((a, r) => a + r.sloc, 0);

console.log(`\nsloc — owned .ts  (${rows.length} files, ${fmt(appTotal + testTotal)} SLOC: ${fmt(appTotal)} app + ${fmt(testTotal)} test)`);

// ===== APP CODE (the smell-hunting view) =====
console.log(`\n══ app code — src/  (${app.length} files, ${fmt(appTotal)} SLOC) ══`);
largest(app, APP_TOP, "app files");
const a = stats(app);
console.log("\nper-file SLOC distribution (app)");
for (const [k, v] of [["p50", a.p50], ["p75", a.p75], ["p90", a.p90], ["p95", a.p95], ["p99", a.p99], ["max", a.max], ["mean", a.mean]]) {
  console.log(`  ${pad(k, 5)} ${lpad(fmt(v), 7)}`);
}
const areas = new Map();
for (const r of app) {
  const seg = r.file.split("/");
  const area = seg.length > 2 ? `${seg[0]}/${seg[1]}` : seg[0];
  const ar = areas.get(area) ?? { sloc: 0, files: 0 };
  ar.sloc += r.sloc;
  ar.files += 1;
  areas.set(area, ar);
}
console.log("\nby subsystem (total SLOC, files)");
for (const [area, ar] of [...areas].sort((x, y) => y[1].sloc - x[1].sloc)) {
  console.log("  " + pad(area, 20) + lpad(fmt(ar.sloc), 8) + lpad(ar.files + "f", 7));
}

// ===== TEST CODE (by discipline) =====
console.log(`\n══ test code  (${test.length} files, ${fmt(testTotal)} SLOC) ══`);
console.log("\nby discipline (files, total SLOC, median, p90, largest)");
console.log("  " + pad("discipline", 10) + lpad("files", 6) + lpad("SLOC", 8) + lpad("median", 8) + lpad("p90", 7) + "  largest");
for (const d of ["test:unit", "test:property", "test:e2e", "test:support"]) {
  const g = test.filter((r) => r.group === d); // preserves the desc sort, so g[0] is the largest
  if (!g.length) continue;
  const s = stats(g);
  console.log("  " + pad(d.replace("test:", ""), 10) + lpad(g.length, 6) + lpad(fmt(s.total), 8) + lpad(fmt(s.p50), 8) + lpad(fmt(s.p90), 7) + "  " + `${g[0].file} (${fmt(g[0].sloc)})`);
}
largest(test, TEST_TOP, "test files");

console.log("\n(report only — not a gate; track the shape over time)\n");
