import "server-only";
import { ipHashSecret } from "@/lib/auth";
import { currentUser } from "@/lib/auth/guards";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { checkLimit } from "@/lib/ratelimit";
import { getKeys } from "@/lib/security/keys";
import type { Deps, UserDeps } from "./handlers";

/** Real dependencies for the route handlers in app/api/. */
export async function deps(): Promise<Deps> {
  const env = getEnv();
  return {
    db: await getDb(),
    now: () => new Date(),
    keys: await getKeys(),
    ipSecret: ipHashSecret(),
    cronSecret: env.CRON_SECRET,
    limit: checkLimit,
    challenges: true,
  };
}

/** Same, plus the signed-in user (or null), read server-side from the session. */
export async function userDeps(): Promise<UserDeps> {
  return { ...(await deps()), user: await currentUser() };
}
