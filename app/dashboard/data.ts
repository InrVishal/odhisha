import "server-only";
import { notFound } from "next/navigation";
import { ipHashSecret } from "@/lib/auth";
import { requireUserOrRedirect } from "@/lib/auth/guards";
import { CoordinatorError } from "@/lib/coordinator/errors";
import { maybeTick } from "@/lib/coordinator/tick";
import { alertConfig } from "@/lib/alerts";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

/**
 * Shared server-side setup for dashboard pages. Every page starts here, so
 * every page checks the session itself (the layout's check isn't enough on
 * its own: layouts don't re-run on every navigation).
 */
export async function pageContext() {
  const user = await requireUserOrRedirect();
  return { user, db: await getDb(), now: new Date() };
}

/** Moves the scheduler along (throttled), like the API does when a buyer looks at a job. */
export async function tickQuietly(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  try {
    const env = getEnv();
    await maybeTick(db, new Date(), ipHashSecret(), { alerts: alertConfig(env), sybil: env.SYBIL_CHECKER_RULES });
  } catch (err) {
    console.error("[tick] failed", err instanceof Error ? err.name : typeof err);
  }
}

/** A 404 from the coordinator (not yours, or no such id) becomes the 404 page. */
export async function orNotFound<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof CoordinatorError && err.status === 404) notFound();
    throw err;
  }
}
