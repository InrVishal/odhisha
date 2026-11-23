/**
 * C: nobody can query the database except through the app. Runs in CI on
 * the preview's Neon branch, which is a copy of production (same roles,
 * extensions and settings), right after its migrations:
 *
 *   PREVIEW_DATABASE_URL (owner, unpooled) RUNTIME_DATABASE_URL READONLY_DATABASE_URL npx tsx tests/live/db-exposure.ts
 *
 * Checks:
 * - no Neon Data API / PostgREST roles and no GraphQL extension (no REST or
 *   GraphQL door into the database);
 * - no extensions that reach out of the database (dblink, http, postgres_fdw);
 * - the server refuses connections without TLS, and our own connection is TLS;
 * - app_runtime and readonly have no special powers (superuser, create role
 *   or database, replication, bypass row security) and log in only with their
 *   own password;
 * - nobody but the owner can create objects in the public schema.
 * Prints role and extension names only, never URLs or passwords.
 */
import pg from "pg";

const OWNER = process.env.PREVIEW_DATABASE_URL ?? "";
const RUNTIME = process.env.RUNTIME_DATABASE_URL ?? "";
const READONLY = process.env.READONLY_DATABASE_URL ?? "";
const log = (m: string) => console.log(`[db] ${m}`);
let failed = 0;
function check(ok: boolean, what: string) {
  if (ok) log(`PASS: ${what}`);
  else {
    failed += 1;
    console.error(`[db] FAIL: ${what}`);
  }
}

async function connect(url: string, ssl: "require" | "disable" = "require") {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  u.searchParams.delete("channel_binding");
  const client = new pg.Client({ connectionString: u.toString(), ssl: ssl === "disable" ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 15_000 });
  await client.connect();
  return client;
}

async function main() {
  if (!OWNER || !RUNTIME || !READONLY) throw new Error("PREVIEW_DATABASE_URL, RUNTIME_DATABASE_URL and READONLY_DATABASE_URL are required");
  const db = await connect(OWNER);
  try {
    const apiRoles = await db.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname in ('authenticator', 'anonymous', 'authenticated', 'anon', 'service_role', 'web_anon', 'pgrst') order by 1",
    );
    check(apiRoles.rows.length === 0, `no Data API / PostgREST roles (found: ${JSON.stringify(apiRoles.rows.map((r) => r.rolname))})`);
    const ext = await db.query<{ extname: string }>("select extname from pg_extension order by 1");
    const names = ext.rows.map((r) => r.extname);
    log(`extensions: ${JSON.stringify(names)}`);
    for (const bad of ["pg_graphql", "dblink", "http", "pg_net", "postgres_fdw"]) check(!names.includes(bad), `extension ${bad} is not installed`);
    const schemas = await db.query<{ nspname: string }>("select nspname from pg_namespace where nspname in ('graphql', 'graphql_public', 'pgrst', 'neon_auth') order by 1");
    check(schemas.rows.length === 0, `no GraphQL / REST schemas (found: ${JSON.stringify(schemas.rows.map((r) => r.nspname))})`);

    // Neon's proxy ends TLS, so the database itself sees a plain connection from the
    // proxy (pg_stat_ssl says no). What matters is our side: the socket to Neon.
    const sock = (db as unknown as { connection: { stream: { encrypted?: boolean; authorized?: boolean; getProtocol?: () => string | null } } }).connection.stream;
    check(sock.encrypted === true && sock.authorized === true, `this connection is TLS (${sock.getProtocol?.() ?? "no TLS"}), with the server certificate verified`);

    const powers = await db.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      "select rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin from pg_roles where rolname in ('app_runtime', 'readonly') order by 1",
    );
    check(powers.rows.length === 2, "app_runtime and readonly exist");
    for (const r of powers.rows) {
      check(!r.rolsuper && !r.rolcreaterole && !r.rolcreatedb && !r.rolreplication && !r.rolbypassrls, `${r.rolname} has no special powers`);
    }
    const create = await db.query<{ ok: boolean }>("select has_schema_privilege('public', 'public', 'CREATE') as ok");
    check(create.rows[0]?.ok === false, "PUBLIC can't create objects in the public schema");
  } finally {
    await db.end();
  }

  // Without TLS the server says no.
  let plainRefused = false;
  try {
    const plain = await connect(RUNTIME, "disable");
    await plain.end();
  } catch {
    plainRefused = true;
  }
  check(plainRefused, "a connection without TLS is refused");

  // Each role logs in with its own password and is who it says.
  for (const [url, role] of [[RUNTIME, "app_runtime"], [READONLY, "readonly"]] as const) {
    const c = await connect(url);
    try {
      const me = await c.query<{ u: string }>("select current_user as u");
      check(me.rows[0]?.u === role, `${role} logs in as itself`);
      let ddl = "allowed";
      try {
        await c.query("create table exposure_probe (id int)");
        await c.query("drop table exposure_probe");
      } catch {
        ddl = "refused";
      }
      check(ddl === "refused", `${role} can't create tables`);
    } finally {
      await c.end();
    }
  }

  if (failed) {
    console.error(`[db] ${failed} check(s) failed`);
    process.exit(1);
  }
  log("all database exposure checks passed");
}

main().catch((e: unknown) => {
  console.error("[db] error:", e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, "<url>") : "unknown");
  process.exit(1);
});
