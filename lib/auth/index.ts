import "server-only";
import { eq, inArray } from "drizzle-orm";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { cookies, headers } from "next/headers";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { checkLimit } from "@/lib/ratelimit";
import { clientIp } from "@/lib/security/tokens";
import { minimalAdapter } from "./adapter";
import { MAGIC_LINK_MAX_AGE_SEC, sendMagicLink } from "./email";
import { googleEnabledFor, requestOrigin } from "./google";
import { SESSION_COOKIE_NAMES } from "./sessions";

const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

async function requestIp(): Promise<string> {
  try {
    return clientIp(await headers());
  } catch {
    return "unknown";
  }
}

/** True when Google login can work for the origin of the current request. */
export async function googleLoginAvailable(): Promise<boolean> {
  const env = getEnv();
  let origin: string | null = null;
  try {
    origin = requestOrigin(await headers(), env.AUTH_URL);
  } catch {
    origin = env.AUTH_URL ? new URL(env.AUTH_URL).origin : null;
  }
  return googleEnabledFor(env, origin);
}

/**
 * On login, drop whatever session this browser was already carrying. Auth.js
 * always issues a fresh session token at login; this also makes sure the old
 * one stops working instead of living on until it expires.
 */
async function revokeIncomingSession(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  try {
    const jar = await cookies();
    const old = SESSION_COOKIE_NAMES.map((n) => jar.get(n)?.value).filter((v): v is string => Boolean(v));
    if (old.length > 0) await db.delete(sessions).where(inArray(sessions.sessionToken, old));
  } catch {
    // No request scope (e.g. called outside a request): nothing to revoke.
  }
}

/** Secret for hashing IPs, separated from the Auth.js signing use. */
export function ipHashSecret(): string {
  return `${getEnv().AUTH_SECRET}:ip-hash`;
}

/**
 * Auth.js v5, configured lazily so env validation and the DB connection
 * happen at request time, not at build time.
 *
 * Sessions: database strategy. Every login creates a brand-new session row and
 * cookie (session rotation). Cookies are httpOnly, SameSite=Lax, and Secure
 * with the __Secure- prefix on HTTPS. Auth.js keeps its CSRF double-submit
 * check on for all its POST endpoints.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const env = getEnv();
  const db = await getDb();
  const deployed = env.APP_ENV === "preview" || env.APP_ENV === "production";

  const providers: Provider[] = [
    Resend({
      apiKey: env.AUTH_RESEND_KEY,
      from: env.EMAIL_FROM,
      maxAge: MAGIC_LINK_MAX_AGE_SEC,
      sendVerificationRequest: ({ identifier, url }) => sendMagicLink(env, identifier, url),
    }),
  ];
  // Registered only for origins whose redirect URI Google knows about, so a
  // request to /api/auth/signin/google on a preview URL fails cleanly.
  if (await googleLoginAvailable()) {
    providers.push(
      Google({
        clientId: env.AUTH_GOOGLE_ID!,
        clientSecret: env.AUTH_GOOGLE_SECRET!,
        // Ask only for the email. We never read the name or picture.
        authorization: { params: { scope: "openid email" } },
        profile: (p) => ({ id: p.sub, email: p.email, name: null, image: null }),
      }),
    );
  }

  return {
    adapter: minimalAdapter(db),
    providers,
    secret: env.AUTH_SECRET,
    trustHost: true,
    useSecureCookies: deployed,
    session: { strategy: "database", maxAge: SESSION_MAX_AGE_SEC, updateAge: 24 * 60 * 60 },
    pages: { signIn: "/signin", verifyRequest: "/signin/check-email", error: "/signin/error" },
    callbacks: {
      async signIn({ user, account, profile, email }) {
        // Magic link requested: limit sends per address (the per-IP limit is in
        // the route handler and the sign-in server action).
        if (email?.verificationRequest && user.email) {
          const r = await checkLimit("loginEmail", user.email.toLowerCase());
          if (!r.success) {
            await audit(db, { actorId: null, actorType: "user", action: "auth.login_rate_limited", ip: await requestIp() }, ipHashSecret());
            return "/signin?error=RateLimited";
          }
        }
        // Only accept Google accounts whose email Google has verified.
        if (account?.provider === "google" && profile?.email_verified !== true) return false;
        // Deleted accounts stay deleted.
        if (user.id) {
          const [row] = await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, user.id)).limit(1);
          if (row?.deletedAt) return false;
        }
        return true;
      },
      session({ session, user }) {
        session.user.id = user.id;
        session.user.role = user.role;
        return session;
      },
    },
    events: {
      async signIn({ user, account, isNewUser }) {
        await revokeIncomingSession(db);
        await audit(
          db,
          {
            actorId: user.id ?? null,
            actorType: "user",
            action: "auth.login",
            ip: await requestIp(),
            meta: { provider: account?.provider ?? "unknown", newUser: Boolean(isNewUser) },
          },
          ipHashSecret(),
        );
      },
      async signOut(message) {
        const userId = "session" in message && message.session ? message.session.userId : null;
        await audit(db, { actorId: userId, actorType: "user", action: "auth.logout", ip: await requestIp() }, ipHashSecret());
      },
    },
  };
});
