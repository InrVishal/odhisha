/** 401 = not signed in, 403 = signed in but not allowed. */
export class AuthzError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(status === 401 ? "unauthenticated" : "forbidden");
    this.name = "AuthzError";
  }
}

export interface SessionUser {
  id: string;
  role: "user" | "admin";
}
