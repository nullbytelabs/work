---
name: pglite
description: PGlite (Postgres-in-WASM) concepts, API, and constraints — single-connection model, filesystems/persistence, extensions, the pglite-socket wire-protocol bridge, and this repo's engine recipe (uuid_ossp before schema, pool.max 1, socket server). Use when touching the durable engine's database layer, persistence, or debugging PGlite/pg connection issues.
---

# PGlite (WASM Postgres)

PGlite is **real PostgreSQL compiled to WebAssembly**, running in-process in
Node — no server, no postmaster. This repo pins `@electric-sql/pglite@^0.5.1`,
which is **PostgreSQL 18.3** (verified via `select version()`; the 0.4.x line
was PG 17.5). It is genuine Postgres — PL/pgSQL, transactions, `SKIP LOCKED`,
advisory locks, LISTEN/NOTIFY all work — with one structural difference that
drives every limitation:

**WASM can't fork.** Postgres normally forks one backend per connection;
PGlite runs Postgres's single-user mode. So: **one process, one backend, one
connection.**

Docs: https://pglite.dev/docs/ — `/docs/api`, `/docs/filesystems`,
`/docs/pglite-socket`.

## The constraint set (memorize these)

1. **Single exclusive connection.** Any `pg.Pool` pointed at PGlite must use
   `max: 1`. v0.5's socket multiplexing layers connections over the *one*
   backend — it is not parallelism.
2. **Process-global singleton.** Never two PGlite instances on the same
   `dataDir`, and never two processes sharing one — there is **no error**,
   just silent last-writer-wins corruption.
3. **No background workers.** `max_worker_processes = 0`: no `pg_cron`, no
   `pg_partman` maintenance, no autovacuum-style scheduled jobs. Anything
   periodic must be driven by a JS timer in the host app.
4. **LISTEN/NOTIFY is in-process only** (`db.listen(channel, cb)`) — it cannot
   wake another process.
5. **No runtime C-extension loading.** Only extensions pre-compiled into the
   WASM bundle (~40 contrib ones) or pure SQL/PLpgSQL scripts applied via
   `db.exec()`. `plpgsql` is built in.
6. **Datadirs are not portable across Postgres majors.** The 0.4→0.5 bump
   moved PG 17.5→18.3; an old on-disk datadir won't open under the new major.
   (Fix for a corrupted/incompatible dev db: delete `.workflows/db`.)

## Core API

```ts
import { PGlite } from "@electric-sql/pglite";

const db = await PGlite.create();              // memory:// (ephemeral) — preferred over `new`
const db2 = await PGlite.create({ dataDir: "./datadir" });  // Node FS, persists on disk

// .query — ONE statement, parameterized ($1…); returns { rows, affectedRows, fields }
const r = await db.query("select * from t where id = $1", [1]);

// .exec — MANY statements, NO params; ideal for DDL/schema/migrations
await db.exec(`create table t (...); insert into t ...;`);

// tagged template → bound params
await db.sql`select * from t where name = ${name}`;

// transaction: commits on resolve, rolls back on throw
await db.transaction(async (tx) => { await tx.query(...); });

await db.listen("chan", (payload) => {...});   // in-process pub/sub
const dump = await db.dumpDataDir("gzip");     // tarball out (PGlite-only format)
await db.close();                              // graceful shutdown
```

Extensions load at create time:

```ts
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
const db = await PGlite.create({ extensions: { uuid_ossp } });
// then: create extension "uuid-ossp";  works in SQL
```

Other create options worth knowing: `loadDataDir` (boot from a dumped
tarball), `relaxedDurability` (defer flushes), `initialMemory`,
`postgresqlconf`/`startParams`.

## pglite-socket: serving the wire protocol

`@electric-sql/pglite-socket` (pinned `^0.2.1`) exposes a PGlite instance over
the Postgres wire protocol so ordinary clients (node-postgres — and therefore
`absurd-sdk`) can talk to it:

```ts
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port, maxConnections: 1 });
await server.start();
// connect with pg: { host, port, database: "postgres", user: "postgres", max: 1 }
await server.stop();
```

No SSL support (`PGSSLMODE=disable` for psql). Keep `maxConnections: 1` —
multiplexed concurrent connections are explicitly "not all use cases
guaranteed."

## How this repo uses PGlite

The whole durable engine runs on PGlite — it *is* the Postgres behind Absurd.
One file owns it: **`src/runtime/absurd/engine.ts`** (everything else,
including `src/persistence/`, goes through its `query` seam or the Absurd
clients). The verified recipe, in order:

1. `PGlite.create({ extensions: { uuid_ossp }, dataDir? })` — **registering
   `uuid_ossp` BEFORE applying the schema is mandatory**: the vendored
   `schema.sql` opens with `create extension if not exists "uuid-ossp"` and
   fails without it. (PG 18 has native `uuidv7()` now, but the schema still
   declares the extension.) `dataDir` omitted → ephemeral in-memory (tests);
   the CLI passes `<workspace>/.workflows/db` for persistent history.
2. **Idempotent schema apply**: probe
   `select to_regproc('absurd.get_schema_version')` — only `db.exec(schema)`
   if absent (a reused dataDir already has it). The schema is a pinned,
   vendored release artifact (`ABSURD_SCHEMA_VERSION` must match the
   `absurd-sdk` version); never fetched at runtime.
3. **Socket server on a random loopback port** (49152–65151, retry on
   collision), `maxConnections: 1`.
4. **`pg.Pool` with `max: 1`** — non-negotiable (constraint #1).
5. Two `Absurd` clients share that one pool (orchestrator queue + `jobs`
   queue); they serialize on the single connection, which is correct here —
   real parallelism lives outside Postgres (concurrent Gondolin VMs), only
   coordination state is serialized.
6. **Close order matters**: Absurd clients → pool → socket server → `db.close()`.

Engine-adjacent tables (`work.runs`, `work.run_events`, deliveries) live in
`src/persistence/` and use the `query` seam — tiny, infrequent writes
interleaved on the same single connection.

Consequences inherited from the constraint set: unpartitioned Absurd queues
only, no `pg_cron` (cron-guarded maintenance installs but never runs), worker
concurrency effectively 1 at the DB layer. This is the **embedded/dev/CI/
single-host tier** by design; a multi-runner production topology would swap in
a real Postgres server, not a second PGlite.

Full verified research (what works/breaks, deployment tiers, the original
spike): `docs/pglite-wasm-postgres-database.md`.
