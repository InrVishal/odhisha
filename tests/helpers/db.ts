import { randomBytes } from "node:crypto";
import path from "node:path";
import { createDb, migrateDb, type DbHandle } from "@/lib/db/client";

const MIGRATIONS = path.resolve(__dirname, "../../drizzle");

/**
 * A fresh, fully migrated database for one test file.
 *
 * - TEST_DATABASE_URL set (CI: Postgres service container) → creates a new
 *   throwaway database on that server and drops it afterwards.
 * - otherwise → in-memory PGlite (real Postgres compiled to WASM).
 */
export async function freshDb(): Promise<DbHandle & { cleanup: () => Promise<void> }> {
  const serverUrl = process.env.TEST_DATABASE_URL;

  if (!serverUrl) {
    const handle = await createDb("pglite:memory");
    await migrateDb(handle, MIGRATIONS);
    return { ...handle, cleanup: handle.close };
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
  const handle = await createDb(url.toString());
  await migrateDb(handle, MIGRATIONS);

  return {
    ...handle,
    cleanup: async () => {
      await handle.close();
      const a = new Client({ connectionString: serverUrl });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
