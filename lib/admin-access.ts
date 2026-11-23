import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { isAdmin } from "@/lib/admin";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { adminTotp, sessions, users } from "@/lib/db/schema";
import { open, seal } from "@/lib/security/envelope";
import { newTotpSecret, otpauthUri, verifyTotp } from "@/lib/security/totp";

/**
 * Who may use the admin pages and actions, decided on every request, on the
 * server, from the database:
 *
 * 1. Admin (lib/admin.ts): role = 'admin' in the database AND the email on
 *    ADMIN_EMAILS. Anyone else gets a 404, so the pages don't even confirm
 *    they exist.
 * 2. A login from the last 15 minutes (this session was created then).
 * 3. A second factor on this session: a TOTP code from an authenticator app.
 *    The first time, the admin sets one up; after that it can only be reset
 *    by the database owner.
 *
 * Every step is audit-logged.
 */

export const ADMIN_LOGIN_MAX_AGE_SEC = 15 * 60;

export interface SessionRow {
  token: string;
  userId: string;
  createdAt: Date;
  mfaAt: Date | null;
  expires: Date;
}

export type AdminAccess =
  | { state: "not_admin" }
  /** An admin, but the login is older than 15 minutes: log in again. */
  | { state: "stale_login"; userId: string }
  /** An admin with a fresh login and no second factor set up yet. */
  | { state: "setup"; userId: string; session: SessionRow }
  /** An admin with a fresh login who hasn't entered a code on this session. */
  | { state: "code"; userId: string; session: SessionRow }
  | { state: "ok"; userId: string; session: SessionRow };

export async function sessionByToken(db: Db, token: string | null | undefined, now: Date): Promise<SessionRow | null> {
  if (!token || token.length > 512) return null;
  const [row] = await db
    .select({ token: sessions.sessionToken, userId: sessions.userId, createdAt: sessions.createdAt, mfaAt: sessions.mfaAt, expires: sessions.expires })
    .from(sessions)
    .where(and(eq(sessions.sessionToken, token), gt(sessions.expires, now)))
    .limit(1);
  return row ?? null;
}

export async function adminAccess(db: Db, session: SessionRow | null, allowlist: readonly string[], now: Date): Promise<AdminAccess> {
  if (!session || session.expires <= now) return { state: "not_admin" };
  if (!(await isAdmin(db, session.userId, allowlist))) return { state: "not_admin" };
  const userId = session.userId;
  if (now.getTime() - session.createdAt.getTime() > ADMIN_LOGIN_MAX_AGE_SEC * 1000) return { state: "stale_login", userId };
  const [totp] = await db.select({ enabledAt: adminTotp.enabledAt }).from(adminTotp).where(eq(adminTotp.userId, userId)).limit(1);
  if (!totp?.enabledAt) return { state: "setup", userId, session };
  if (!session.mfaAt || session.mfaAt < session.createdAt) return { state: "code", userId, session };
  return { state: "ok", userId, session };
}

const aad = (userId: string) => `admin-totp:${userId}`;

/**
 * The secret to set up, for an admin with a fresh login and no confirmed
 * second factor. Made once and kept (sealed) until it's confirmed with a code,
 * so reloading the page shows the same one.
 */
export async function totpSetupSecret(
  db: Db,
  access: Extract<AdminAccess, { state: "setup" }>,
  masterKey: Buffer,
  now: Date,
): Promise<{ secret: string; uri: string }> {
  const userId = access.userId;
  const sealed = seal(masterKey, Buffer.from(newTotpSecret()), aad(userId)).toString("base64");
  await db.insert(adminTotp).values({ userId, secretSealed: sealed, createdAt: now }).onConflictDoNothing({ target: adminTotp.userId });
  const [row] = await db.select().from(adminTotp).where(eq(adminTotp.userId, userId)).limit(1);
  if (!row || row.enabledAt) throw new Error("second factor already set up");
  const secret = open(masterKey, Buffer.from(row.secretSealed, "base64"), aad(userId)).toString();
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return { secret, uri: otpauthUri(secret, u?.email ?? userId) };
}

export type CodeResult = "ok" | "wrong" | "not_found" | "stale_login";

/**
 * Checks an authenticator code for this session. Right code: the session
 * passes the second factor (and a new setup is confirmed). The same code
 * can't be used twice.
 */
export async function submitAdminCode(
  db: Db,
  ctx: { session: SessionRow | null; allowlist: readonly string[]; now: Date; masterKey: Buffer; ipSecret: string; ip?: string },
  code: string,
): Promise<CodeResult> {
  const access = await adminAccess(db, ctx.session, ctx.allowlist, ctx.now);
  if (access.state === "not_admin") return "not_found";
  if (access.state === "stale_login") return "stale_login";
  const { userId, session } = access;
  const [row] = await db.select().from(adminTotp).where(eq(adminTotp.userId, userId)).limit(1);
  if (!row) return "wrong";
  const secret = open(ctx.masterKey, Buffer.from(row.secretSealed, "base64"), aad(userId)).toString();
  const step = verifyTotp(secret, code.trim(), ctx.now, row.lastStep);
  const log = (action: "admin.mfa_failed" | "admin.mfa_verified" | "admin.mfa_enrolled") =>
    audit(db, { actorId: userId, actorType: "admin", action, targetType: "user", targetId: userId, ip: ctx.ip }, ctx.ipSecret);
  if (step === null) {
    await log("admin.mfa_failed");
    return "wrong";
  }
  // One statement, so two requests with the same code can't both pass.
  const [used] = await db
    .update(adminTotp)
    .set({ lastStep: step, ...(row.enabledAt ? {} : { enabledAt: ctx.now }) })
    .where(and(eq(adminTotp.userId, userId), or(isNull(adminTotp.lastStep), lt(adminTotp.lastStep, step))))
    .returning({ userId: adminTotp.userId });
  if (!used) {
    await log("admin.mfa_failed");
    return "wrong";
  }
  if (!row.enabledAt) await log("admin.mfa_enrolled");
  await db.update(sessions).set({ mfaAt: ctx.now }).where(eq(sessions.sessionToken, session.token));
  await log("admin.mfa_verified");
  return "ok";
}
