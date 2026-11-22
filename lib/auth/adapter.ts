import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import type { Db } from "@/lib/db/client";
import { accounts, sessions, users, verificationTokens } from "@/lib/db/schema";

/**
 * The stock Drizzle adapter, with data minimisation (DPDP Act):
 * - We never store OAuth access/refresh/id tokens. We don't call Google APIs.
 * - We never store a name or profile picture.
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
    updateUser: (user) => base.updateUser!({ ...user, name: null, image: null }),
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
