import "server-only";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { AuthzError, type SessionUser } from "./authz-error";
import { auth } from "./index";

export { AuthzError, type SessionUser };

/**
 * Server-side authorization. Call one of these at the top of EVERY route
 * handler, server action and protected page. Proxy is not an auth boundary.
 *
 * Data access rule: every query for user-owned data must filter on the id
 * returned here (e.g. `where(and(eq(jobs.id, id), eq(jobs.buyerId, user.id)))`).
 * Never trust an owner id that came from the client.
 */


export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return { id: session.user.id, role: session.user.role ?? "user" };
}

/** For route handlers and server actions. Throws AuthzError(401). */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new AuthzError(401);
  return user;
}

/** For pages. Sends signed-out visitors to the login page. */
export async function requireUserOrRedirect(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/signin");
  return user;
}

/**
 * Admin check. Re-reads the role from the database on every call instead of
 * trusting the session, so removing admin in the DB takes effect immediately.
 * The role column is only ever changed directly in the database.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  const db = await getDb();
  const [row] = await db
    .select({ role: users.role, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!row || row.deletedAt || row.role !== "admin") throw new AuthzError(403);
  return { id: user.id, role: "admin" };
}

/** Maps auth errors to a JSON response. Any other error is re-thrown. */
export function authzErrorResponse(err: unknown): Response {
  if (err instanceof AuthzError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}
