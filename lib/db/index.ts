import "server-only";
import path from "node:path";
import { getEnv } from "@/lib/env";
import { createDb, migrateDb, type Db, type DbHandle } from "./client";

export type { Db } from "./client";
export * as schema from "./schema";

// One connection pool per server instance. Stored on globalThis so `next dev`
// hot reloads don't open a new pool (or a second PGlite lock) on every edit.
const g = globalThis as unknown as { __nightshiftDb?: Promise<DbHandle> };

async function open(): Promise<DbHandle> {
  const handle = await createDb(getEnv().DATABASE_URL);
  // Local/test PGlite databases migrate themselves, so `npm run dev` and the
  // E2E server work from an empty directory or in memory. Neon and Postgres
  // are only ever migrated by the explicit deploy step (scripts/migrate.ts).
  if (handle.driver === "pglite") await migrateDb(handle, path.join(process.cwd(), "drizzle"));
  return handle;
}

export async function getDb(): Promise<Db> {
  g.__nightshiftDb ??= open().catch((e: unknown) => {
    g.__nightshiftDb = undefined;
    throw e;
  });
  return (await g.__nightshiftDb).db;
}
