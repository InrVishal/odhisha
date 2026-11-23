import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isAdmin } from "@/lib/admin";
import { ADMIN_LOGIN_MAX_AGE_SEC, adminAccess, submitAdminCode, totpSetupSecret } from "@/lib/admin-access";
import { sendSecurityAlerts, type Mailer } from "@/lib/alerts";
import * as H from "@/lib/api/handlers";
import { adminTotp, alertSent, auditLog, sessions, users } from "@/lib/db/schema";
import { codeForStep, stepAt, totpCode } from "@/lib/security/totp";
import { makeAdmin } from "../helpers/admin";
import { harness, jsonReq, makeSession, makeUser, type Harness } from "../helpers/coordinator";
import { freshDb, type TestDb } from "../helpers/db";

/**
 * Admin can't be gained or changed (A1–A5) and typing /admin gives nothing
 * (B), at the level of the code that decides it. The pages themselves are
 * checked in a real browser in tests/e2e/admin.spec.ts.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

let t: TestDb;
let h: Harness;
beforeEach(async () => {
  t = await freshDb();
  cleanups.push(t.cleanup);
  h = harness(t.db);
});

const roleOf = async (id: string) => (await h.db.select({ role: users.role }).from(users).where(eq(users.id, id)))[0]!.role;
const audits = async (action: string) => h.db.select().from(auditLog).where(eq(auditLog.action, action));
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  return "";
}

describe("A2: the database itself stops role changes", () => {
  it("the app's role can't UPDATE role at all (no column privilege)", async () => {
    const u = await makeUser(h.db, "u@example.in");
    expect(await pgError(h.db.update(users).set({ role: "admin" }).where(eq(users.id, u.id)))).toMatch(/permission denied/);
    expect(await pgError(h.db.execute(sql`update "user" set role = 'admin'`))).toMatch(/permission denied/);
    expect(await roleOf(u.id)).toBe("user");
  });

  it("the app's role can't INSERT an admin: the trigger keeps the role 'user' and logs the attempt", async () => {
    const [u] = await h.db.insert(users).values({ email: "sneaky@example.in", role: "admin" }).returning();
    expect(u!.role).toBe("user");
    const [log] = await audits("admin.role_change_refused");
    expect(log).toMatchObject({ targetId: u!.id, meta: { from: "user", to: "admin", dbRole: "app_runtime" } });
  });

  it("any other role with UPDATE on the table is undone and logged too; only the owner role can change it", async () => {
    const u = await makeUser(h.db, "u@example.in");
    // A role someone granted too much by mistake.
    await t.asOwner(async (o) => {
      await o.execute(sql`do $$ begin create role rogue_updater nologin; exception when duplicate_object then null; end $$`);
      await o.execute(sql`grant select, update on "user" to rogue_updater`);
      await o.execute(sql`grant usage on schema public to rogue_updater`);
      await o.execute(sql`set role rogue_updater`);
      await o.execute(sql`update "user" set role = 'admin' where id = ${u.id}`);
      await o.execute(sql`reset role`);
    });
    expect(await roleOf(u.id)).toBe("user");
    expect((await audits("admin.role_change_refused")).map((a) => (a.meta as { dbRole: string }).dbRole)).toEqual(["rogue_updater"]);

    // The owner role can, and that's logged as a change.
    await t.asOwner((o) => o.update(users).set({ role: "admin" }).where(eq(users.id, u.id)));
    expect(await roleOf(u.id)).toBe("admin");
    expect((await audits("admin.role_changed"))[0]).toMatchObject({ targetId: u.id, meta: { from: "user", to: "admin" } });
  });

  it("the trigger's logging function can't be called directly to forge audit rows", async () => {
    expect(await pgError(h.db.execute(sql`select nightshift_log_role_attempt('x', 'user', 'admin', 'me', true)`))).toMatch(/only called by the role trigger/);
    expect(await audits("admin.role_changed")).toEqual([]);
  });

  it("every role change is emailed to the admins once; sends that fail are tried again", async () => {
    const u = await makeUser(h.db, "u@example.in");
    await h.db.insert(users).values({ email: "x@example.in", role: "admin" });
    await t.asOwner((o) => o.update(users).set({ role: "admin" }).where(eq(users.id, u.id)));
    const sent: Array<{ to: readonly string[]; subject: string; text: string }> = [];
    let failNext = true;
    const mailer: Mailer = {
      send: async (to, subject, text) => {
        if (failNext) {
          failNext = false;
          throw new Error("provider down");
        }
        sent.push({ to, subject, text });
      },
    };
    const cfg = { mailer, recipients: ["me@example.in"] };
    expect(await sendSecurityAlerts(h.db, cfg)).toEqual({ sent: 1, skipped: 0, failed: 1 });
    expect(await sendSecurityAlerts(h.db, cfg)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(await sendSecurityAlerts(h.db, cfg)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(sent.map((s) => s.subject).sort()).toEqual([
      "NightShift security alert: a role change was refused",
      "NightShift security alert: an account's role changed",
    ]);
    // Ids only: no email addresses in the alert.
    for (const s of sent) expect(s.text).not.toMatch(/@example/);
    expect(await h.db.select().from(alertSent)).toHaveLength(2);
  });

  it("an alert that keeps failing is tried 5 times, then left in the audit log; with nobody to email it's skipped", async () => {
    await h.db.insert(users).values({ email: "x@example.in", role: "admin" });
    const down: Mailer = { send: async () => Promise.reject(new Error("down")) };
    for (let i = 0; i < 7; i++) await sendSecurityAlerts(h.db, { mailer: down, recipients: ["me@example.in"] });
    expect((await h.db.select().from(alertSent))[0]).toMatchObject({ status: "failed", attempts: 5 });
    await h.db.insert(users).values({ email: "y@example.in", role: "admin" });
    expect(await sendSecurityAlerts(h.db, { mailer: down, recipients: [] })).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });
});

describe("A3 + A4: admin is two keys, read from the database on every request", () => {
  it("role alone does nothing; the allowlist alone does nothing; both do", async () => {
    const onlyRole = await makeAdmin(t, h, { email: "role-only@example.in", allowlisted: false });
    expect(await isAdmin(h.db, onlyRole.user.id, h.deps.adminEmails!)).toBe(false);
    const listed = await makeUser(h.db, "listed@example.in");
    expect(await isAdmin(h.db, listed.id, ["listed@example.in"])).toBe(false);
    const both = await makeAdmin(t, h, { email: "Both@Example.in" });
    expect(await isAdmin(h.db, both.user.id, ["both@example.in"])).toBe(true);
    expect(await isAdmin(h.db, both.user.id, [])).toBe(false);
  });

  it("taking admin away in the database works on the very next request (nothing cached in the session)", async () => {
    const a = await makeAdmin(t, h);
    expect((await adminAccess(h.db, a.session, h.deps.adminEmails!, h.clock.now())).state).toBe("ok");
    await t.asOwner((o) => o.update(users).set({ role: "user" }).where(eq(users.id, a.user.id)));
    expect((await adminAccess(h.db, a.session, h.deps.adminEmails!, h.clock.now())).state).toBe("not_admin");
  });

  it("a deleted account is never an admin", async () => {
    const a = await makeAdmin(t, h);
    await h.db.update(users).set({ deletedAt: h.clock.now() }).where(eq(users.id, a.user.id));
    expect(await isAdmin(h.db, a.user.id, h.deps.adminEmails!)).toBe(false);
  });
});

describe("A5: a login from the last 15 minutes, plus a code from an authenticator app", () => {
  it("steps: no session → 404; stale login → log in again; no authenticator → set one up; set up → code; code → in", async () => {
    const access = (s: Parameters<typeof adminAccess>[1]) => adminAccess(h.db, s, h.deps.adminEmails!, h.clock.now());
    expect((await access(null)).state).toBe("not_admin");

    const stale = await makeAdmin(t, h, { email: "stale@example.in", loginAgoSec: ADMIN_LOGIN_MAX_AGE_SEC + 1 });
    expect((await access(stale.session)).state).toBe("stale_login");

    const fresh = await makeAdmin(t, h, { email: "fresh@example.in", totp: false, mfa: false });
    const setup = await access(fresh.session);
    expect(setup.state).toBe("setup");
    if (setup.state !== "setup") return;
    const { secret, uri } = await totpSetupSecret(h.db, setup, h.keys.dataKey, h.clock.now());
    // Reloading shows the same secret until it's confirmed.
    expect((await totpSetupSecret(h.db, setup, h.keys.dataKey, h.clock.now())).secret).toBe(secret);
    expect(uri).toContain(`secret=${secret}`);
    // The secret is stored sealed, never in the clear.
    const [row] = await h.db.select().from(adminTotp).where(eq(adminTotp.userId, fresh.user.id));
    expect(row!.secretSealed).not.toContain(secret);

    const ctx = { session: fresh.session, allowlist: h.deps.adminEmails!, now: h.clock.now(), masterKey: h.keys.dataKey, ipSecret: "s" };
    expect(await submitAdminCode(h.db, ctx, "000000")).toBe("wrong");
    expect(await submitAdminCode(h.db, ctx, totpCode(secret, h.clock.now()))).toBe("ok");
    expect((await access((await sessionRow(fresh.session.token))!)).state).toBe("ok");
    expect((await audits("admin.mfa_enrolled")).map((a) => a.actorId)).toEqual([fresh.user.id]);
    expect(await audits("admin.mfa_failed")).toHaveLength(1);

    // The same code can't be used again, even on another fresh login.
    const again = await makeSession(h, fresh.user.id, { loginAgoSec: 5 });
    expect((await access(again)).state).toBe("code");
    expect(await submitAdminCode(h.db, { ...ctx, session: again }, totpCode(secret, h.clock.now()))).toBe("wrong");
    // The next step's code works.
    h.clock.advance(30);
    expect(await submitAdminCode(h.db, { ...ctx, session: again, now: h.clock.now() }, codeForStep(secret, stepAt(h.clock.now())))).toBe("ok");

    // 15 minutes after the login, even a fully checked session is out.
    h.clock.advance(ADMIN_LOGIN_MAX_AGE_SEC);
    expect((await access((await sessionRow(again.token))!)).state).toBe("stale_login");
  });

  it("a confirmed authenticator can't be switched off or replaced by the app's database role", async () => {
    const a = await makeAdmin(t, h);
    expect(await pgError(h.db.update(adminTotp).set({ enabledAt: null }).where(eq(adminTotp.userId, a.user.id)))).toMatch(/only be reset by the owner/);
    expect(await pgError(h.db.update(adminTotp).set({ secretSealed: "x" }).where(eq(adminTotp.userId, a.user.id)))).toMatch(/permission denied/);
    expect(await pgError(h.db.delete(adminTotp).where(eq(adminTotp.userId, a.user.id)))).toMatch(/permission denied/);
  });

  it("codes can't be tried on someone else's session, or by a non-admin", async () => {
    const a = await makeAdmin(t, h, { mfa: false });
    const buyer = await makeUser(h.db, "buyer@example.in");
    const buyerSession = await makeSession(h, buyer.id);
    const ctx = { session: buyerSession, allowlist: h.deps.adminEmails!, now: h.clock.now(), masterKey: h.keys.dataKey, ipSecret: "s" };
    expect(await submitAdminCode(h.db, ctx, totpCode(a.secret!, h.clock.now()))).toBe("not_found");
    const [s] = await h.db.select().from(sessions).where(eq(sessions.sessionToken, buyerSession.token));
    expect(s!.mfaAt).toBeNull();
  });
});

async function sessionRow(token: string) {
  const [s] = await h.db.select().from(sessions).where(eq(sessions.sessionToken, token));
  return s ? { token, userId: s.userId, createdAt: s.createdAt, mfaAt: s.mfaAt, expires: s.expires } : null;
}

describe("B: every admin API route gives non-admins a 404", () => {
  const release = (d: H.UserDeps, headers: Record<string, string> = {}) =>
    H.releaseNodeHandler(jsonReq("POST", "/api/admin/nodes/00000000-0000-4000-8000-000000000000/release", undefined, headers), d, "00000000-0000-4000-8000-000000000000");

  it("anonymous, buyer, owner, role-only and allowlist-only all get the same 404", async () => {
    const buyer = await makeUser(h.db, "buyer@example.in");
    const roleOnly = await makeAdmin(t, h, { email: "ro@example.in", allowlisted: false });
    const listed = await makeUser(h.db, "listed@example.in");
    h.deps.adminEmails = [...h.deps.adminEmails!, "listed@example.in"];
    for (const d of [h.as(null), h.as(buyer, await makeSession(h, buyer.id)), h.as(roleOnly.user, roleOnly.session), h.as(listed, await makeSession(h, listed.id))]) {
      const res = await release(d);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found", message: expect.any(String) });
    }
    expect((await H.adminNotFoundHandler()).status).toBe(404);
  });

  it("spoofed headers change nothing (x-middleware-subrequest, x-forwarded-*, made-up role headers)", async () => {
    const buyer = await makeUser(h.db, "buyer@example.in");
    const s = await makeSession(h, buyer.id);
    const spoofs: Array<Record<string, string>> = [
      { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" },
      { "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" },
      { "x-user-role": "admin", "x-admin": "true", "x-role": "admin" },
      { "x-forwarded-host": "localhost", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
      { cookie: "role=admin; isAdmin=true" },
    ];
    for (const headers of spoofs) {
      expect((await release(h.as(buyer, s), headers)).status).toBe(404);
    }
  });

  it("an admin without the step-up gets a 403 asking for it, and nothing happens", async () => {
    const stale = await makeAdmin(t, h, { email: "stale@example.in", loginAgoSec: ADMIN_LOGIN_MAX_AGE_SEC + 60 });
    expect((await release(h.as(stale.user, stale.session))).status).toBe(403);
    const noCode = await makeAdmin(t, h, { email: "nocode@example.in", mfa: false });
    const res = await release(h.as(noCode.user, noCode.session));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("admin_step_up");
    // A session row that isn't this user's doesn't count.
    const other = await makeAdmin(t, h, { email: "other@example.in" });
    expect((await release(h.as(noCode.user, other.session))).status).toBe(404);
  });
});
