import pg from "pg";
import { config, log, sleep } from "@orch/common";
import type { StreamNotice } from "@orch/contracts";
import { MIGRATIONS } from "./migrations.js";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

const NOTIFY_CHANNEL = "orch";

export function createPool(connectionString = config.databaseUrl()): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on("error", (err) => log("store", `idle client error: ${err.message}`));
  return pool;
}

/** Waits for the database to accept connections (containers start in any order). */
export async function waitForDb(db: Db, attempts = 60): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.query("select 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(1000);
    }
  }
}

/** Applies pending migrations under an advisory lock, so concurrent services are safe. */
export async function migrate(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("select pg_advisory_lock(4242)");
    await client.query(
      "create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())",
    );
    const { rows } = await client.query<{ version: number }>("select version from schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into schema_migrations (version) values ($1)", [m.version]);
        await client.query("commit");
        log("store", `applied migration ${m.version}`);
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(4242)").catch(() => undefined);
    client.release();
  }
}

export async function connectStore(): Promise<Db> {
  const db = createPool();
  await waitForDb(db);
  await migrate(db);
  return db;
}

export async function notify(q: Queryable, notice: StreamNotice): Promise<void> {
  await q.query("select pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify(notice)]);
}

export async function withTx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Subscribes to stream notices with a dedicated connection; reconnects on failure. Returns a stop function. */
export function listen(onNotice: (n: StreamNotice) => void, connectionString = config.databaseUrl()): () => void {
  let stopped = false;
  let client: pg.Client | undefined;
  const run = async () => {
    while (!stopped) {
      try {
        client = new pg.Client({ connectionString });
        await client.connect();
        client.on("notification", (msg) => {
          if (!msg.payload) return;
          try {
            onNotice(JSON.parse(msg.payload) as StreamNotice);
          } catch {
            // ignore malformed payloads
          }
        });
        await client.query(`listen ${NOTIFY_CHANNEL}`);
        await new Promise<void>((resolve) => {
          client!.on("error", () => resolve());
          client!.on("end", () => resolve());
        });
      } catch (err) {
        log("store", `listen connection failed: ${(err as Error).message}`);
      }
      await client?.end().catch(() => undefined);
      if (!stopped) await sleep(1000);
    }
  };
  void run();
  return () => {
    stopped = true;
    void client?.end().catch(() => undefined);
  };
}
