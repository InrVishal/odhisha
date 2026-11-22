import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";

/**
 * "Log out of all devices": deletes every session the user has, on every
 * device, including the current one. Returns how many were revoked.
 */
export async function revokeAllSessions(db: Db, userId: string): Promise<number> {
  const deleted = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ t: sessions.sessionToken });
  return deleted.length;
}

export const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;
