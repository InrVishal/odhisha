/**
 * Preview and production must never share a Redis or a database (incident
 * 2026-11-24, docs/INCIDENTS.md). Neither environment can see the other's
 * settings (Vercel keeps them per environment, and Sensitive values can't be
 * read back), so each shared resource carries a marker saying whose it is:
 *
 * - Redis: the key `ns:owner-env` holds the environment that first used the
 *   database ("preview" or "production"; SET NX, so the first one keeps it).
 *   A preview finding "production" there, or production finding "preview",
 *   is sharing.
 * - Database: production's deploy step writes its own Neon endpoint id to
 *   deployment_marker (scripts/mark-production-db.ts). Preview branches are
 *   copies, so they carry production's id while having their own endpoint.
 *   A preview whose endpoint IS that id is connected to production's
 *   database; production whose endpoint ISN'T is connected to something else.
 *
 * What happens on a mismatch: a preview refuses (no Redis, no database), so
 * it can't spend production's quota or touch its data; production keeps
 * serving (it never takes itself down over this), alerts, and its health
 * check fails, so CI doesn't promote a new production deployment.
 */

export const REDIS_OWNER_KEY = "ns:owner-env";
export const PRODUCTION_ENDPOINT_MARKER = "production_endpoint";

export type DeployedEnv = "preview" | "production";
export type Verdict = { ok: true; owner: string | null } | { ok: false; owner: string | null; reason: string };

/** The two Redis commands the check needs (Upstash's client has both). */
export interface OwnerStore {
  set(key: string, value: string, opts: { nx: true }): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

/**
 * Claims the Redis for this environment if nobody has, then checks the claim.
 * Two commands at most, once per server instance (the caller caches it).
 */
export async function checkRedisOwner(store: OwnerStore, env: DeployedEnv): Promise<Verdict> {
  const claimed = await store.set(REDIS_OWNER_KEY, env, { nx: true });
  if (claimed === "OK") return { ok: true, owner: env };
  const owner = await store.get(REDIS_OWNER_KEY);
  const name = typeof owner === "string" ? owner : null;
  if (name === env) return { ok: true, owner: name };
  return { ok: false, owner: name, reason: `this Redis belongs to ${name ?? "an unknown environment"}, not ${env}` };
}

/**
 * The Neon compute endpoint a connection string points at, e.g.
 * "ep-cool-river-123456" from ep-cool-river-123456-pooler.c-2.us-east-2.aws.neon.tech.
 * Pooled and direct URLs give the same id. Null for anything that isn't Neon.
 */
export function neonEndpointId(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host.endsWith(".neon.tech")) return null;
  const first = host.split(".")[0] ?? "";
  if (!first.startsWith("ep-")) return null;
  return first.replace(/-pooler$/, "");
}

/**
 * Database verdict from this connection's endpoint and the marker it holds.
 * Unknown endpoints (local Postgres, PGlite) and a missing marker pass: there
 * is nothing to compare.
 */
export function judgeDatabase(env: DeployedEnv, ownEndpoint: string | null, marker: string | null): Verdict {
  if (!ownEndpoint || !marker) return { ok: true, owner: marker };
  if (env === "preview" && ownEndpoint === marker) return { ok: false, owner: marker, reason: "this preview is connected to production's database" };
  if (env === "production" && ownEndpoint !== marker) return { ok: false, owner: marker, reason: "production is connected to a database that isn't production's (a preview branch or copy)" };
  return { ok: true, owner: marker };
}

/** Thrown where a preview refuses a shared resource. */
export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationError";
  }
}
