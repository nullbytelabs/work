/**
 * The local web server — a `node:http` listener bound to loopback only that wraps
 * the engine's existing capabilities (discovery, the inputs schema, the DAG
 * emitter, the run hooks) in HTTP + SSE. Zero new dependencies (see
 * docs/web-ui-research.md §5).
 *
 * Security posture (§9): the action is already sandboxed (every job runs in a
 * gondolin micro-VM), so what we guard is the *trigger surface* against
 * CSRF/DNS-rebinding from a malicious site in the user's browser. Layered,
 * dependency-free mitigations:
 *   1. bind `127.0.0.1` only (never `0.0.0.0`);
 *   2. validate the `Host` header (reject anything but `127.0.0.1:<port>` /
 *      `localhost:<port>` → 403, killing DNS-rebinding);
 *   3. require a startup CSRF token (`X-Work-Token`) on every `POST` (a cross-site
 *      `fetch` can't set a custom header without a preflight we never permit);
 *   4. never emit any `Access-Control-Allow-Origin`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { parseWorkflow, WorkflowParseError } from "../spec/index.ts";
import { compile, WorkflowCompileError } from "../compiler/index.ts";
import { emitGraph } from "../graph/index.ts";
import { listWorkflows, findWorkflowByName } from "../project.ts";
import { createAbsurdEngine, type AbsurdEngine } from "../runtime/index.ts";
import type { TargetFactory } from "../targets/index.ts";
import { expandEnv, type PiWorkflowsConfig, type WebhookConfig } from "../config/index.ts";
import { UserFacingError } from "../errors.ts";
import { RunRepository } from "../persistence/runs.ts";
import { RunEventRepository } from "../persistence/run-events.ts";
import { DeliveryRepository, type DeliveryResult, type DeliveryRow } from "../persistence/deliveries.ts";
import { RunManager } from "./run-manager.ts";
import { renderShell } from "./client.ts";

/** Default port (§9); on contention we try the next few before erroring. */
const DEFAULT_PORT = 4280;
const PORT_RETRIES = 8;
const HEARTBEAT_MS = 15_000;
/** Hard cap on a webhook body before buffering — abort larger payloads (webhook §4 L2). */
const MAX_HOOK_BODY_BYTES = 256 * 1024;
/** Window in which an identical webhook re-delivery is treated as a duplicate (no new run). */
const DEDUPE_TTL_MS = 300_000;
/** Bounded in-memory delivery audit ring — so the UI shows recent deliveries even with no `dataDir`. */
const RECENT_DELIVERIES_CAP = 200;

export interface StartWebServerOptions {
  /** Project root whose `.workflows/` the UI enumerates. */
  workspace: string;
  /** Preferred port (default 4280); falls forward on EADDRINUSE. */
  port?: number;
  /** A shared engine to run on; one is booted (and owned) when omitted. */
  engine?: AbsurdEngine;
  /**
   * Persist the engine (and run history) to this directory, so history survives a
   * restart. Only honored when we boot our own engine (no `engine` injected); the
   * server must be the sole owner of the dataDir (PGLite is single-process).
   */
  dataDir?: string;
  /** Provider/model config for agent steps. */
  config?: PiWorkflowsConfig | undefined;
  /** Override the runs-on → target factory (tests inject a host double). */
  makeTarget?: TargetFactory;
  /** Max runs executing at once (default 4) — bounds gondolin load under a trigger storm. */
  maxConcurrentRuns?: number;
  /** Max runs queued for a slot before new triggers are shed with 429 (default 100). */
  maxQueuedRuns?: number;
}

export interface WebServerHandle {
  url: string;
  port: number;
  /** The CSRF token required on POSTs (also embedded in the served page). */
  token: string;
  close(): Promise<void>;
}

/** Boot the server. Resolves once it's listening; rejects if no port is free. */
export async function startWebServer(opts: StartWebServerOptions): Promise<WebServerHandle> {
  // Own the engine only when we booted it — an injected (shared/test) engine is
  // the caller's to close. A `dataDir` is honored only when we boot it (the server
  // must be the sole owner — PGLite is single-process).
  const ownsEngine = opts.engine === undefined;
  if (ownsEngine && opts.dataDir) await mkdir(opts.dataDir, { recursive: true });
  const engine = opts.engine ?? (await createAbsurdEngine(ownsEngine && opts.dataDir ? { dataDir: opts.dataDir } : {}));

  // Durable run history when (and only when) we own a persistent engine; otherwise
  // history is the in-memory, session-scoped registry.
  let runStore: RunRepository | undefined;
  let eventStore: RunEventRepository | undefined;
  if (ownsEngine && opts.dataDir) {
    runStore = new RunRepository(engine);
    await runStore.ensureSchema();
    // Per-run log persistence (Phase 2) rides the same durable engine, so a
    // restarted server can replay a finished run's SSE stream, not just list it.
    eventStore = new RunEventRepository(engine);
    await eventStore.ensureSchema();
  }

  // Webhook delivery audit log. Durable when we own a persistent engine (so the
  // UI's "Recent deliveries" survives a restart); always also mirrored to a
  // bounded in-memory ring below, so deliveries are visible even without a
  // `dataDir` (the injected-engine / no-persistence path).
  let deliveryRepo: DeliveryRepository | undefined;
  if (ownsEngine && opts.dataDir) {
    deliveryRepo = new DeliveryRepository(engine);
    await deliveryRepo.ensureSchema();
  }

  const runManager = new RunManager({
    engine,
    config: opts.config,
    ...(opts.makeTarget ? { makeTarget: opts.makeTarget } : {}),
    ...(opts.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: opts.maxConcurrentRuns } : {}),
    ...(opts.maxQueuedRuns !== undefined ? { maxQueuedRuns: opts.maxQueuedRuns } : {}),
    ...(runStore ? { runStore } : {}),
    ...(eventStore ? { eventStore } : {}),
  });

  // Startup CSRF token: random hex, printed by the launcher and embedded in the
  // page. Mutating requests must echo it back via `X-Work-Token`.
  const token = randomBytes(16).toString("hex");
  const html = renderShell(token);

  // Track open SSE responses so `close()` can end them — long-lived sockets
  // otherwise block `server.close()` indefinitely.
  const sseResponses = new Set<ServerResponse>();
  const heartbeats = new Set<ReturnType<typeof setInterval>>();

  // Webhook delivery dedupe (webhook §4 "Mandatory" / §7 step 2). Senders retry
  // on 5xx and re-send a still-firing group, and runs are non-idempotent, so an
  // identical re-delivery within a short window must return the original runId and
  // start nothing. No sender supplies a delivery-id, so the key is sha256(hook +
  // raw body). Bounded TTL map — opportunistically pruned so it can't grow forever.
  const deliveries = new Map<string, { runId: string; expires: number }>();
  function dedupeLookup(key: string): string | undefined {
    const hit = deliveries.get(key);
    if (hit && hit.expires > Date.now()) return hit.runId;
    if (hit) deliveries.delete(key);
    return undefined;
  }
  function dedupeStore(key: string, runId: string): void {
    const now = Date.now();
    if (deliveries.size > 1000) for (const [k, v] of deliveries) if (v.expires <= now) deliveries.delete(k);
    deliveries.set(key, { runId, expires: now + DEDUPE_TTL_MS });
  }

  // Always-on, bounded in-memory delivery audit ring (newest pushed last). It's
  // the source for `GET …/deliveries` when there's no durable `deliveryRepo`,
  // and a fast best-effort mirror when there is. Each entry carries its hook so a
  // per-hook query can filter it. Capped so a delivery storm can't grow memory.
  interface RecentDelivery extends DeliveryRow {
    hook: string;
  }
  const recentDeliveries: RecentDelivery[] = [];

  /**
   * Audit one webhook delivery attempt at a `handleHook` exit (or the UI test
   * action). Stamps `ts = Date.now()`, pushes onto the bounded in-memory ring,
   * and fire-and-forgets the durable write (a persistence error must never break
   * the receiver's response, so it's swallowed). Scoped to *configured* hooks by
   * the caller — unknown-hook 404s aren't audited (avoids attacker log spam).
   */
  function recordDelivery(d: {
    hook: string;
    workflow?: string | undefined;
    result: DeliveryResult;
    httpStatus: number;
    runId?: string | undefined;
    sourceIp?: string | undefined;
  }): void {
    const ts = Date.now();
    recentDeliveries.push({
      hook: d.hook,
      ts,
      result: d.result,
      httpStatus: d.httpStatus,
      runId: d.runId ?? null,
      sourceIp: d.sourceIp ?? null,
    });
    if (recentDeliveries.length > RECENT_DELIVERIES_CAP) recentDeliveries.shift();
    deliveryRepo
      ?.append({ hook: d.hook, workflow: d.workflow, result: d.result, httpStatus: d.httpStatus, runId: d.runId, sourceIp: d.sourceIp, ts })
      .catch(() => {});
  }

  /** Recent deliveries for one hook, newest-first, capped — durable store if present, else the ring. */
  async function listDeliveries(hook: string, limit = 50): Promise<DeliveryRow[]> {
    if (deliveryRepo) return deliveryRepo.listForHook(hook, limit);
    const out: DeliveryRow[] = [];
    for (let i = recentDeliveries.length - 1; i >= 0 && out.length < limit; i--) {
      const d = recentDeliveries[i]!;
      if (d.hook === hook) out.push({ ts: d.ts, result: d.result, httpStatus: d.httpStatus, runId: d.runId, sourceIp: d.sourceIp });
    }
    return out;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    });
  });

  const port = await listen(server, opts.port ?? DEFAULT_PORT);

  // The valid Host header values for the bound port (loopback only).
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  /** A route handler. `params` are the regex capture groups, each decodeURIComponent'd. */
  type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;
  interface Route {
    method: string;
    pattern: RegExp;
    handler: RouteHandler;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;

    // The webhook receiver (`POST /hooks/*`) is a deliberately tunnel-exposed,
    // server-to-server surface: it arrives with a *public* Host (the tunnel's
    // domain) and no browser CSRF token, and authenticates cryptographically
    // instead (HMAC/bearer, fail-closed). So it is exempt from the loopback Host
    // check and the CSRF token gate, which exist only to protect the *browser*
    // UI from DNS-rebinding/CSRF (webhook-triggers-research.md §4).
    const isHook = path.startsWith("/hooks/");

    // (2) Host-header validation — reject anything but loopback:<port> (UI only).
    const host = req.headers.host ?? "";
    if (!isHook && !allowedHosts.has(host)) {
      sendJson(res, 403, { error: `invalid Host header: ${host}` });
      return;
    }

    // (3) CSRF token on every mutating UI request (hooks carry their own auth).
    if (method === "POST" && !isHook && req.headers["x-work-token"] !== token) {
      sendJson(res, 403, { error: "missing or invalid X-Work-Token" });
      return;
    }

    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(path);
      if (!m) continue;
      await route.handler(req, res, m.slice(1).map((s) => decodeURIComponent(s)));
      return;
    }
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
  }

  // The route table, scanned in order by `handle`. Patterns are anchored and
  // disjoint, so order is for readability, not disambiguation. The two `/hooks/`
  // / `/test` entries delegate to the dedicated handlers below.
  const ROUTES: Route[] = [
    { method: "GET", pattern: /^\/$/, handler: serveShell },
    { method: "GET", pattern: /^\/api\/workflows$/, handler: getWorkflows },
    { method: "GET", pattern: /^\/api\/workflows\/([^/]+)\/form$/, handler: getForm },
    { method: "GET", pattern: /^\/api\/workflows\/([^/]+)\/graph$/, handler: getGraph },
    { method: "POST", pattern: /^\/api\/runs$/, handler: postRuns },
    { method: "POST", pattern: /^\/hooks\/([^/]+)$/, handler: (req, res, p) => handleHook(p[0]!, req, res) },
    { method: "GET", pattern: /^\/api\/webhooks$/, handler: getWebhooks },
    { method: "GET", pattern: /^\/api\/webhooks\/([^/]+)\/deliveries$/, handler: getDeliveries },
    { method: "POST", pattern: /^\/api\/webhooks\/([^/]+)\/test$/, handler: (req, res, p) => handleWebhookTest(p[0]!, req, res) },
    { method: "GET", pattern: /^\/api\/runs$/, handler: getRuns },
    { method: "GET", pattern: /^\/api\/runs\/([^/]+)\/events$/, handler: getEvents },
    { method: "POST", pattern: /^\/api\/runs\/([^/]+)\/rerun$/, handler: postRerun },
  ];

  // GET / → the HTML shell.
  function serveShell(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  // GET /api/workflows → { name, file }[].
  async function getWorkflows(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJson(res, 200, await listWorkflows(opts.workspace));
  }

  // GET /api/workflows/:name/form → the InputSpec map ({} if none).
  async function getForm(_req: IncomingMessage, res: ServerResponse, p: string[]): Promise<void> {
    const name = p[0]!;
    const spec = await loadSpec(name);
    if (!spec) { sendJson(res, 404, { error: `no workflow named "${name}"` }); return; }
    sendJson(res, 200, spec.inputs ?? {});
  }

  // GET /api/workflows/:name/graph → emitGraph json (already JSON text).
  async function getGraph(_req: IncomingMessage, res: ServerResponse, p: string[]): Promise<void> {
    const name = p[0]!;
    const spec = await loadSpec(name);
    if (!spec) { sendJson(res, 404, { error: `no workflow named "${name}"` }); return; }
    try {
      const plan = compile(spec, {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(emitGraph(plan, "json", { steps: true }));
    } catch (err) {
      sendCompileError(res, err);
    }
  }

  // POST /api/runs → compile + dispatch → 202 { runId }.
  async function postRuns(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { name?: unknown; inputs?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "body must be JSON" });
      return;
    }
    if (typeof body.name !== "string") { sendJson(res, 400, { error: "body.name is required" }); return; }
    const inputs =
      body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : {};

    const layout = await resolveLayout(body.name);
    if (!layout) { sendJson(res, 404, { error: `no workflow named "${body.name}"` }); return; }

    let plan;
    try {
      const spec = parseWorkflow(await readFile(layout.file, "utf-8"));
      plan = compile(spec, { inputs });
    } catch (err) {
      sendCompileError(res, err);
      return;
    }
    const result = runManager.dispatch({
      name: body.name,
      layout: layoutFields(layout),
      plan,
    });
    if (!result.accepted) { sendJson(res, 429, { error: "server at run capacity — retry shortly" }); return; }
    sendJson(res, 202, { runId: result.record.id });
  }

  // GET /api/webhooks → the configured hooks (NEVER any secret). Just a listing,
  // so an empty/absent `webhooks` config is a plain `[]` (no 404). `configured`
  // tells the UI whether the hook's secret actually resolves (else it's a
  // fail-closed 404 at delivery time).
  function getWebhooks(_req: IncomingMessage, res: ServerResponse): void {
    const hooks = opts.config?.webhooks ?? {};
    sendJson(
      res,
      200,
      Object.entries(hooks).map(([name, entry]) => ({
        name,
        workflow: entry.workflow,
        enabled: entry.enabled !== false,
        auth: entry.auth ?? "bearer",
        datasources: entry.datasources ?? [],
        configured: (entry.secret ? expandEnv(entry.secret) : "").length > 0,
      })),
    );
  }

  // GET /api/webhooks/:name/deliveries → audited deliveries, newest-first, capped.
  // 404 a name that isn't a configured webhook (don't leak the ring for arbitrary
  // keys). NEVER includes the payload or secret.
  async function getDeliveries(_req: IncomingMessage, res: ServerResponse, p: string[]): Promise<void> {
    const name = p[0]!;
    if (!opts.config?.webhooks?.[name]) { sendJson(res, 404, { error: `no webhook named "${name}"` }); return; }
    sendJson(res, 200, await listDeliveries(name, 50));
  }

  // GET /api/runs → history (newest-first).
  async function getRuns(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJson(res, 200, await runManager.list());
  }

  // GET /api/runs/:id/events → SSE stream (live tail, else replay a past run).
  async function getEvents(_req: IncomingMessage, res: ServerResponse, p: string[]): Promise<void> {
    const runId = p[0]!;

    if (runManager.get(runId)) {
      // Live, in-memory run: replay the ring then tail live (unchanged path).
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();
      sseResponses.add(res);
      runManager.subscribe(runId, res);
      // Heartbeat so proxies/clients keep the connection open.
      const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
      beat.unref?.();
      heartbeats.add(beat);
      res.on("close", () => {
        clearInterval(beat);
        heartbeats.delete(beat);
        sseResponses.delete(res);
      });
      return;
    }

    // Not live: try replaying a *past* run's persisted log (Phase 2). On a hit
    // `replayHistorical` writes the SSE headers + every stored frame in order
    // and ends the stream. On a miss it touches nothing, so we can still send a
    // clean JSON 404 (preserving the legacy no-store behavior).
    if (await runManager.replayHistorical(runId, res)) return;
    sendJson(res, 404, { error: `no run "${runId}"` });
  }

  // POST /api/runs/:id/rerun → re-dispatch a past run with its stored inputs.
  async function postRerun(_req: IncomingMessage, res: ServerResponse, p: string[]): Promise<void> {
    const id = p[0]!;
    const stored = await runManager.getStored(id);
    if (!stored) { sendJson(res, 404, { error: `no run "${id}"` }); return; }

    const layout = await resolveLayout(stored.name);
    if (!layout) { sendJson(res, 404, { error: `no workflow named "${stored.name}"` }); return; }

    let plan;
    try {
      const spec = parseWorkflow(await readFile(layout.file, "utf-8"));
      plan = compile(spec, { inputs: stored.inputs ?? {} });
    } catch (err) {
      sendCompileError(res, err);
      return;
    }
    const result = runManager.dispatch({
      name: stored.name,
      layout: layoutFields(layout),
      plan,
      trigger: "dispatch",
    });
    if (!result.accepted) { sendJson(res, 429, { error: "server at run capacity — retry shortly" }); return; }
    sendJson(res, 202, { runId: result.record.id });
  }

  /** Resolve a workflow name to its layout, or undefined if absent. */
  async function resolveLayout(name: string) {
    try {
      return await findWorkflowByName(opts.workspace, name);
    } catch (err) {
      if (err instanceof UserFacingError) return undefined;
      throw err;
    }
  }

  /** Resolve + read + parse a workflow's spec by name (undefined if absent). */
  async function loadSpec(name: string) {
    const layout = await resolveLayout(name);
    if (!layout) return undefined;
    return parseWorkflow(await readFile(layout.file, "utf-8"));
  }

  /**
   * The authenticated, async webhook trigger (webhook-triggers-research.md §4/§7).
   * `/hooks/:name` selects a config-declared webhook entry (the public URL is the
   * config key, not the workflow name, so the secret is per-hook). It is
   * **fail-closed**: anything not fully configured + opted-in + authenticated is a
   * generic 404 that never discloses which hooks exist. Auth is a bearer token or
   * an HMAC-SHA256 signature over the raw body (Grafana signs natively; GitHub-style
   * `sha256=` is accepted); the body is hard-capped and parsed only after auth, and
   * we then ack fast (202) and run in the background — the sender never waits on
   * gondolin.
   */
  async function handleHook(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // L1 fail-closed gate: the hook must exist, be enabled, and have a usable
    // secret. A missing hook is invisible (generic 404) and — being unconfigured —
    // is NOT audited (an attacker probing random paths can't spam the log). Once
    // we have a real `entry`, every subsequent fail-closed exit is recorded.
    const entry: WebhookConfig | undefined = opts.config?.webhooks?.[name];
    if (!entry) return notFoundHook(res);
    const sourceIp = req.socket.remoteAddress ?? undefined;

    const gate = checkHookConfig(name, entry, res, sourceIp);
    if (!gate) return;
    const { secret, mode } = gate;

    // Opt-in gate (defense-in-depth), before buffering any body: the target
    // workflow must itself declare `on: webhook`, so a config entry alone can't
    // make an un-opted workflow remotely triggerable.
    const opted = await loadOptedInSpec(name, entry, res, sourceIp);
    if (!opted) return;
    const { spec, layout } = opted;

    const auth = await authorizeHook({ name, entry, secret, mode, req, res, sourceIp });
    if (!auth) return;
    const raw = auth.raw;

    // Dedupe an identical re-delivery (retry / repeat send) within the window —
    // return the original run, start nothing. Keyed on the authenticated raw body.
    const deliveryKey = createHash("sha256").update(`${name}\n${raw}`).digest("hex");
    const dup = dedupeLookup(deliveryKey);
    if (dup) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "duplicate", httpStatus: 200, runId: dup, sourceIp });
      sendJson(res, 200, { runId: dup, deduped: true, eventsUrl: `/api/runs/${dup}/events` });
      return;
    }

    const event = parseEventBody(name, entry, raw, res, sourceIp);
    if (!event) return;

    // Bake the payload into the plan (`${{ event.* }}`) and dispatch async.
    let plan;
    try {
      plan = compile(spec, { event });
    } catch (err) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "bad_request", httpStatus: 400, sourceIp });
      sendCompileError(res, err);
      return;
    }
    const result = runManager.dispatch({
      name: entry.workflow,
      layout: layoutFields(layout),
      plan,
      trigger: "webhook",
      // Scope this run's datasource egress to exactly what the hook declares, so
      // a fact-finding `run:` can reach those APIs with header-injected tokens.
      ...(entry.datasources ? { datasources: entry.datasources } : {}),
    });
    // L3 backpressure: under a storm we shed load with 429 + Retry-After (which
    // re-hits the fail-closed/auth path safely) rather than spawning more VMs.
    if (!result.accepted) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "at_capacity", httpStatus: 429, sourceIp });
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "5" });
      res.end(JSON.stringify({ error: "at capacity — retry shortly" }));
      return;
    }
    // Remember this delivery so an identical retry within the window dedupes.
    dedupeStore(deliveryKey, result.record.id);
    recordDelivery({ hook: name, workflow: entry.workflow, result: "accepted", httpStatus: 202, runId: result.record.id, sourceIp });
    // L7 ack-fast: the sender gets the run id immediately; the UI can watch it
    // live over SSE via the returned `eventsUrl`.
    sendJson(res, 202, { runId: result.record.id, eventsUrl: `/api/runs/${result.record.id}/events` });
  }

  /**
   * Config gate for a known hook: enabled + a usable secret + a supported auth
   * mode (bearer/HMAC). Each failure audits a row and sends a generic 404; returns
   * the resolved `{ secret, mode }` only when the hook is fully usable.
   */
  function checkHookConfig(
    name: string,
    entry: WebhookConfig,
    res: ServerResponse,
    sourceIp: string | undefined,
  ): { secret: string; mode: "bearer" | "hmac-sha256" } | null {
    if (entry.enabled === false) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "disabled", httpStatus: 404, sourceIp });
      notFoundHook(res);
      return null;
    }
    const secret = entry.secret ? expandEnv(entry.secret) : "";
    if (!secret) {
      // A secret-less configured hook is fail-closed (no auth ⇒ disabled), but
      // it IS a configured name, so we audit the rejection for the operator.
      recordDelivery({ hook: name, workflow: entry.workflow, result: "not_opted_in", httpStatus: 404, sourceIp });
      notFoundHook(res);
      return null;
    }
    // Auth mode: bearer (default) or HMAC-SHA256 over the raw body. Anything else
    // isn't satisfiable in this build (e.g. Stripe/Slack's timestamped schemes) —
    // fail closed and warn the operator rather than disclosing the hook.
    const mode = entry.auth ?? "bearer";
    if (mode !== "bearer" && mode !== "hmac-sha256") {
      process.stderr.write(`work: webhook "${name}" uses unsupported auth "${mode}" — rejecting\n`);
      recordDelivery({ hook: name, workflow: entry.workflow, result: "not_opted_in", httpStatus: 404, sourceIp });
      notFoundHook(res);
      return null;
    }
    return { secret, mode };
  }

  /** Resolve, read, and parse the target workflow; it must declare `on: webhook`. */
  async function loadOptedInSpec(
    name: string,
    entry: WebhookConfig,
    res: ServerResponse,
    sourceIp: string | undefined,
  ): Promise<{ spec: ReturnType<typeof parseWorkflow>; layout: NonNullable<Awaited<ReturnType<typeof resolveLayout>>> } | null> {
    const layout = await resolveLayout(entry.workflow);
    if (!layout) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "not_opted_in", httpStatus: 404, sourceIp });
      notFoundHook(res);
      return null;
    }
    let spec;
    try {
      spec = parseWorkflow(await readFile(layout.file, "utf-8"));
    } catch (err) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "bad_request", httpStatus: 400, sourceIp });
      sendCompileError(res, err);
      return null;
    }
    if (!spec.on?.webhook) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "not_opted_in", httpStatus: 404, sourceIp });
      notFoundHook(res);
      return null;
    }
    return { spec, layout };
  }

  /**
   * Authenticate (L4) and return the raw body. Bearer is header-only, so it's
   * checked BEFORE reading the body. HMAC must hash the RAW bytes the sender
   * signed, so we read the (capped) body first and verify over exactly those
   * bytes — re-serializing would break the signature (the #1 webhook bug). Each
   * failure audits a row + sends the response; returns the raw body on success.
   */
  async function authorizeHook(a: {
    name: string;
    entry: WebhookConfig;
    secret: string;
    mode: "bearer" | "hmac-sha256";
    req: IncomingMessage;
    res: ServerResponse;
    sourceIp: string | undefined;
  }): Promise<{ raw: string } | null> {
    const { name, entry, secret, mode, req, res, sourceIp } = a;
    if (mode === "bearer") {
      const presented = bearerToken(req, entry.signatureHeader);
      if (!presented) {
        recordDelivery({ hook: name, workflow: entry.workflow, result: "unauthorized", httpStatus: 401, sourceIp });
        sendJson(res, 401, { error: "missing credentials" });
        return null;
      }
      if (!constantTimeEqual(presented, secret)) {
        recordDelivery({ hook: name, workflow: entry.workflow, result: "forbidden", httpStatus: 403, sourceIp });
        sendJson(res, 403, { error: "invalid credentials" });
        return null;
      }
      const raw = await readCappedOr413(name, entry, req, res, sourceIp);
      return raw === null ? null : { raw };
    }

    const raw = await readCappedOr413(name, entry, req, res, sourceIp);
    if (raw === null) return null;
    // Default to GitHub's header name; Grafana operators set
    // `signatureHeader: X-Grafana-Alerting-Signature` (bare hex, no scheme prefix).
    const header = entry.signatureHeader ?? "X-Hub-Signature-256";
    const presented = req.headers[header.toLowerCase()];
    if (typeof presented !== "string" || presented.length === 0) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "unauthorized", httpStatus: 401, sourceIp });
      sendJson(res, 401, { error: "missing signature" });
      return null;
    }
    if (!verifyHmacSha256(secret, raw, presented)) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "forbidden", httpStatus: 403, sourceIp });
      sendJson(res, 403, { error: "invalid signature" });
      return null;
    }
    return { raw };
  }

  /** Read the capped body, or audit `too_large` + send 413 and return null on overflow. */
  async function readCappedOr413(
    name: string,
    entry: WebhookConfig,
    req: IncomingMessage,
    res: ServerResponse,
    sourceIp: string | undefined,
  ): Promise<string | null> {
    try {
      return await readBodyCapped(req, MAX_HOOK_BODY_BYTES);
    } catch {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "too_large", httpStatus: 413, sourceIp });
      sendJson(res, 413, { error: "payload too large" });
      return null;
    }
  }

  /** Parse the authenticated raw body to a JSON object, or audit `bad_request` + respond and return null. */
  function parseEventBody(
    name: string,
    entry: WebhookConfig,
    raw: string,
    res: ServerResponse,
    sourceIp: string | undefined,
  ): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "bad_request", httpStatus: 400, sourceIp });
      sendJson(res, 400, { error: "webhook body must be valid JSON" });
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "bad_request", httpStatus: 400, sourceIp });
      sendJson(res, 400, { error: "webhook body must be a JSON object" });
      return null;
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * `POST /api/webhooks/:name/test` — fire a configured hook's workflow with a
   * SYNTHETIC payload from the UI. This is an *authenticated browser action*
   * (already gated by the loopback Host check + `X-Work-Token` in `handle`), so
   * it deliberately bypasses the hook's signature/bearer auth — the operator is
   * exercising the wiring, not impersonating a remote sender. It still honors the
   * same fail-closed *configuration* requirements as the real receiver: the hook
   * must have a usable secret AND its workflow must declare `on: webhook` (else
   * 404), and a compile error is a 400. Records a `"test"` delivery and dispatches
   * async, mirroring `handleHook`'s 202/429 contract.
   */
  async function handleWebhookTest(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entry: WebhookConfig | undefined = opts.config?.webhooks?.[name];
    if (!entry) { sendJson(res, 404, { error: `no webhook named "${name}"` }); return; }
    // A test exercises the same configuration the real receiver requires: a
    // usable secret and an opted-in workflow. Misconfiguration ⇒ 404 (same as a
    // live delivery would get), so the UI surfaces "this hook isn't wired up".
    const secret = entry.secret ? expandEnv(entry.secret) : "";
    if (!secret) { sendJson(res, 404, { error: `webhook "${name}" is not configured` }); return; }

    const layout = await resolveLayout(entry.workflow);
    if (!layout) { sendJson(res, 404, { error: `webhook "${name}" is not configured` }); return; }
    let spec;
    try {
      spec = parseWorkflow(await readFile(layout.file, "utf-8"));
    } catch (err) {
      sendCompileError(res, err);
      return;
    }
    if (!spec.on?.webhook) { sendJson(res, 404, { error: `webhook "${name}" is not configured` }); return; }

    // The synthetic payload the UI's test sends — marked so a workflow can tell a
    // drill apart from a real delivery (`${{ event.test }}`).
    const SYNTHETIC: Record<string, unknown> = { test: true, source: "web-ui" };

    let plan;
    try {
      plan = compile(spec, { event: SYNTHETIC });
    } catch (err) {
      sendCompileError(res, err);
      return;
    }
    const sourceIp = req.socket.remoteAddress ?? undefined;
    const result = runManager.dispatch({
      name: entry.workflow,
      layout: layoutFields(layout),
      plan,
      trigger: "webhook",
      ...(entry.datasources ? { datasources: entry.datasources } : {}),
    });
    if (!result.accepted) {
      recordDelivery({ hook: name, workflow: entry.workflow, result: "at_capacity", httpStatus: 429, sourceIp });
      sendJson(res, 429, { error: "server at run capacity — retry shortly" });
      return;
    }
    recordDelivery({ hook: name, workflow: entry.workflow, result: "test", httpStatus: 202, runId: result.record.id, sourceIp });
    sendJson(res, 202, { runId: result.record.id, eventsUrl: `/api/runs/${result.record.id}/events` });
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    async close(): Promise<void> {
      // End every live SSE response first, else `server.close()` hangs on the
      // long-lived sockets.
      for (const beat of heartbeats) clearInterval(beat);
      for (const res of sseResponses) res.end();
      sseResponses.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      // Drain in-flight background runs before touching the engine: each run's
      // worker is closed inside its run, so once they settle no worker is left
      // polling. Closing the engine under a live worker orphans it against an
      // ended pool ("Cannot use a pool after calling end on the pool").
      await runManager.whenIdle();
      if (ownsEngine) await engine.close();
    },
  };
}

/** The dispatch `layout` fields, dropping undefined ones (one spot, four call sites). */
function layoutFields(layout: { workspaceSource?: string; workflowDir?: string }): { workspaceSource?: string; workflowDir?: string } {
  return {
    ...(layout.workspaceSource !== undefined ? { workspaceSource: layout.workspaceSource } : {}),
    ...(layout.workflowDir !== undefined ? { workflowDir: layout.workflowDir } : {}),
  };
}

/** Bind, falling forward on EADDRINUSE (mirrors the engine's bind-with-retry). */
function listen(server: ReturnType<typeof createServer>, startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let attempts = 0;
    const tryListen = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempts < PORT_RETRIES) {
          attempts++;
          port++;
          setImmediate(tryListen);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        // Read the actually-bound port (matters for `port: 0` ephemeral binds).
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    };
    tryListen();
  });
}

/** Read a request body to a string (small JSON bodies only). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Read a body but **abort once it exceeds `max` bytes** — we never buffer an
 * oversized/JSON-bomb webhook payload (webhook §4 L2). Rejects on overflow.
 */
function readBodyCapped(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Generic, non-disclosing 404 for any fail-closed webhook rejection. */
function notFoundHook(res: ServerResponse): void {
  sendJson(res, 404, { error: "not found" });
}

/** Extract a presented credential: `Authorization: Bearer <t>`, else a raw token in `header`. */
function bearerToken(req: IncomingMessage, header: string | undefined): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!;
  }
  if (header) {
    const v = req.headers[header.toLowerCase()];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Constant-time string compare (length-guarded — `timingSafeEqual` throws on length mismatch). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify an HMAC-SHA256 signature over the raw body, constant-time. Handles both
 * GitHub-style `sha256=<hex>` (scheme-prefixed) and Grafana-style bare `<hex>`.
 * The algorithm is PINNED to sha256 — we never trust a header-supplied alg. The
 * length guard before `timingSafeEqual` is required (it throws on mismatch) and
 * leaks nothing (the digest length is public). Stripe/Slack's timestamped
 * `{t}.{body}` schemes are out of scope here (they sign a different string).
 */
function verifyHmacSha256(secret: string, body: string, header: string): boolean {
  const eq = header.indexOf("=");
  const hex = (eq >= 0 ? header.slice(eq + 1) : header).trim();
  const got = Buffer.from(hex, "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/** Write a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

/** Map a compile/parse error to a 400 with the human-readable message inline. */
function sendCompileError(res: ServerResponse, err: unknown): void {
  if (err instanceof WorkflowCompileError || err instanceof WorkflowParseError) {
    sendJson(res, 400, { error: err.message });
    return;
  }
  throw err;
}
