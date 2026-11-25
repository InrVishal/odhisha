import "server-only";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { IsolationError, judgeDatabase, neonEndpointId, PRODUCTION_ENDPOINT_MARKER, type Verdict } from "@/lib/isolation";
import { raiseOpsAlert } from "@/lib/ops-alert";
import { createDb, migrateDb, type Db, type DbHandle } from "./client";
import { deploymentMarker } from "./schema";

export type { Db } from "./client";
export * as schema from "./schema";

// One connection pool per server instance. Stored on globalThis so `next dev`
// hot reloads don't open a new pool (or a second PGlite lock) on every edit.
const g = globalThis as unknown as { __nightshiftDb?: Promise<DbHandle>; __nightshiftReadonlyDb?: Promise<DbHandle> };

let dbVerdict: Verdict = { ok: true, owner: null };

/** This instance's database isolation verdict (lib/isolation.ts), for /api/health. */
export function databaseIsolation(): Verdict {
  return dbVerdict;
}

/**
 * Preview and production never share a database: a preview connected to
 * production's refuses to open it; production connected to anything but its
 * own keeps serving, alerts, and fails its health check.
 */
async function checkIsolation(handle: DbHandle): Promise<void> {
  const env = getEnv();
  if (env.APP_ENV !== "preview" && env.APP_ENV !== "production") return;
  const own = neonEndpointId(env.DATABASE_URL);
  if (!own) return;
  let marker: string | null = null;
  try {
    const [row] = await handle.db.select({ value: deploymentMarker.value }).from(deploymentMarker).where(eq(deploymentMarker.name, PRODUCTION_ENDPOINT_MARKER)).limit(1);
    marker = row?.value ?? null;
  } catch {
    // No marker table yet (a branch from before migration 0010): nothing to compare.
  }
  dbVerdict = judgeDatabase(env.APP_ENV, own, marker);
  if (dbVerdict.ok) return;
  console.error(`[isolation] ${dbVerdict.reason}`);
  if (env.APP_ENV === "preview") throw new IsolationError(dbVerdict.reason);
  raiseOpsAlert("isolation_database", { env: env.APP_ENV });
}

async function open(): Promise<DbHandle> {
  const handle = await createDb(getEnv().DATABASE_URL);
  await checkIsolation(handle);
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
