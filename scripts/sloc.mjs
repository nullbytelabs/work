// SLOC distribution — the "where does the weight sit?" question.
//
// For every owned TypeScript file (src/ + test/, the tsconfig file set), count
// SOURCE lines — lines bearing at least one real code token, excluding blanks and
// comment-only lines. Then surface the N largest files and the per-file SLOC
// distribution in percentiles. A long thin tail = a few giant files worth
// splitting; a fat p90 = broadly heavy modules.
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
const TOP = Number(process.env.SLOC_TOP ?? 25);

// --- Load tsconfig and resolve the owned file set ---------------------------
const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);

const rel = (f) => path.relative(root, f).split(path.sep).join("/");

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
  if (!rel(fileName).match(/^(src|test)\//)) continue;
  const text = ts.sys.readFile(fileName);
  if (text === undefined) continue;
  const { sloc, totalLines } = slocOf(text);
  rows.push({ file: rel(fileName), sloc, totalLines });
}

// --- Report -----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

const total = rows.reduce((a, r) => a + r.sloc, 0);
const fmt = (n) => n.toLocaleString("en-US");

console.log(`\nsloc — source-line distribution of owned .ts (src/ + test/)  (${rows.length} files, ${fmt(total)} SLOC)\n`);

// Largest files by SLOC. `code%` = how much of the file is code vs blank/comment.
rows.sort((a, b) => b.sloc - a.sloc);
console.log(`largest ${Math.min(TOP, rows.length)} files by SLOC`);
console.log(lpad("sloc", 7) + lpad("lines", 8) + lpad("code%", 8) + "  file");
console.log("-".repeat(80));
for (const r of rows.slice(0, TOP)) {
  const codePct = r.totalLines ? Math.round((100 * r.sloc) / r.totalLines) : 0;
  console.log(lpad(fmt(r.sloc), 7) + lpad(fmt(r.totalLines), 8) + lpad(codePct + "%", 8) + "  " + r.file);
}

// Per-file SLOC distribution, nearest-rank percentiles.
const sorted = rows.map((r) => r.sloc).sort((a, b) => a - b);
const pct = (p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
const mean = rows.length ? Math.round(total / rows.length) : 0;
console.log("\nper-file SLOC distribution");
for (const p of [50, 75, 90, 95, 99]) console.log(`  p${pad(p, 4)} ${lpad(fmt(pct(p)), 7)}`);
console.log(`  ${pad("max", 5)} ${lpad(fmt(sorted.at(-1) ?? 0), 7)}`);
console.log(`  ${pad("mean", 5)} ${lpad(fmt(mean), 7)}`);

// By-area rollup: src/ grouped by subsystem (src/<dir>), test lumped. The thing
// to watch over time — which subsystem is accreting weight.
const areas = new Map();
for (const r of rows) {
  const seg = r.file.split("/");
  const area = seg[0] === "src" && seg.length > 2 ? `${seg[0]}/${seg[1]}` : seg[0];
  const a = areas.get(area) ?? { sloc: 0, files: 0 };
  a.sloc += r.sloc;
  a.files += 1;
  areas.set(area, a);
}
console.log("\nby area (total SLOC, files)");
for (const [area, a] of [...areas].sort((x, y) => y[1].sloc - x[1].sloc)) {
  console.log("  " + pad(area, 20) + lpad(fmt(a.sloc), 8) + lpad(a.files + "f", 7));
}

console.log("\n(report only — not a gate; track the shape over time)\n");
