import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import type { Db } from "@/lib/db/client";
import { accounts, sessions, users, verificationTokens } from "@/lib/db/schema";

/**
 * The stock Drizzle adapter, with data minimisation (DPDP Act):
 * - We never store OAuth access/refresh/id tokens. We don't call Google APIs.
 * - We never store a name or profile picture.
 *
 * And with least privilege: the stock updateUser and updateSession write
 * every field they are given, including the row's own key (and, for a user,
 * anything else on the object, such as role). The app's database role may
 * only update a few columns (migration 0008), so these write exactly those.
 */
export function minimalAdapter(db: Db): Adapter {
  const base = DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  });

  return {
    ...base,
    createUser: (user: AdapterUser) => base.createUser!({ ...user, name: null, image: null }),
    updateUser: async (user) => {
      if (!user.id) throw new Error("No user id.");
      const patch: Partial<typeof users.$inferInsert> = { name: null, image: null };
      if (user.email !== undefined) patch.email = user.email;
      if (user.emailVerified !== undefined) patch.emailVerified = user.emailVerified;
      const [row] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning();
      if (!row) throw new Error("No user found.");
      return row as AdapterUser;
    },
    updateSession: async (session) => {
      if (!session.expires) {
        const [row] = await db.select().from(sessions).where(eq(sessions.sessionToken, session.sessionToken)).limit(1);
        return row ?? null;
      }
      const [row] = await db.update(sessions).set({ expires: session.expires }).where(eq(sessions.sessionToken, session.sessionToken)).returning();
      return row ?? null;
    },
    // The stock adapter returns nothing here, so the signOut event can't tell
    // who logged out. Returning the deleted row lets us audit it.
    deleteSession: async (sessionToken: string) => {
      const [row] = await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken)).returning();
      return row ?? null;
    },
    linkAccount: (account: AdapterAccount) =>
      base.linkAccount!({
        ...account,
        access_token: undefined,
        refresh_token: undefined,
        id_token: undefined,
        session_state: undefined,
        expires_at: undefined,
      }),
  };
}
