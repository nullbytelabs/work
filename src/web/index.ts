/**
 * The local web UI (`work --web`) — a `node:http` server that wraps the engine's
 * existing capabilities (discovery, the inputs schema, the DAG emitter, the run
 * hooks) in HTTP + SSE, with a self-contained inline frontend. Zero new
 * dependencies, loopback-only, session-scoped in-memory history (Phase 0; see
 * docs/web-ui-research.md §11).
 */
export { startWebServer, type StartWebServerOptions, type WebServerHandle } from "./server.ts";
export { RunManager, type RunRecord, type RunStatus, type DispatchOptions, type RunManagerOptions } from "./run-manager.ts";
export { WebPresenter, type Frame } from "./web-presenter.ts";
