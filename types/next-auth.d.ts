import type { DefaultSession } from "next-auth";

/**
 * The session carries the user id only. Admin status is never put in the
 * session or a cookie: it's read from the database on every request
 * (lib/admin.ts, isAdmin).
 */
declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}
