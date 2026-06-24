/**
 * tempo-trace action — resolve a work run's OpenTelemetry trace in Grafana Tempo
 * by its run id and emit a distilled span tree.
 *
 * ABI (work node action): inputs arrive as INPUT_<NAME>; the Grafana service-account
 * token arrives as INPUT_GRAFANA_TOKEN — the workflow passes it as the `grafana_token`
 * input (${{ secrets.GRAFANA_TOKEN }}, resolved host-side from work.json's secrets:
 * whitelist). The distilled tree is printed and written to $WORK_OUTPUT as `tree`.
 */
import { writeFileSync } from "node:fs";

const die = (msg) => {
  console.error(`tempo-trace: ${msg}`);
  process.exit(1);
};

// ── inputs ───────────────────────────────────────────────────────────────────

const baseUrl = (process.env.INPUT_GRAFANA_URL || "").replace(/\/$/, "");
const token = process.env.INPUT_GRAFANA_TOKEN;
const runId = process.env.INPUT_RUN_ID;
const lookbackHours = Number(process.env.INPUT_LOOKBACK_HOURS || "720");

if (!baseUrl) die("grafana_url input is empty");
if (!runId) die("run_id input is empty");
if (!token) die("grafana_token input is empty — pass ${{ secrets.GRAFANA_TOKEN }} (declared in the secrets: block of work.json)");

// ── Grafana HTTP ─────────────────────────────────────────────────────────────

const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };

async function grafana(path) {
  const res = await fetch(baseUrl + path, { headers: auth });
  const body = await res.text();
  if (!res.ok) die(`HTTP ${res.status} for ${path}\n${body.slice(0, 400)}`);
  try {
    return JSON.parse(body);
  } catch {
    return die(`non-JSON for ${path}: ${body.slice(0, 200)}`);
  }
}

// Tempo is reached through Grafana's datasource proxy — find its uid once.
async function tempoProxy() {
  const sources = await grafana("/api/datasources");
  const tempo = (Array.isArray(sources) ? sources : []).find((d) => d.type === "tempo");
  if (!tempo) die("no Tempo datasource on this Grafana stack");
  return `/api/datasources/proxy/uid/${tempo.uid}`;
}

// The run id rides on spans as `work.run.id`; search resolves it to the random
// OTLP trace id.
async function resolveTraceId(proxy) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - lookbackHours * 3600;
  const query = encodeURIComponent(`{ span.work.run.id = "${runId}" }`);
  const { traces = [] } = await grafana(`${proxy}/api/search?q=${query}&start=${start}&end=${end}&limit=5`);
  if (traces.length === 0) {
    die(`no trace found for work.run.id=${runId} within the last ${lookbackHours}h ` +
      `(widen lookback_hours, or check the run id / that telemetry landed)`);
  }
  return traces[0].traceID;
}

// ── distill the OTLP trace into a span tree ──────────────────────────────────

const KEEP_ATTR = /^(gen_ai|work|cicd|error|host\.image)\./;

const attrValue = (v) =>
  v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? (v?.arrayValue ? JSON.stringify(v.arrayValue) : "");
const attrsOf = (list) => Object.fromEntries((list || []).map((a) => [a.key, attrValue(a.value)]));
const toMs = (nanos) => (nanos ? Number(BigInt(nanos) / 1000000n) : 0);

// Flatten OTLP's resource → scope → span nesting (both the modern `*Spans` keys
// and the legacy `instrumentationLibrarySpans` shape) into a flat span list plus
// the merged resource attributes.
function flattenTrace(trace) {
  const spans = [];
  let resource = {};
  for (const batch of trace.batches || trace.resourceSpans || []) {
    resource = { ...resource, ...attrsOf(batch.resource?.attributes) };
    for (const scope of batch.scopeSpans || batch.instrumentationLibrarySpans || []) {
      for (const s of scope.spans || []) {
        spans.push({
          name: s.name,
          id: s.spanId,
          parent: s.parentSpanId || null,
          attrs: attrsOf(s.attributes),
          status: s.status?.code ?? 0,
          start: toMs(s.startTimeUnixNano),
          end: toMs(s.endTimeUnixNano),
        });
      }
    }
  }
  return { spans, resource };
}

function renderTree(trace, traceId) {
  const { spans, resource } = flattenTrace(trace);
  if (spans.length === 0) die(`trace ${traceId} returned no spans (ingestion lag?)`);

  const t0 = Math.min(...spans.map((s) => s.start));
  const totalMs = Math.max(...spans.map((s) => s.end)) - t0;
  const childrenOf = (id) => spans.filter((s) => s.parent === id).sort((a, b) => a.start - b.start);
  const isRoot = (s) => !s.parent || !spans.some((x) => x.id === s.parent);

  const lines = [
    `run.id        ${runId}`,
    `trace.id      ${traceId}`,
    `service       ${resource["service.name"] ?? "?"} v${resource["service.version"] ?? "?"} (${resource["host.arch"] ?? "?"})`,
    `spans/total   ${spans.length} spans · ${totalMs}ms`,
    "",
  ];

  const walk = (span, depth) => {
    const pad = "  ".repeat(depth);
    const error = span.status === 2 ? "  ⚠ ERROR" : "";
    lines.push(`${pad}▸ ${span.name}  [${span.end - span.start}ms]${error}`);
    for (const [k, v] of Object.entries(span.attrs).filter(([k]) => KEEP_ATTR.test(k)).sort()) {
      lines.push(`${pad}    ${k} = ${v}`);
    }
    for (const child of childrenOf(span.id)) walk(child, depth + 1);
  };
  for (const root of spans.filter(isRoot).sort((a, b) => a.start - b.start)) walk(root, 0);

  return lines.join("\n");
}

// ── run ──────────────────────────────────────────────────────────────────────

const proxy = await tempoProxy();
const traceId = await resolveTraceId(proxy);
const trace = await grafana(`${proxy}/api/traces/${traceId}`);
const tree = renderTree(trace, traceId);

console.log(tree);

// $WORK_OUTPUT uses $GITHUB_OUTPUT semantics — the multi-line tree is a heredoc
// value, exposed as steps.<id>.outputs.tree.
if (process.env.WORK_OUTPUT) {
  writeFileSync(process.env.WORK_OUTPUT, `tree<<__TRACE_EOF__\n${tree}\n__TRACE_EOF__\ntrace_id=${traceId}\n`);
}
