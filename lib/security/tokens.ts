import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const NODE_TOKEN_PREFIX = "nsn_";

/** 256 random bits, base64url. The prefix makes leaked tokens easy to grep for. */
export function generateNodeToken(): string {
  return NODE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Accepts only well-formed tokens so junk input never reaches the database. */
export function isWellFormedNodeToken(token: string): boolean {
  return /^nsn_[A-Za-z0-9_-]{43}$/.test(token);
}

/** We store this hash, never the token. Lookup is by hash, so no timing leak. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Keyed hash of the client IP for the audit log and rate-limit keys. Lets us
 * see "same IP" without keeping the IP (DPDP data minimisation).
 */
export function hashIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ip).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Checks `Authorization: Bearer <CRON_SECRET>` in constant time. */
export function isAuthorizedCron(authorizationHeader: string | null, cronSecret: string): boolean {
  if (!authorizationHeader) return false;
  return safeEqual(authorizationHeader, `Bearer ${cronSecret}`);
}

/**
 * Client IP as seen by Vercel's edge. Vercel overwrites x-forwarded-for and
 * x-real-ip, so clients cannot spoof them there. Locally they may be absent.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return "unknown";
}
