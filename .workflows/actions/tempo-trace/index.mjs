/**
 * tempo-trace action — resolve a work run's OpenTelemetry trace in Grafana Tempo
 * by its run id and emit a distilled span tree.
 *
 * ABI (work node action): inputs arrive as INPUT_<NAME>; the grafana service-account
 * token arrives as INPUT_GRAFANA_TOKEN (passed from the workflow as the
 * `grafana_token` input, ${{ secrets.GRAFANA_TOKEN }}, resolved host-side from the
 * work.json secrets: whitelist). Declared outputs are written to $WORK_OUTPUT.
 */
import { writeFileSync } from "node:fs";

function fail(msg) {
  console.error(`tempo-trace: ${msg}`);
  process.exit(1);
}

const base = (process.env.INPUT_GRAFANA_URL || "").replace(/\/$/, "");
const token = process.env.INPUT_GRAFANA_TOKEN;
const runId = process.env.INPUT_RUN_ID;
const lookbackH = Number(process.env.INPUT_LOOKBACK_HOURS || "720");
if (!base) fail("grafana_url input is empty");
if (!runId) fail("run_id input is empty");
if (!token) fail("grafana_token input is empty — pass ${{ secrets.GRAFANA_TOKEN }} (declared in the secrets: block of work.json)");

const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
async function gapi(path) {
  const res = await fetch(base + path, { headers });
  const body = await res.text();
  if (!res.ok) fail(`HTTP ${res.status} for ${path}\n${body.slice(0, 400)}`);
  try {
    return JSON.parse(body);
  } catch {
    return fail(`non-JSON for ${path}: ${body.slice(0, 200)}`);
  }
}

// 1. Discover the Tempo datasource uid.
const ds = await gapi("/api/datasources");
const tempo = (Array.isArray(ds) ? ds : []).find((d) => d.type === "tempo");
if (!tempo) fail("no Tempo datasource on this Grafana stack");
const proxy = `/api/datasources/proxy/uid/${tempo.uid}`;

// 2. Resolve the random OTLP trace id from the work run id.
const end = Math.floor(Date.now() / 1000);
const start = end - lookbackH * 3600;
const q = `{ span.work.run.id = "${runId}" }`;
const search = await gapi(`${proxy}/api/search?q=${encodeURIComponent(q)}&start=${start}&end=${end}&limit=5`);
const traces = search.traces || [];
if (traces.length === 0) {
  fail(`no trace found for work.run.id=${runId} within the last ${lookbackH}h ` +
    `(widen lookback_hours, or check the run id / that telemetry landed)`);
}
const traceId = traces[0].traceID;

// 3. Fetch the full trace (OTLP JSON) and distill it.
const trace = await gapi(`${proxy}/api/traces/${traceId}`);

const attrVal = (v) => v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? (v?.arrayValue ? JSON.stringify(v.arrayValue) : "");
const attrMap = (arr) => Object.fromEntries((arr || []).map((a) => [a.key, attrVal(a.value)]));
const ns = (s) => (s ? Number(BigInt(s) / 1000000n) : 0);

const spans = [];
let resource = {};
for (const b of trace.batches || trace.resourceSpans || []) {
  resource = { ...resource, ...attrMap(b.resource?.attributes) };
  for (const ss of b.scopeSpans || b.instrumentationLibrarySpans || [])
    for (const s of ss.spans || [])
      spans.push({ name: s.name, id: s.spanId, parent: s.parentSpanId || null, attrs: attrMap(s.attributes), status: s.status?.code ?? 0, start: ns(s.startTimeUnixNano), end: ns(s.endTimeUnixNano) });
}
if (spans.length === 0) fail(`trace ${traceId} returned no spans (ingestion lag?)`);
const t0 = Math.min(...spans.map((s) => s.start));
const total = Math.max(...spans.map((s) => s.end)) - t0;

const keep = (k) => /^(gen_ai|work|cicd|error|host\.image)\./.test(k);
const kids = (p) => spans.filter((s) => s.parent === p).sort((a, b) => a.start - b.start);
const lines = [];
lines.push(`run.id        ${runId}`);
lines.push(`trace.id      ${traceId}`);
lines.push(`service       ${resource["service.name"] ?? "?"} v${resource["service.version"] ?? "?"} (${resource["host.arch"] ?? "?"})`);
lines.push(`spans/total   ${spans.length} spans · ${total}ms`);
lines.push("");
const render = (s, d) => {
  lines.push(`${"  ".repeat(d)}▸ ${s.name}  [${s.end - s.start}ms]${s.status === 2 ? "  ⚠ ERROR" : ""}`);
  for (const [k, v] of Object.entries(s.attrs).filter(([k]) => keep(k)).sort())
    lines.push(`${"  ".repeat(d)}    ${k} = ${v}`);
  for (const c of kids(s.id)) render(c, d + 1);
};
for (const r of spans.filter((s) => !s.parent || !spans.find((x) => x.id === s.parent)).sort((a, b) => a.start - b.start)) render(r, 0);

const out = lines.join("\n");
console.log(out);

// Emit declared outputs. $WORK_OUTPUT uses $GITHUB_OUTPUT semantics — the multi-line
// tree is a heredoc value (→ steps.<id>.outputs.tree).
if (process.env.WORK_OUTPUT) {
  writeFileSync(process.env.WORK_OUTPUT, `tree<<__TRACE_EOF__\n${out}\n__TRACE_EOF__\ntrace_id=${traceId}\n`);
}
