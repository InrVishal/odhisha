/** 401 = not signed in, 403 = signed in but not allowed. */
export class AuthzError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(status === 401 ? "unauthenticated" : "forbidden");
    this.name = "AuthzError";
  }
}

/**
 * Who is signed in. Deliberately no role: whether someone is an admin is
 * read from the database (and the ADMIN_EMAILS allowlist) at the moment it
 * matters, never carried in the session (lib/admin.ts, isAdmin).
 */
export interface SessionUser {
  id: string;
}
