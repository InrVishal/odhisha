"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { ipHashSecret } from "@/lib/auth";
import { requireUser } from "@/lib/auth/guards";
import { revokeAllSessions, SESSION_COOKIE_NAMES } from "@/lib/auth/sessions";
import { getDb } from "@/lib/db";
import { clientIp } from "@/lib/security/tokens";

/** Ends every session this account has, on every device, then logs out here. */
export async function logoutEverywhere(): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const revoked = await revokeAllSessions(db, user.id);
  await audit(
    db,
    { actorId: user.id, actorType: "user", action: "auth.logout_all", ip: clientIp(await headers()), meta: { sessions: revoked } },
    ipHashSecret(),
  );
  const jar = await cookies();
  for (const name of SESSION_COOKIE_NAMES) jar.delete(name);
  redirect("/");
}
