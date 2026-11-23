import type { SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * One Drizzle type for every driver. All queries go through Drizzle's query
 * builder, which always sends parameterized SQL. No raw SQL string building
 * anywhere in the app (Semgrep rule `no-raw-sql-concat` enforces this).
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  driver: "neon" | "pg" | "pglite";
  close: () => Promise<void>;
}

function isNeonHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

/**
 * - `pglite:<dir>` or `pglite:memory` → in-process Postgres (dev and tests only;
 *   env validation refuses it in preview/production).
 * - `*.neon.tech` → Neon serverless driver over WebSockets (supports
 *   transactions, which the ledger and leasing code need).
 * - anything else → node-postgres (CI uses a Postgres service container).
 */
export async function createDb(url: string): Promise<DbHandle> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const target = url.slice("pglite:".length);
    const client = target === "memory" || target === "" ? new PGlite() : new PGlite(target);
    await client.waitReady;
    return { db: drizzle(client, { schema }) as unknown as Db, driver: "pglite", close: () => client.close() };
  }

  if (isNeonHost(url)) {
    const { Pool, neonConfig } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    if (typeof WebSocket !== "undefined") neonConfig.webSocketConstructor = WebSocket;
    // Secure WebSockets only: TLS with the certificate checked by Node, never unencrypted.
    neonConfig.useSecureWebSocket = true;
    const pool = new Pool({ connectionString: url });
    return { db: drizzle(pool, { schema }) as unknown as Db, driver: "neon", close: () => pool.end() };
  }

  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  // sslmode=verify-full: the server's certificate and host name are checked.
  const verifyFull = new URL(url).searchParams.get("sslmode") === "verify-full";
  const pool = new Pool({ connectionString: url, max: 10, ...(verifyFull ? { ssl: { rejectUnauthorized: true } } : {}) });
  return { db: drizzle(pool, { schema }) as unknown as Db, driver: "pg", close: () => pool.end() };
}

/** Applies every migration in ./drizzle using the driver-matched migrator. */
export async function migrateDb(handle: DbHandle, migrationsFolder = "./drizzle"): Promise<void> {
  const config = { migrationsFolder };
  switch (handle.driver) {
    case "pglite": {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(handle.db as never, config);
      return;
    }
    case "neon": {
      const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
      await migrate(handle.db as never, config);
      return;
    }
    case "pg": {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(handle.db as never, config);
      return;
    }
  }
}

/**
 * Typed rows from `db.execute(sql\`...\`)`. Every supported driver returns
 * `{ rows }`. Use only with the `sql` template tag, which parameterizes values.
 */
export async function rows<T>(db: Db, query: SQL): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}
