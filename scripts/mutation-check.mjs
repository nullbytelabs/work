// Curated mutation check — does the test suite actually CATCH bugs, not just
// execute the code? (Coverage answers "was this line run?"; mutation answers
// "if this line were wrong, would a test go red?")
//
// We plant one plausible bug at a time — an inverted guard, a dropped value, a
// disabled auth check — run the unit suite (`test:unit`, no QEMU), and record
// whether anything fails. A mutation the suite does NOT catch ("SURVIVED") is a
// concrete test gap: a real regression of that exact shape would ship green.
//
// This is the CURATED counterpart to a tool like StrykerJS: instead of thousands
// of generated mutants, a hand-picked table of bugs that would actually matter
// (gating inversions, auth bypasses, secret-injection drops). Seeded from a
// mutation-testing experiment against the full suite; survivors became tests.
//
// Dependency-free: node builtins + git only, in the fan-in.mjs spirit.
//
// SAFETY: each mutation is reverted from an in-memory copy of the original file
// (not `git checkout`, which would also wipe unrelated edits). A file with
// uncommitted changes is SKIPPED, never touched — so this can't clobber WIP — and
// a crash/Ctrl-C restores every pending file before exiting.
//
// Usage:
//   node scripts/mutation-check.mjs            # run the whole table
//   node scripts/mutation-check.mjs M-cond-eq  # run mutations whose id matches a substring
//   npm run mutation                           # same, via package.json
//
// Exit code: 0 iff every runnable mutation was CAUGHT. Non-zero if any SURVIVED
// (a test gap) or any mutation's find-string is stale (the table needs a touch-up).
// Dirty-skipped mutations warn but do not, by themselves, fail the run.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rel = (f) => path.join(root, f);

// --- The mutation table -----------------------------------------------------
// Each entry: a unique `find` substring in `file`, the `replace` that introduces
// a plausible bug, and `why` (the regression it simulates). Keep `find` long
// enough to be unique; the script asserts exactly one occurrence.
const MUTATIONS = [
  // compiler — the DSL contract
  { id: "M-matrix-exclude", file: "src/compiler/matrix.ts",
    find: "!matrix.exclude!.some((ex) =>", replace: "matrix.exclude!.some((ex) =>",
    why: "matrix exclude keeps the excluded cells instead of pruning them" },
  { id: "M-cycle-detect", file: "src/compiler/compile.ts",
    find: "if (order.length !== ids.length) {", replace: "if (order.length < 0) {",
    why: "a needs: cycle is silently accepted instead of rejected" },
  { id: "M-cond-eq", file: "src/compiler/condition.ts",
    find: 'return node.op === "==" ? eq : !eq;', replace: 'return node.op === "==" ? !eq : eq;',
    why: "if:/when: == and != are swapped" },
  { id: "M-cond-and", file: "src/compiler/condition.ts",
    find: "truthy(evalNode(node.l, ctx)) && truthy(evalNode(node.r, ctx))",
    replace: "truthy(evalNode(node.l, ctx)) || truthy(evalNode(node.r, ctx))",
    why: "condition && behaves like ||" },
  { id: "M-input-required", file: "src/compiler/inputs.ts",
    find: "} else if (spec.required) {", replace: "} else if (false) {",
    why: "a required input that's missing no longer errors" },

  // runtime — job gating and data flow
  { id: "M-deps-skip", file: "src/runtime/absurd/runtime.ts",
    find: "} else if (!depsAllSucceeded) {", replace: "} else if (false) {",
    why: "a job runs even when a needs dependency failed" },
  { id: "M-deps-all", file: "src/runtime/absurd/runtime.ts",
    find: 'const depsAllSucceeded = depResults.every((d) => d.status === "success");',
    replace: 'const depsAllSucceeded = depResults.some((d) => d.status === "success");',
    why: "a job gates on ANY dep succeeding instead of ALL" },
  { id: "M-needs-outputs", file: "src/runtime/absurd/runtime.ts",
    find: "needs[dep.id] = { outputs: dep.outputs ?? {}, result: dep.status };",
    replace: "needs[dep.id] = { outputs: {}, result: dep.status };",
    why: "a dependency's outputs never reach its dependents" },

  // web — auth and browser-protection gates
  { id: "M-bearer-auth", file: "src/web/server.ts",
    find: "return timingSafeEqual(ab, bb);", replace: "return true;",
    why: "webhook bearer-token check always passes (auth bypass)" },
  { id: "M-hmac-auth", file: "src/web/server.ts",
    find: "return timingSafeEqual(got, expected);", replace: "return true;",
    why: "webhook HMAC signature check always passes (auth bypass)" },
  { id: "M-host-header", file: "src/web/server.ts",
    find: "if (!isHook && !allowedHosts.has(host)) {", replace: "if (false) {",
    why: "the loopback Host-header (DNS-rebinding) guard is disabled" },
  { id: "M-csrf-token", file: "src/web/server.ts",
    find: 'req.headers["x-work-token"] !== token', replace: "false",
    why: "the CSRF token check on mutating UI requests is disabled" },

  // egress — the security property the architecture hangs on
  { id: "M-model-key", file: "src/agent/egress.ts",
    find: "if (hosts.size > 0 && value !== undefined) {", replace: "if (false) {",
    why: "the model API key is never injected into the job network" },
  { id: "M-datasource-deny", file: "src/egress/datasource.ts",
    find: "if (scoped.length === 0) return undefined; // deny-by-default",
    replace: "if (scoped.length === 0) return { allowedHosts: [] }; // deny-by-default",
    why: "an unscoped job's datasource egress resolver fails open instead of returning deny" },
];

// --- Safety: in-memory restore, even on crash -------------------------------
/** file path -> original bytes, for any file currently mutated. */
const pending = new Map();
function restoreAll() {
  for (const [abs, original] of pending) {
    try { writeFileSync(abs, original); } catch { /* best effort on the way out */ }
  }
  pending.clear();
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}
process.on("exit", restoreAll);

function isDirty(file) {
  const out = execSync(`git status --porcelain -- ${JSON.stringify(file)}`, { cwd: root, encoding: "utf8" });
  return out.trim().length > 0;
}

/** Run `test:unit` once; return { caught, pass, fail } parsed from TAP summary. */
function runSuite() {
  const r = spawnSync("npm", ["run", "test:unit"], { cwd: root, encoding: "utf8", timeout: 180_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const pass = out.match(/^.\s*pass (\d+)/m)?.[1] ?? "?";
  const fail = out.match(/^.\s*fail (\d+)/m)?.[1] ?? "?";
  return { caught: r.status !== 0, pass, fail };
}

// --- Run --------------------------------------------------------------------
const filter = process.argv[2];
const table = filter ? MUTATIONS.filter((m) => m.id.includes(filter)) : MUTATIONS;
if (table.length === 0) {
  console.error(`no mutations match "${filter}". ids: ${MUTATIONS.map((m) => m.id).join(", ")}`);
  process.exit(2);
}

console.log(`\nmutation-check — ${table.length} curated mutation(s), each vs. \`npm run test:unit\`\n`);

const results = [];
for (const m of table) {
  const abs = rel(m.file);
  const original = readFileSync(abs, "utf8");
  const occurrences = original.split(m.find).length - 1;

  if (occurrences !== 1) {
    results.push({ ...m, verdict: occurrences === 0 ? "STALE (not found)" : `STALE (${occurrences}x)` });
    console.log(`  …  ${m.id.padEnd(18)} STALE — find-string ${occurrences === 0 ? "not found" : "not unique"} in ${m.file}`);
    continue;
  }
  if (isDirty(m.file)) {
    results.push({ ...m, verdict: "SKIPPED (dirty)" });
    console.log(`  …  ${m.id.padEnd(18)} SKIPPED — ${m.file} has uncommitted changes (commit or stash to test it)`);
    continue;
  }

  writeFileSync(abs, original.replace(m.find, m.replace));
  pending.set(abs, original);
  const { caught, pass, fail } = runSuite();
  writeFileSync(abs, original);
  pending.delete(abs);

  const verdict = caught ? "CAUGHT" : "SURVIVED";
  results.push({ ...m, verdict, pass, fail });
  const mark = caught ? "✔" : "✗";
  console.log(`  ${mark}  ${m.id.padEnd(18)} ${verdict.padEnd(9)} (pass ${pass}, fail ${fail})  — ${m.why}`);
}

// --- Report -----------------------------------------------------------------
const survived = results.filter((r) => r.verdict === "SURVIVED");
const stale = results.filter((r) => r.verdict.startsWith("STALE"));
const skipped = results.filter((r) => r.verdict.startsWith("SKIPPED"));
const caught = results.filter((r) => r.verdict === "CAUGHT");

console.log(`\nsummary: ${caught.length} caught, ${survived.length} survived, ${stale.length} stale, ${skipped.length} skipped (of ${results.length})`);

if (survived.length) {
  console.log("\nSURVIVED — a regression of this exact shape would ship green; these mark test gaps:");
  for (const r of survived) console.log(`  • ${r.id} (${r.file}) — ${r.why}`);
}
if (stale.length) {
  console.log("\nSTALE — the code moved out from under these mutations; update scripts/mutation-check.mjs:");
  for (const r of stale) console.log(`  • ${r.id} (${r.file}) — ${r.verdict}`);
}
if (skipped.length) {
  console.log(`\nSKIPPED ${skipped.length} mutation(s) on files with uncommitted changes (not a failure).`);
}
console.log("");

process.exit(survived.length || stale.length ? 1 : 0);
