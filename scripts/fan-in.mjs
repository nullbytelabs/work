// Afferent-coupling / fan-in analysis — the "what's load-bearing?" question.
//
// Replicates a Bernhardt-style class-usage distribution at the SYMBOL level:
// for every exported declaration under src/, count how many *other* modules
// reference it. A thin heavy tail = a few load-bearing types; a single dominant
// node = a god object worth breaking up.
//
// Report-only: always exits 0. It is wired into `npm run check` to stay visible
// next to lint/typecheck/knip, but it is NOT a gate — coupling has no natural
// pass/fail threshold, so we surface the numbers and judge them by hand.
//
// Dependency-free: uses the project's own `typescript` (the same compiler
// `npm run typecheck` runs) via the LanguageService — no ts-morph, no second
// vendored TS, no version skew.
import ts from "typescript";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// --- Load tsconfig and resolve the file set ---------------------------------
const configPath = path.join(root, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const fileNames = parsed.fileNames;

// --- Minimal LanguageService host backed by disk ----------------------------
const snapshotCache = new Map();
const readSnapshot = (fileName) => {
  const text = ts.sys.readFile(fileName);
  return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
};
const host = {
  getScriptFileNames: () => fileNames,
  getScriptVersion: () => "0", // files are static for a single run
  getScriptSnapshot: (fileName) => {
    if (!snapshotCache.has(fileName)) snapshotCache.set(fileName, readSnapshot(fileName));
    return snapshotCache.get(fileName);
  },
  getCurrentDirectory: () => root,
  getCompilationSettings: () => parsed.options,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const program = service.getProgram();

const rel = (f) => path.relative(root, f).split(path.sep).join("/");
const inSrc = (f) => rel(f).startsWith("src/");
const isTest = (f) => rel(f).startsWith("test/");

// --- Enumerate exported declarations under src/ -----------------------------
const kindLabel = {
  [ts.SyntaxKind.ClassDeclaration]: "class",
  [ts.SyntaxKind.FunctionDeclaration]: "fn",
  [ts.SyntaxKind.InterfaceDeclaration]: "iface",
  [ts.SyntaxKind.TypeAliasDeclaration]: "type",
  [ts.SyntaxKind.EnumDeclaration]: "enum",
};

const isExported = (node) =>
  ts.canHaveModifiers(node) &&
  ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

// Yield { name, kind, pos } for each named, exported, top-level declaration.
function* exportsOf(sourceFile) {
  for (const stmt of sourceFile.statements) {
    if (kindLabel[stmt.kind] && isExported(stmt) && stmt.name) {
      yield { name: stmt.name.text, kind: kindLabel[stmt.kind], pos: stmt.name.getStart(sourceFile) };
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          yield { name: d.name.text, kind: "const", pos: d.name.getStart(sourceFile) };
        }
      }
    }
  }
}

const rows = [];
for (const sf of program.getSourceFiles()) {
  const file = sf.fileName;
  if (!inSrc(file)) continue;

  for (const decl of exportsOf(sf)) {
    const refs = service.getReferencesAtPosition(file, decl.pos) ?? [];
    const refFiles = new Set();
    let externalFileRefs = 0;
    let testRefs = 0;
    for (const r of refs) {
      if (r.isDefinition) continue;
      const rf = r.fileName;
      if (isTest(rf)) testRefs++;
      if (rf !== file) {
        externalFileRefs++;
        refFiles.add(rel(rf));
      }
    }
    rows.push({
      name: decl.name,
      kind: decl.kind,
      file: rel(file),
      externalFileRefs,
      srcFanIn: [...refFiles].filter((f) => f.startsWith("src/")).length,
      testRefs,
    });
  }
}

// --- Report -----------------------------------------------------------------
rows.sort((a, b) => b.srcFanIn - a.srcFanIn || b.externalFileRefs - a.externalFileRefs);

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log(`\nfan-in — afferent coupling of exported symbols in src/  (${rows.length} symbols)\n`);
console.log(
  pad("symbol", 26) + pad("kind", 7) + lpad("src-modules", 12) + lpad("ext-refs", 10) + lpad("test-refs", 11) + "  defined in",
);
console.log("-".repeat(100));
for (const r of rows.slice(0, 30)) {
  console.log(
    pad(r.name, 26) + pad(r.kind, 7) + lpad(r.srcFanIn, 12) + lpad(r.externalFileRefs, 10) + lpad(r.testRefs, 11) + "  " + r.file,
  );
}

// Per-symbol fan-in distribution — the same percentile view `sloc` uses, since
// fan-in is the same shape of skewed distribution: a low-coupling body (most
// symbols), a load-bearing tail (the few many modules lean on). p50→p99 shows how
// fast it climbs; mean ≫ p50 confirms the skew; max is the most-coupled symbol.
const fanIns = rows.map((r) => r.srcFanIn).sort((a, b) => a - b);
const fmt = (n) => n.toLocaleString("en-US");
const total = fanIns.reduce((a, b) => a + b, 0);
const q = (p) => fanIns[Math.max(0, Math.ceil((p / 100) * fanIns.length) - 1)] ?? 0;
const stats = [["p50", q(50)], ["p75", q(75)], ["p90", q(90)], ["p95", q(95)], ["p99", q(99)], ["max", fanIns.at(-1) ?? 0], ["mean", rows.length ? Math.round(total / rows.length) : 0]];
console.log("\nper-symbol src-module fan-in distribution");
for (const [k, v] of stats) {
  console.log(`  ${pad(k, 5)} ${lpad(fmt(v), 7)}`);
}
console.log("\n(report only — not a gate; review the tail by hand)\n");

service.dispose?.();
