import "server-only";
import { getEnv } from "@/lib/env";
import { createDb, type Db, type DbHandle } from "./client";

export type { Db } from "./client";
export * as schema from "./schema";

// One connection pool per server instance. Stored on globalThis so `next dev`
// hot reloads don't open a new pool (or a second PGlite lock) on every edit.
const g = globalThis as unknown as { __nightshiftDb?: Promise<DbHandle> };

export async function getDb(): Promise<Db> {
  g.__nightshiftDb ??= createDb(getEnv().DATABASE_URL);
  return (await g.__nightshiftDb).db;
}
