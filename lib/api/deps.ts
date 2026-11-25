import "server-only";
import { randomInt } from "node:crypto";
import { ipHashSecret } from "@/lib/auth";
import { alertConfig } from "@/lib/alerts";
import { currentSession, currentUser } from "@/lib/auth/guards";
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
    sybil: env.SYBIL_CHECKER_RULES,
    checkRand: () => randomInt(1_000_000_000) / 1_000_000_000,
    adminEmails: env.ADMIN_EMAILS,
    alerts: alertConfig(env),
  };
}

/** Same, plus the signed-in user (or null), read server-side from the session. */
export async function userDeps(): Promise<UserDeps> {
  const [user, session] = await Promise.all([currentUser(), currentSession()]);
  return { ...(await deps()), user, session };
}
