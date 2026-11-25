import { randomBytes } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createDb, migrateDb, type Db, type DbHandle } from "@/lib/db/client";

const MIGRATIONS = path.resolve(__dirname, "../../drizzle");

/** The database role the web app connects as (migration 0008). */
export const RUNTIME_ROLE = "app_runtime";

export interface TestDb extends DbHandle {
  /**
   * Runs `fn` with the owner role (the one migrations run as). Only for setup
   * the app itself can never do, such as making someone an admin, and for
   * tests about the owner role.
   */
  asOwner: <T>(fn: (owner: Db) => Promise<T>) => Promise<T>;
  /** Runs `fn` as another database role (e.g. "readonly"), then switches back. */
  asRole: <T>(role: "readonly" | "app_runtime", fn: (db: Db) => Promise<T>) => Promise<T>;
  cleanup: () => Promise<void>;
}

/**
 * A fresh, fully migrated database for one test file.
 *
 * Every test runs as `app_runtime`, the least-privilege role the app uses
 * when deployed. So a query the app needs and that role can't do fails here,
 * before it can fail in production.
 *
 * - TEST_DATABASE_URL set (CI: Postgres service container) → creates a new
 *   throwaway database on that server and drops it afterwards.
 * - otherwise → in-memory PGlite (real Postgres compiled to WASM).
 */
export async function freshDb(opts: { role?: "app_runtime" | "owner" } = {}): Promise<TestDb> {
  const role = opts.role ?? RUNTIME_ROLE;
  const serverUrl = process.env.TEST_DATABASE_URL;

  if (!serverUrl) {
    const handle = await createDb("pglite:memory");
    await migrateDb(handle, MIGRATIONS);
    // One connection: switching roles is a SET ROLE on it.
    const become = async () => {
      if (role === RUNTIME_ROLE) await handle.db.execute(sql`set role app_runtime`);
      else await handle.db.execute(sql`reset role`);
    };
    await become();
    const switchTo = async <T>(target: "owner" | "readonly" | "app_runtime", fn: (db: Db) => Promise<T>): Promise<T> => {
      if (target === "owner") await handle.db.execute(sql`reset role`);
      else if (target === "readonly") await handle.db.execute(sql`set role readonly`);
      else await handle.db.execute(sql`set role app_runtime`);
      try {
        return await fn(handle.db);
      } finally {
        await become();
      }
    };
    return {
      ...handle,
      asOwner: (fn) => switchTo("owner", fn),
      asRole: (r, fn) => switchTo(r, fn),
      cleanup: handle.close,
    };
  }

  const name = `ns_test_${randomBytes(6).toString("hex")}`;
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  // Identifier is generated above from hex only, so it is safe to inline.
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  // Small pools that let idle connections go: some files make a database per test.
  const POOL = { max: 4, idleTimeoutMillis: 500 };
  const owner = await createDb(url.toString(), POOL);
  await migrateDb(owner, MIGRATIONS);
  const withRole = (r: string) => {
    const u = new URL(url);
    // Every connection in the pool starts as this role (like SET ROLE).
    u.searchParams.set("options", `-c role=${r}`);
    return u.toString();
  };
  const handle = role === RUNTIME_ROLE ? await createDb(withRole(RUNTIME_ROLE), POOL) : owner;
  const extra = new Map<string, DbHandle>();
  const roleDb = async (r: string) => {
    let h = extra.get(r);
    if (!h) {
      h = await createDb(withRole(r), POOL);
      extra.set(r, h);
    }
    return h.db;
  };

  return {
    ...handle,
    asOwner: (fn) => fn(owner.db),
    asRole: async (r, fn) => fn(await roleDb(r)),
    cleanup: async () => {
      for (const h of extra.values()) await h.close();
      if (handle !== owner) await handle.close();
      await owner.close();
      const a = new Client({ connectionString: serverUrl });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
