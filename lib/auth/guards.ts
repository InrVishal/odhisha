import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminAccess, sessionByToken, type AdminAccess, type SessionRow } from "@/lib/admin-access";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { AuthzError, type SessionUser } from "./authz-error";
import { auth } from "./index";
import { SESSION_COOKIE_NAMES } from "./sessions";

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
  return { id: session.user.id };
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

/** This request's session row (from its session cookie), or null. */
export async function currentSession(): Promise<SessionRow | null> {
  const jar = await cookies();
  const token = SESSION_COOKIE_NAMES.map((n) => jar.get(n)?.value).find((v): v is string => Boolean(v));
  return sessionByToken(await getDb(), token, new Date());
}

/**
 * Admin access for this request, read from the database now (role, the
 * ADMIN_EMAILS allowlist, login age, second factor). Never from a header,
 * a cookie other than the session token, or anything proxy.ts set.
 */
export async function currentAdminAccess(): Promise<AdminAccess> {
  return adminAccess(await getDb(), await currentSession(), getEnv().ADMIN_EMAILS, new Date());
}

/**
 * For the admin layout, its pages and its server actions: anyone who isn't
 * an admin gets the plain 404 page, as if the page didn't exist.
 */
export async function adminOr404(): Promise<Exclude<AdminAccess, { state: "not_admin" }>> {
  const access = await currentAdminAccess();
  if (access.state === "not_admin") notFound();
  return access;
}

/** Maps auth errors to a JSON response. Any other error is re-thrown. */
export function authzErrorResponse(err: unknown): Response {
  if (err instanceof AuthzError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}
