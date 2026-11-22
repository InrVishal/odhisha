import { createPrivateKey } from "node:crypto";
import { z } from "zod";

/**
 * Server environment, validated with Zod.
 *
 * - `getEnv()` parses lazily and caches, so `next build` can import modules
 *   without production secrets present.
 * - `instrumentation.ts` calls `getEnv()` at server boot, so a bad config
 *   fails the deploy immediately instead of on the first request.
 * - Nothing in here may be exposed to the browser. Client code must never
 *   import this file (it imports "server-only" indirectly via callers).
 */

const appEnvs = ["development", "test", "preview", "production"] as const;
export type AppEnv = (typeof appEnvs)[number];

const base64Bytes = (bytes: number) =>
  z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === bytes;
      } catch {
        return false;
      }
    }, `must be ${bytes} bytes, base64-encoded`);

function isEd25519PrivateKey(v: string): boolean {
  try {
    return createPrivateKey({ key: Buffer.from(v, "base64"), format: "der", type: "pkcs8" }).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

const optionalNonEmpty = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

export const envSchema = z
  .object({
    APP_ENV: z.enum(appEnvs),

    // Postgres. `pglite:<dir>` runs an in-process Postgres for local dev and
    // tests only. Preview/production must use a real postgres:// URL (Neon).
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith("postgres://") || v.startsWith("postgresql://") || v.startsWith("pglite:"),
        "must be a postgres:// URL or pglite:<dir>",
      ),

    // Auth.js
    AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    AUTH_URL: z.url().optional(),
    AUTH_GOOGLE_ID: optionalNonEmpty,
    AUTH_GOOGLE_SECRET: optionalNonEmpty,
    // Origins whose /api/auth/callback/google redirect URI is registered in
    // Google Cloud Console, comma-separated (e.g. "http://localhost:3000,https://nightshift.in").
    // Google rejects wildcard redirect URIs, so Vercel preview URLs can never
    // be on this list. Google login is hidden and refused everywhere else.
    AUTH_GOOGLE_REDIRECT_ORIGINS: z
      .string()
      .default("")
      .transform((v, ctx) => {
        const origins: string[] = [];
        for (const raw of v.split(",").map((s) => s.trim()).filter(Boolean)) {
          try {
            origins.push(new URL(raw).origin);
          } catch {
            ctx.addIssue({ code: "custom", message: `"${raw}" is not a URL` });
          }
        }
        return origins;
      }),

    // Magic-link email. "console" prints the link to the server log and is
    // refused outside development/test.
    EMAIL_TRANSPORT: z.enum(["resend", "console"]).default("console"),
    AUTH_RESEND_KEY: optionalNonEmpty,
    EMAIL_FROM: z.string().min(3).default("NightShift <login@example.com>"),

    // Rate limiting. "memory" is per-process and refused outside dev/test.
    RATE_LIMIT_BACKEND: z.enum(["upstash", "memory"]).default("memory"),
    UPSTASH_REDIS_REST_URL: z.url().optional(),
    UPSTASH_REDIS_REST_TOKEN: optionalNonEmpty,

    // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
    CRON_SECRET: z.string().min(32, "must be at least 32 characters"),

    // Ed25519 private key (PKCS#8 DER, base64) used to sign agent tasks.
    // Required in preview/production. Dev and tests use a random key per
    // process when unset (lib/security/keys.ts).
    COORDINATOR_SIGNING_KEY: optionalNonEmpty.pipe(
      z
        .string()
        .refine(isEd25519PrivateKey, "must be an Ed25519 private key (PKCS#8 DER, base64)")
        .optional(),
    ),
    // 32-byte AES-256 key (base64) that wraps per-fragment data keys.
    // Required in preview/production, same dev/test fallback as above.
    DATA_ENCRYPTION_KEY: optionalNonEmpty.pipe(base64Bytes(32).optional()),

    SENTRY_DSN: z.url().optional(),

    /** Public contact for privacy requests (DPDP). Shown on /privacy when set. */
    CONTACT_EMAIL: optionalNonEmpty.pipe(z.email().optional()),

    /** Canonical site URL for metadata, robots and sitemap. */
    SITE_URL: z.url().optional(),

    // Payments, UPI payouts and EMI are always simulated in this prototype.
    DEMO_MODE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
  })
  .superRefine((e, ctx) => {
    const deployed = e.APP_ENV === "preview" || e.APP_ENV === "production";

    if (Boolean(e.AUTH_GOOGLE_ID) !== Boolean(e.AUTH_GOOGLE_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_GOOGLE_SECRET"],
        message: "set both AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET, or neither",
      });
    }
    if (e.AUTH_GOOGLE_ID && e.AUTH_GOOGLE_REDIRECT_ORIGINS.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_GOOGLE_REDIRECT_ORIGINS"],
        message: "list the origins registered in Google Cloud Console, or unset AUTH_GOOGLE_ID",
      });
    }
    if (e.EMAIL_TRANSPORT === "resend" && !e.AUTH_RESEND_KEY) {
      ctx.addIssue({ code: "custom", path: ["AUTH_RESEND_KEY"], message: "required when EMAIL_TRANSPORT=resend" });
    }
    if (e.RATE_LIMIT_BACKEND === "upstash" && (!e.UPSTASH_REDIS_REST_URL || !e.UPSTASH_REDIS_REST_TOKEN)) {
      ctx.addIssue({
        code: "custom",
        path: ["UPSTASH_REDIS_REST_URL"],
        message: "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required when RATE_LIMIT_BACKEND=upstash",
      });
    }

    if (deployed) {
      if (e.DATABASE_URL.startsWith("pglite:")) {
        ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "pglite is for local dev/test only" });
      }
      if (e.EMAIL_TRANSPORT !== "resend") {
        ctx.addIssue({ code: "custom", path: ["EMAIL_TRANSPORT"], message: "must be 'resend' in preview/production" });
      }
      if (!e.COORDINATOR_SIGNING_KEY) {
        ctx.addIssue({ code: "custom", path: ["COORDINATOR_SIGNING_KEY"], message: "required in preview/production" });
      }
      if (!e.DATA_ENCRYPTION_KEY) {
        ctx.addIssue({ code: "custom", path: ["DATA_ENCRYPTION_KEY"], message: "required in preview/production" });
      }
      if (e.RATE_LIMIT_BACKEND !== "upstash") {
        ctx.addIssue({ code: "custom", path: ["RATE_LIMIT_BACKEND"], message: "must be 'upstash' in preview/production" });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Secret-looking names that must never be shipped to the browser. */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE|_KEY$|^KEY_|DSN|DATABASE)/i;

export function findLeakedPublicSecrets(source: Record<string, string | undefined>): string[] {
  return Object.keys(source).filter((k) => k.startsWith("NEXT_PUBLIC_") && SECRET_NAME.test(k));
}

export function resolveAppEnv(source: Record<string, string | undefined>): AppEnv {
  if (source.APP_ENV && (appEnvs as readonly string[]).includes(source.APP_ENV)) {
    return source.APP_ENV as AppEnv;
  }
  if (source.VERCEL_ENV === "production") return "production";
  if (source.VERCEL_ENV === "preview") return "preview";
  if (source.NODE_ENV === "test") return "test";
  return "development";
}

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvError";
  }
}

/**
 * Fills in names used by Vercel Marketplace integrations and per-environment
 * defaults, without overriding anything set explicitly.
 * - Upstash via Vercel Marketplace provides KV_REST_API_URL / KV_REST_API_TOKEN.
 * - Deployed environments default to the real backends (Resend, Upstash).
 */
export function withDefaults(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const appEnv = resolveAppEnv(source);
  const deployed = appEnv === "preview" || appEnv === "production";
  return {
    ...source,
    APP_ENV: appEnv,
    UPSTASH_REDIS_REST_URL: source.UPSTASH_REDIS_REST_URL || source.KV_REST_API_URL || undefined,
    UPSTASH_REDIS_REST_TOKEN: source.UPSTASH_REDIS_REST_TOKEN || source.KV_REST_API_TOKEN || undefined,
    EMAIL_TRANSPORT: source.EMAIL_TRANSPORT || (deployed ? "resend" : "console"),
    RATE_LIMIT_BACKEND: source.RATE_LIMIT_BACKEND || (deployed ? "upstash" : "memory"),
  };
}

/** Pure parser, exported for tests. Never logs values, only names. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const leaked = findLeakedPublicSecrets(source);
  const result = envSchema.safeParse(withDefaults(source));
  const issues = [
    ...leaked.map((k) => `${k}: secret-looking variable must not use the NEXT_PUBLIC_ prefix`),
    ...(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)),
  ];
  if (issues.length > 0 || !result.success) throw new EnvError(issues);
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper: forget the cached env so a test can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
