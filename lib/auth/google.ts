import type { Env } from "@/lib/env";

/**
 * The origin this request was made to. AUTH_URL wins when set (fixed
 * production URL). Otherwise the forwarded host/proto, which Vercel sets.
 */
export function requestOrigin(headers: Headers, authUrl?: string): string | null {
  if (authUrl) return new URL(authUrl).origin;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return null;
  const proto = headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * Google login works only where its redirect URI is registered. Google has no
 * wildcard redirect URIs, so this is never true on Vercel preview URLs, and
 * previews use the email link instead. This is expected, not a bug.
 */
export function googleEnabledFor(env: Env, origin: string | null): boolean {
  if (!env.AUTH_GOOGLE_ID || !env.AUTH_GOOGLE_SECRET || !origin) return false;
  return env.AUTH_GOOGLE_REDIRECT_ORIGINS.includes(origin);
}
