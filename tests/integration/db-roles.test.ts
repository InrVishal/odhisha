import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAudit, adminJobs, adminLedger, adminNodes, adminTotals } from "@/lib/admin";
import { recentFlags } from "@/lib/coordinator/sybil";
import { rows } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { freshDb, type TestDb } from "../helpers/db";

/**
 * C: the three database roles. app_runtime (the web app) gets only what the
 * app needs; readonly gets admin reporting only; the owner role runs
 * migrations. The whole integration suite runs as app_runtime, which proves
 * these grants are enough; this file proves they're no more than that.
 *
 * Adding a table without deciding its grants here fails this test.
 */

type Upd = "all" | readonly string[] | false;
interface Expect {
  select: boolean;
  insert: boolean;
  update: Upd;
  delete: boolean;
}
const R = (select: boolean, insert: boolean, update: Upd, del: boolean): Expect => ({ select, insert, update, delete: del });

const RUNTIME: Record<string, Expect> = {
  user: R(true, true, ["name", "email", "emailVerified", "image", "upi_hash", "upi_masked", "deleted_at"], false),
  account: R(true, true, false, true),
  session: R(true, true, ["expires", "mfa_at"], true),
  verificationToken: R(true, true, false, true),
  waitlist: R(true, true, false, false),
  node: R(true, true, [
    "name", "gpu_class", "gpu_model", "vram_mb", "default_watts", "measured_watts", "watts_estimated", "benchmark_score",
    "reported_benchmark", "pieces_done", "earns_credits", "device_hash", "subnet_hash", "last_canary_at", "trust_score",
    "checks_passed", "checks_failed", "status", "paused", "tariff_paise_per_kwh", "owner_rate_paise_per_hr",
    "night_window_start_min", "night_window_end_min", "timezone", "last_seen_at", "quarantined_at",
  ], false),
  node_token: R(true, true, ["last_used_at", "revoked_at"], false),
  job: R(true, true, ["status", "confirmed_at", "completed_at", "refunded_at", "credits_spent", "purge_after", "purged_at"], false),
  fragment: R(true, true, "all", false),
  benchmark_sample: R(true, true, false, false),
  blob: R(true, true, false, true),
  lock: R(true, true, "all", false),
  owner_ledger: R(true, true, false, false),
  buyer_ledger: R(true, true, false, false),
  credit_ledger: R(true, true, false, false),
  audit_log: R(true, true, false, false),
  admin_totp: R(true, true, ["enabled_at", "last_step"], false),
  alert_sent: R(true, true, ["status", "attempts"], false),
  canary_cover: R(true, true, ["status", "canary_fragment_id", "settled_at"], false),
};

const READONLY_TABLES = ["node", "job", "owner_ledger", "buyer_ledger", "credit_ledger", "audit_log", "canary_cover"];
const READONLY_USER_COLUMNS = ["id", "role", "created_at", "deleted_at"];

let t: TestDb;
let tables: string[];
const cols: Record<string, string[]> = {};

beforeAll(async () => {
  t = await freshDb();
  await t.asOwner(async (o) => {
    tables = (await rows<{ t: string }>(o, sql`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).map((r) => r.t);
    for (const name of tables) {
      cols[name] = (await rows<{ c: string }>(o, sql`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = ${name}`)).map((r) => r.c);
    }
  });
});
afterAll(async () => t?.cleanup());

const has = (role: string, table: string, priv: string) =>
  t.asOwner(async (o) => (await rows<{ ok: boolean }>(o, sql`select has_table_privilege(${role}, ${`public."${table}"`}, ${priv}) as ok`))[0]!.ok);
const hasCol = (role: string, table: string, column: string, priv: string) =>
  t.asOwner(async (o) => (await rows<{ ok: boolean }>(o, sql`select has_column_privilege(${role}, ${`public."${table}"`}, ${column}, ${priv}) as ok`))[0]!.ok);

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  return "";
}

describe("app_runtime: exactly the privileges the app needs", () => {
  it("every table has a decision in this test (a new table without one fails here)", () => {
    expect(tables.filter((x) => !(x in RUNTIME))).toEqual([]);
    expect(Object.keys(RUNTIME).filter((x) => !tables.includes(x))).toEqual([]);
  });

  it("SELECT / INSERT / UPDATE (per column) / DELETE match, and nothing has TRUNCATE, REFERENCES or TRIGGER", async () => {
    const wrong: string[] = [];
    for (const table of tables) {
      const e = RUNTIME[table]!;
      for (const [priv, want] of [["SELECT", e.select], ["INSERT", e.insert], ["DELETE", e.delete], ["TRUNCATE", false], ["REFERENCES", false], ["TRIGGER", false]] as const) {
        if ((await has("app_runtime", table, priv)) !== want) wrong.push(`${table} ${priv} should be ${want}`);
      }
      const tableUpdate = await has("app_runtime", table, "UPDATE");
      if (e.update === "all") {
        if (!tableUpdate) wrong.push(`${table} UPDATE should be on every column`);
      } else {
        if (tableUpdate) wrong.push(`${table} UPDATE should not be table-wide`);
        for (const c of cols[table]!) {
          const want = e.update !== false && e.update.includes(c);
          if ((await hasCol("app_runtime", table, c, "UPDATE")) !== want) wrong.push(`${table}.${c} UPDATE should be ${want}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("no UPDATE of role, owner_id or buyer_id: who owns what, and who's admin, can't change from the app", async () => {
    expect(await hasCol("app_runtime", "user", "role", "UPDATE")).toBe(false);
    expect(await hasCol("app_runtime", "node", "owner_id", "UPDATE")).toBe(false);
    expect(await hasCol("app_runtime", "job", "buyer_id", "UPDATE")).toBe(false);
  });

  it("can't change the schema, make temp tables or functions, or read the migration history", async () => {
    for (const q of [
      sql`create table pwned (id int)`,
      sql`alter table "user" add column pwned int`,
      sql`drop table waitlist`,
      sql`create temp table pwned (id int)`,
      sql`create function pwned() returns int language sql as 'select 1'`,
      sql`select * from drizzle.__drizzle_migrations`,
    ]) {
      expect(await pgError(t.db.execute(q)), JSON.stringify(q.queryChunks)).toMatch(/permission denied|must be owner/);
    }
  });

  it("can't grant anything to anyone, and isn't a member of any other role", async () => {
    // Postgres only warns ("no privileges were granted"): check nothing was.
    await t.db.execute(sql`grant select on session to public`);
    expect(await has("public", "session", "SELECT")).toBe(false);
    const owner = await t.asOwner(async (o) => (await rows<{ o: string }>(o, sql`select pg_get_userbyid(relowner) as o from pg_class where relname = 'user'`))[0]!.o);
    for (const other of ["readonly", owner]) {
      expect(await t.asOwner(async (o) => (await rows<{ m: boolean }>(o, sql`select pg_has_role('app_runtime', ${other}, 'MEMBER') as m`))[0]!.m)).toBe(false);
    }
    expect(await t.asOwner(async (o) => (await rows<{ m: boolean }>(o, sql`select pg_has_role('readonly', 'app_runtime', 'MEMBER') as m`))[0]!.m)).toBe(false);
  });
});

describe("readonly: admin reports only", () => {
  it("can SELECT the report tables and a few user columns; nothing else", async () => {
    const wrong: string[] = [];
    for (const table of tables) {
      const want = READONLY_TABLES.includes(table);
      if ((await has("readonly", table, "SELECT")) !== want) wrong.push(`${table} SELECT should be ${want}`);
      for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) if (await has("readonly", table, priv)) wrong.push(`${table} ${priv}`);
    }
    for (const c of cols.user!) {
      if ((await hasCol("readonly", "user", c, "SELECT")) !== READONLY_USER_COLUMNS.includes(c)) wrong.push(`user.${c}`);
    }
    expect(wrong).toEqual([]);
  });

  it("the admin panel's queries all work as readonly", async () => {
    await t.db.insert(users).values({ email: "x@example.in" });
    await t.asRole("readonly", async (r) => {
      await expect(adminTotals(r)).resolves.toMatchObject({ users: 1 });
      await adminNodes(r);
      await adminNodes(r, true);
      await adminJobs(r);
      await adminLedger(r);
      await adminAudit(r);
      await recentFlags(r);
    });
  });

  it("can't read emails, sessions, tokens or job data, and can't write", async () => {
    await t.asRole("readonly", async (r) => {
      for (const q of [
        sql`select email from "user"`,
        sql`select * from session`,
        sql`select * from node_token`,
        sql`select * from blob`,
        sql`select * from admin_totp`,
        sql`select * from fragment`,
        sql`insert into audit_log (actor_type, action) values ('system', 'x')`,
      ]) {
        expect(await pgError(r.execute(q))).toMatch(/permission denied/);
      }
    });
  });
});
