# PGLite (WASM Postgres) — Reference & pi-workflows Provider Fit

> PGLite is Postgres compiled to WASM — a real PostgreSQL engine running in-process (browser/Node/Bun/Deno), no server. **Part A** is a verified general reference. **Part B** is its fit as the Postgres provider behind Absurd + PGMQ — which is the crux, because PGLite's single-process model collides with the competing-consumers pattern those layers assume. Items not confirmed from docs/source are flagged **UNVERIFIED**; items empirically tested against `@electric-sql/pglite@0.4.6` (Node/Linux) are marked **[VERIFIED-LOCALLY]**.

---

# Part A — PGLite general reference

## 1. What PGLite is

A WASM build of PostgreSQL packaged as a TypeScript library, running Postgres **in-process** with no separate server — ~3.x MB gzipped.

- **Package:** `@electric-sql/pglite`. **Maintainer:** ElectricSQL. **License:** dual Apache-2.0 / PostgreSQL License.
- **Postgres version:** based on **PostgreSQL 17.5** (`REL_17_5-pglite` fork branch). [VERIFIED-LOCALLY] `SELECT version()` → `PostgreSQL 17.5 on wasm32-unknown-linux-gnu ... 32-bit`. (0.2.x was PG16; PG17 landed in 0.3.0. PG18 not supported as of late 2025.)
- **Status:** alpha. Current version at research time ~0.4.6.
- **How it works (the root of every limitation):** standard Postgres forks one backend process per connection. Emscripten/WASM **cannot fork processes**, so PGLite runs Postgres's **single-user mode** (normally a bootstrap/recovery mode) with an added JS I/O pathway. It is genuine Postgres, *not* a Linux VM — but it is **one process, one backend, no postmaster**.

## 2. Install & instantiate

```bash
npm install @electric-sql/pglite     # also bun / deno add npm:@electric-sql/pglite
```

Ships **both ESM and CJS** (dual exports). Two constructors:

```ts
import { PGlite } from '@electric-sql/pglite'

const db1 = new PGlite()                  // sync ctor; methods await .waitReady
const db2 = await PGlite.create()         // PREFERRED: awaits init + attaches extension types
```

`dataDir` first arg uses a URI scheme to pick the storage backend (see §5): unprefixed/`file://` (Node disk), `idb://` (browser), `memory://` (default), `opfs-ahp://` (browser worker). Notable options: `relaxedDurability`, `loadDataDir` (prepopulated tarball), `extensions`, `initialMemory`, `pgliteWasmModule`/`initdbWasmModule`/`fsBundle` (for bundlers/edge), `postgresqlconf`/`startParams`.

## 3. Query API

```ts
// .query: single statement, parameterized ($1,$2), returns one Results
const r = await db.query('SELECT * FROM todo WHERE id = $1', [1])
// r.rows, r.affectedRows (rows CHANGED), r.fields, r.blob

// .exec: one or more statements, NO params, returns Results[]  (good for migrations)
await db.exec(`CREATE TABLE t (...); INSERT INTO t ...;`)

// tagged template -> bound params
await db.sql`SELECT * FROM todo WHERE id = ${1}`

// interactive transaction; commits on resolve, rolls back on throw
await db.transaction(async (tx) => {
  await tx.query('INSERT INTO todo (task) VALUES ($1);', ['x'])
  return tx.query('SELECT * FROM todo;')
})

await db.close()
```

Also: `describeQuery`, `clone()`, `copyToFS`, low-level `execProtocol*`, and `COPY ... '/dev/blob'` import/export via the `blob` option.

## 4. LISTEN/NOTIFY & live queries

- **LISTEN/NOTIFY is supported in-process** via first-class methods: `db.listen(channel, cb) → unsubscribe`, `db.unlisten`, `db.onNotification`. [VERIFIED-LOCALLY] delivers payloads. **Caveat:** only reaches listeners on the *same single instance* — it is an in-process signal, **not cross-process IPC**.
- **Live queries** (`live` plugin): `live.query`, `live.incrementalQuery`, `live.changes` — reactive results that re-emit when dependent tables change.

## 5. Persistence / filesystems

| FS | Selector | Where | Notes |
|---|---|---|---|
| In-memory | `new PGlite()` / `memory://` / `MemoryFS` | all platforms | ephemeral; persist only via dump/load |
| **Node FS** | `new PGlite('./datadir')` / `NodeFS` | Node, Bun, Deno | **persists to local disk**; reopening reloads |
| IndexedDB | `idb://name` / `IdbFs` | browser | recommended in browser; flushes after each query (`relaxedDurability` to defer) |
| OPFS AHP | `opfs-ahp://path` / `OpfsAhpFS` (in a Worker) | Chrome, Firefox | **Safari ✗** (252 sync-handle cap < ~300 PG files); needs a Worker |

> Only these four VFS backends are documented; a separate user-facing tmpfs/nodefs split is **UNVERIFIED**. No explicit DB size limit documented — effectively memory/quota-bound (**UNVERIFIED**).

### Prepopulated DB (ship a pre-seeded datadir)

```ts
// build/seed time
const seed = await PGlite.create()
await seed.exec(`CREATE TABLE users(...); INSERT INTO users ...;`)
const dump = await seed.dumpDataDir('gzip')      // -> Blob/File tarball (ship as asset)

// runtime
const db = await PGlite.create({ loadDataDir: dump })
```

Or `@electric-sql/pglite-prepopulatedfs` to skip `initdb` (~3.4× faster startup; archive must match PGLite version). The dumped datadir is **only re-importable into PGLite**, not other Postgres.

## 6. Bundlers & ORMs

- **Vite:** `optimizeDeps.exclude: ['@electric-sql/pglite']`; for the multi-tab worker also `worker.format: 'es'` and import via `?worker`. **Next.js:** add to `transpilePackages`. **esbuild:** doesn't grok `new URL(...,import.meta.url)` — provide `pgliteWasmModule`/`initdbWasmModule`/`fsBundle` manually (also the edge/restricted path). webpack/Rollup/Bun-bundler: **UNVERIFIED** (manual-module fallback is universal).
- **ORMs (official):** Drizzle (first-class `drizzle-orm/pglite` driver + drizzle-kit migrations), Prisma (local dev via `prisma dev`), Knex (`knex-pglite`), TypeORM (`typeorm-pglite`), Orange. Kysely not on the official list (**UNVERIFIED**).

```ts
import { drizzle } from 'drizzle-orm/pglite'
import { PGlite } from '@electric-sql/pglite'
const db = drizzle(new PGlite('./datadir'))
```

## 7. Concurrency model (the headline limitation)

- **Single user / single connection / single backend.** README: *"PGlite is single user/connection."* Docs: *"PGlite only has a single exclusive connection to the database."*
- **Worker + leader election** (multi-tab) lets many browser tabs share **one** instance: only the elected leader runs PGLite; others proxy to it. v0.4's **connection multiplexing** multiplexes client connections over the **single** backend — it is **not** parallel backends. "True multi-connection support" is on the roadmap, **not shipped as of v0.4 (Mar 2026)**.
- **No safe multi-process access to one dataDir.** [VERIFIED-LOCALLY] opening the same dataDir from two processes raised **no error** → silent last-writer-wins (a data-loss hazard, not safe sharing). Multiple in-memory instances in one process hit a global WASM lock / undefined behavior (issue #324). Treat PGLite as a **process-global singleton**.
- **No background workers.** [VERIFIED-LOCALLY] `SHOW max_worker_processes` → **0**; `SHOW shared_preload_libraries` → **""**.

## 8. Extensions

- Two kinds, both via the `extensions:` option: **Postgres WASM extensions** (must be pre-compiled into the bundle, then `CREATE EXTENSION`) and **PGLite JS plugins** (`live`).
- **`plpgsql` is statically linked and available by default** [VERIFIED-LOCALLY] — functions, procedures, `DO` blocks all work.
- ~40 bundled extensions (pgvector, contrib: pgcrypto, pg_trgm, hstore, ltree, citext, fuzzystrmatch, uuid_ossp, tablefunc, etc.); PostGIS is a separate experimental package.
- **No runtime C-extension loading** — no `LOAD` of arbitrary `.so`. Adding a C extension requires building it to WASM via the (non-trivial) extension-dev pipeline.

---

# Part B — PGLite as the pi-workflows Postgres provider

## The one-paragraph verdict

PGLite is a **faithful PostgreSQL 17.5 engine**: Absurd's PL/pgSQL stored procedures and PGMQ's SQL-only functions (`FOR UPDATE SKIP LOCKED`, advisory locks, `LISTEN/NOTIFY`) **install and execute correctly** [VERIFIED-LOCALLY for the primitives]. But Absurd and PGMQ are both architected around the one thing PGLite fundamentally lacks — **multiple concurrent backends/processes competing for work.** On PGLite the entire engine collapses to a **single in-process, single-threaded, polling consumer with no database-side background jobs.** That makes PGLite a *compelling* provider for **embedded / local-first / edge / CI-and-test / single-tenant demo** deployments, and a poor fit for the **multi-runner production topology** the PGMQ doc describes. Treat it as a **deployment tier**, not the default for scale.

## What works vs. what breaks

| Capability the engine wants | On PGLite |
|---|---|
| PL/pgSQL stored procedures (Absurd core) | ✅ works (plpgsql default) |
| Define/run functions, `DO` blocks, transactions | ✅ |
| `FOR UPDATE SKIP LOCKED` (PGMQ read) | ✅ runs — but nothing to skip past (one consumer) |
| Advisory locks | ✅ |
| `LISTEN/NOTIFY` | ⚠️ in-process only — cannot wake a worker in another process |
| Multiple worker processes / runner pool on one DB | ❌ single backend; unsafe shared dataDir |
| PGMQ **non-partitioned** SQL-only queues | ✅ viable (single consumer) |
| PGMQ **partitioned** queues | ❌ need `pg_partman` + background worker — absent |
| `pg_cron` / DB-side scheduled maintenance | ❌ `max_worker_processes=0` |
| `CREATE EXTENSION pgmq` | ❌ not bundled, no runtime install (see below) |

## How to actually run PGMQ on PGLite (the SQL-only path)

You **cannot** `CREATE EXTENSION pgmq` — pgmq isn't in PGLite's WASM bundle and there's no runtime C-extension loading. But pgmq's **SQL-only install is pure SQL + PL/pgSQL**, and plpgsql works. So you load pgmq's `pgmq.sql` script directly:

```ts
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

const db = await PGlite.create('./engine-data')          // disk-persisted
const pgmqSql = await readFile('pgmq-extension/sql/pgmq.sql', 'utf8')
await db.exec(pgmqSql)                                     // creates pgmq schema + functions
await db.exec(`SELECT pgmq.create('runner_local');`)       // then use it normally
```

Caveats: this is the **unversioned** SQL-only install (no `ALTER EXTENSION ... UPDATE` path), and **only the non-partitioned functions are usable** — anything routing through `pg_partman` (`create_partitioned`, the archive partition maintenance) will fail or have nothing to maintain. The same approach applies to Absurd's schema: run its PL/pgSQL DDL via `db.exec()`.

## The concurrency ceiling, concretely

The PGMQ doc's strongest use case was **runner-pool dispatch for `runs-on`**: a fleet of processes competing on `runner_gondolin` / `runner_local` via `SKIP LOCKED` + visibility-timeout leases. **On PGLite that pattern collapses** — there is exactly one backend, no safe second process on the dataDir, and `NOTIFY` can't cross processes. Consequences:

- One in-process consumer enqueues and drains its own queue. `SKIP LOCKED` runs correctly but yields no parallelism.
- **Scheduled maintenance** (visibility-timeout sweeps, archive cleanup, partition rolling) must be driven by the **host app's own timer loop**, not the database.
- Workers **poll** (in-process); they cannot be woken cross-process by `NOTIFY`.
- For real fan-out you still parallelize *work execution* outside Postgres (e.g. spawn Gondolin VMs concurrently from the single Node process), but **the queue/state coordination is serialized through the one PGLite instance.**

## Where PGLite is the right provider — deployment tiers

Think of the Postgres provider as a tier the engine selects, mirroring the `runs-on` spirit:

| Tier | Provider | Concurrency | Use |
|---|---|---|---|
| **Embedded / dev / CI** | **PGLite** (`memory://` or local disk) | single in-process consumer | local development, fast hermetic tests (one fresh DB per test via prepopulated FS), demos, single-tenant/edge/local-first installs, "laptop mode" |
| **Production** | server Postgres (or Supabase/RDS/Neon) | many runner processes, real `pgmq` + `pg_partman` | multi-runner `runs-on` pools, partitioned high-volume fan-out, DB-side scheduling |

PGLite's specific wins for the embedded tier: zero-setup (no server to run), **in-memory mode** for ephemeral CI runs, **disk mode** (`NodeFS`) for a persistent single-node install, **prepopulated FS** to ship the engine's schema (Absurd + pgmq SQL pre-seeded) so a fresh instance skips `initdb` and migrations, and a clean Drizzle integration for the engine's own tables. A workflow author running `runs-on: local` on a laptop pairs naturally with a PGLite-on-disk backend — the whole engine + one worker in a single Node process.

## Integration gotchas specific to PGLite

- **Singleton discipline:** create exactly one PGLite instance per process and never point two processes at the same dataDir. If the engine ever forks workers, they must **not** share a dataDir — give each its own, or use a real server.
- **Durability:** prefer `NodeFS` (disk) for anything you care about; `memory://` loses everything on exit unless you `dumpDataDir`. Consider `relaxedDurability` only where flush-latency matters and loss-on-crash is acceptable.
- **Schema bootstrap:** load Absurd's PL/pgSQL DDL and pgmq's `pgmq.sql` via `db.exec()` at startup, or ship them via a prepopulated datadir for instant boot.
- **No DB scheduler:** implement visibility-timeout reaping / archive trimming in the host loop.
- **Version pinning:** PGLite is alpha and tracks a specific PG patch (17.5 now); pin the package and re-verify the pgmq SQL-only script loads cleanly on upgrades. Datadirs are not cross-major-version compatible.

## Bottom line

Use PGLite as the **embedded/dev/test/single-tenant tier** of the engine — it runs the exact same Absurd PL/pgSQL and (non-partitioned, SQL-only) PGMQ code as production, which makes it an excellent local mirror and test substrate. Do **not** use it where the design depends on competing consumers, partitioned queues, or DB-side background work; those require a real Postgres server. The engine should treat "Postgres provider" as configurable, exactly as it treats `runs-on`.

---

## Sources
- Docs / getting started: https://pglite.dev/docs/
- Filesystems: https://pglite.dev/docs/filesystems
- Prepopulated FS: https://pglite.dev/docs/prepopulatedfs
- Bundler support: https://pglite.dev/docs/bundler-support
- ORM support: https://pglite.dev/docs/orm-support
- Extensions catalog / development: https://pglite.dev/extensions/ , https://pglite.dev/extensions/development
- Multi-tab worker: https://pglite.dev/docs/multi-tab-worker
- v0.4 announcement (single-user mode, multiplexing, multi-instance "coming next"): https://electric.ax/blog/2026/03/25/announcing-pglite-v04
- Repo / Postgres fork: https://github.com/electric-sql/pglite , https://github.com/electric-sql/postgres-pglite
- Concurrency issue (global lock / undefined behavior): https://github.com/electric-sql/pglite/issues/324
- plpgsql availability: https://github.com/electric-sql/pglite/issues/36
- Engine context: [`absurd-durable-workflows.md`](absurd-durable-workflows.md), [`pgmq-message-queues.md`](pgmq-message-queues.md), [`gondolin-secure-execution.md`](gondolin-secure-execution.md), [`../README.md`](../README.md)

**UNVERIFIED:** exact current patch version over time; full unsupported-feature list; DB size limits; webpack/Rollup/Bun-bundler specifics; Kysely support; any first-hand report of PGMQ/pg-boss/graphile-worker running on PGLite (none found).
