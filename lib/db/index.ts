import "server-only";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { createDb, migrateDb, type Db, type DbHandle } from "./client";

export type { Db } from "./client";
export * as schema from "./schema";

// One connection pool per server instance. Stored on globalThis so `next dev`
// hot reloads don't open a new pool (or a second PGlite lock) on every edit.
const g = globalThis as unknown as { __nightshiftDb?: Promise<DbHandle>; __nightshiftReadonlyDb?: Promise<DbHandle> };

async function open(): Promise<DbHandle> {
  const handle = await createDb(getEnv().DATABASE_URL);
  // Local/test PGlite databases migrate themselves, so `npm run dev` and the
  // E2E server work from an empty directory or in memory. Neon and Postgres
  // are only ever migrated by the explicit deploy step (scripts/migrate.ts).
  if (handle.driver === "pglite") {
    await migrateDb(handle, path.join(process.cwd(), "drizzle"));
    // Then run as the same least-privilege role the deployed app uses.
    await handle.db.execute(sql`set role app_runtime`);
  }
  return handle;
}

export async function getDb(): Promise<Db> {
  g.__nightshiftDb ??= open().catch((e: unknown) => {
    g.__nightshiftDb = undefined;
    throw e;
  });
  return (await g.__nightshiftDb).db;
}

/**
 * The admin reports read through the "readonly" database role when
 * DATABASE_URL_READONLY is set (it can only SELECT a few tables: no emails,
 * sessions, tokens or job data). Otherwise the main connection.
 */
export async function getReadonlyDb(): Promise<Db> {
  const url = getEnv().DATABASE_URL_READONLY;
  if (!url) return getDb();
  g.__nightshiftReadonlyDb ??= createDb(url).catch((e: unknown) => {
    g.__nightshiftReadonlyDb = undefined;
    throw e;
  });
  return (await g.__nightshiftReadonlyDb).db;
}
