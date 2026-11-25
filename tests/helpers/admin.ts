import { eq } from "drizzle-orm";
import type { SessionRow } from "@/lib/admin-access";
import type { SessionUser } from "@/lib/auth/authz-error";
import { adminTotp, users } from "@/lib/db/schema";
import { seal } from "@/lib/security/envelope";
import { newTotpSecret } from "@/lib/security/totp";
import { makeSession, makeUser, type Harness } from "./coordinator";
import type { TestDb } from "./db";

export interface Admin {
  user: SessionUser;
  session: SessionRow;
  email: string;
  /** The TOTP secret (only when `totp` was set up). */
  secret: string | null;
}

/**
 * An admin the way production makes one: role set by the owner role (the
 * app's own role can't), the email on the ADMIN_EMAILS allowlist, and a
 * session. Options pick which of the step-up checks it has passed.
 */
export async function makeAdmin(
  t: TestDb,
  h: Harness,
  opts: { email?: string; allowlisted?: boolean; loginAgoSec?: number; totp?: boolean; mfa?: boolean } = {},
): Promise<Admin> {
  const email = opts.email ?? "admin@example.in";
  const user = await makeUser(h.db, email);
  await t.asOwner((o) => o.update(users).set({ role: "admin" }).where(eq(users.id, user.id)));
  if (opts.allowlisted ?? true) h.deps.adminEmails = [...(h.deps.adminEmails ?? []), email];
  let secret: string | null = null;
  if (opts.totp ?? true) {
    secret = newTotpSecret();
    await h.db.insert(adminTotp).values({
      userId: user.id,
      secretSealed: seal(h.keys.dataKey, Buffer.from(secret), `admin-totp:${user.id}`).toString("base64"),
      enabledAt: h.clock.now(),
    });
  }
  const session = await makeSession(h, user.id, { loginAgoSec: opts.loginAgoSec ?? 60, mfa: opts.mfa ?? true });
  return { user, session, email, secret };
}
