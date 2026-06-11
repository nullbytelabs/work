/**
 * Boots the durable-execution backend: an in-process PGLite (WASM Postgres)
 * with the Absurd schema applied, exposed over the Postgres wire protocol so the
 * `absurd-sdk` (a node-postgres client) can talk to it.
 *
 * Verified recipe (see docs/pglite-wasm-postgres-database.md):
 *  - register PGLite's `uuid_ossp` contrib BEFORE applying the schema (the
 *    vendored schema.sql opens with `create extension "uuid-ossp"`);
 *  - `pool.max: 1` is mandatory — PGLite is single-connection.
 */
import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { Absurd } from "absurd-sdk";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

/** Pinned Absurd schema version vendored at ./schema.sql. */
export const ABSURD_SCHEMA_VERSION = "0.4.0";

/** The queue the per-job tasks run on — separate from the orchestrator's queue so
 *  an orchestrator awaiting its jobs can never starve them of worker slots (a
 *  same-queue await would deadlock). See docs/durable-orchestrator.md. */
export const JOBS_QUEUE = "jobs";

export interface AbsurdEngine {
  /** The Absurd client for the orchestrator queue, bound to the PGLite pool. */
  readonly app: Absurd;
  /** A second client bound to the `jobs` queue (shares the same pool) — job tasks
   *  run here so the orchestrator (on `app`'s queue) can await them deadlock-free. */
  readonly jobsApp: Absurd;
  /**
   * Run a SQL query against the underlying PGLite. The durable core uses Absurd's
   * own tables for execution state; this seam is for engine-*adjacent* records the
   * app owns (e.g. the `work.runs` history table). Shares the same single
   * connection — fine because writes here are tiny and infrequent, and the runtime
   * already interleaves polling queries on this pool during every run.
   */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Tear down the worker, pool, socket server, and database. */
  close(): Promise<void>;
}

/** Minimal logger shape accepted by the Absurd client. */
export interface AbsurdLog {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface AbsurdEngineOptions {
  /** PGLite data directory for persistence; omit for ephemeral in-memory. */
  dataDir?: string;
  /** Queue name (default "default"). */
  queueName?: string;
  /** Logger for the Absurd client (defaults to console). Pass a silent logger to mute expected failures (e.g. retry tests). */
  log?: AbsurdLog;
}

const SILENT_LOG: AbsurdLog = { log() {}, info() {}, warn() {}, error() {} };
export { SILENT_LOG };

/** Start the wire-protocol socket server, retrying on port contention. */
async function startSocketServer(db: PGlite): Promise<{ server: PGLiteSocketServer; port: number }> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = 49152 + Math.floor(Math.random() * 16000);
    const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port, maxConnections: 1 });
    try {
      await server.start();
      return { server, port };
    } catch {
      // Likely port in use; try another.
    }
  }
  throw new Error("could not bind a local port for the PGLite socket server");
}

/** Boot PGLite + apply the Absurd schema + expose it to an Absurd client. */
export async function createAbsurdEngine(opts: AbsurdEngineOptions = {}): Promise<AbsurdEngine> {
  const queueName = opts.queueName ?? "default";

  const db = await PGlite.create({
    extensions: { uuid_ossp },
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });

  // Apply the schema only if it isn't already present (a reused dataDir keeps it).
  const probe = await db.query<{ f: string | null }>("select to_regproc('absurd.get_schema_version') as f");
  if (!probe.rows[0] || probe.rows[0].f === null) {
    await db.exec(await readFile(SCHEMA_PATH, "utf8"));
  }

  const { server, port } = await startSocketServer(db);

  // PGLite is single-connection — max:1 is required.
  const pool = new pg.Pool({ host: "127.0.0.1", port, database: "postgres", user: "postgres", max: 1 });

  const app = new Absurd({ db: pool, queueName, ...(opts.log ? { log: opts.log } : {}) });
  // A second client bound to the jobs queue — same pool (PGLite is single-conn, so
  // they serialize on it). Job tasks run here; the orchestrator (on `app`) awaits
  // them across the queue boundary, which Absurd requires to avoid slot deadlock.
  const jobsApp = new Absurd({ db: pool, queueName: JOBS_QUEUE, ...(opts.log ? { log: opts.log } : {}) });
  for (const [client, q] of [[app, queueName], [jobsApp, JOBS_QUEUE]] as const) {
    try {
      await client.createQueue(q);
    } catch {
      // Queue may already exist (reused dataDir) — fine.
    }
  }

  return {
    app,
    jobsApp,
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
      const r = await pool.query(text, params as unknown[] | undefined);
      return r.rows as T[];
    },
    async close() {
      // Stop both clients' workers; the pool is passed-in (not owned by either
      // client), so we end it once here after both have stopped polling it.
      await app.close().catch(() => {});
      await jobsApp.close().catch(() => {});
      await pool.end().catch(() => {});
      await server.stop().catch(() => {});
      await db.close().catch(() => {});
    },
  };
}
