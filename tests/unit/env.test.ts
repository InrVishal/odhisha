import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvError, findLeakedPublicSecrets, parseEnv, resolveAppEnv } from "@/lib/env";

const SECRET = "x".repeat(40);

const devEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "pglite:./.pglite",
  AUTH_SECRET: SECRET,
  CRON_SECRET: SECRET,
};

const ED25519 = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const DATA_KEY = Buffer.alloc(32, 7).toString("base64");

const prodEnv = {
  VERCEL_ENV: "production",
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/db?sslmode=require",
  AUTH_SECRET: SECRET,
  CRON_SECRET: SECRET,
  EMAIL_TRANSPORT: "resend",
  AUTH_RESEND_KEY: "re_test",
  RATE_LIMIT_BACKEND: "upstash",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "tok",
  COORDINATOR_SIGNING_KEY: ED25519,
  DATA_ENCRYPTION_KEY: DATA_KEY,
};

function issuesOf(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
    return [];
  } catch (e) {
    if (e instanceof EnvError) return e.issues;
    throw e;
  }
}

describe("parseEnv", () => {
  it("accepts a minimal local dev config with safe defaults", () => {
    const env = parseEnv(devEnv);
    expect(env.APP_ENV).toBe("development");
    expect(env.EMAIL_TRANSPORT).toBe("console");
    expect(env.RATE_LIMIT_BACKEND).toBe("memory");
    expect(env.DEMO_MODE).toBe(true);
  });

  it("accepts a full production config", () => {
    const env = parseEnv(prodEnv);
    expect(env.APP_ENV).toBe("production");
  });

  it("rejects short secrets", () => {
    expect(issuesOf({ ...devEnv, AUTH_SECRET: "short" }).join()).toMatch(/AUTH_SECRET/);
    expect(issuesOf({ ...devEnv, CRON_SECRET: "short" }).join()).toMatch(/CRON_SECRET/);
  });

  it("rejects a missing or non-postgres database URL", () => {
    expect(issuesOf({ ...devEnv, DATABASE_URL: undefined }).join()).toMatch(/DATABASE_URL/);
    expect(issuesOf({ ...devEnv, DATABASE_URL: "mysql://x" }).join()).toMatch(/DATABASE_URL/);
  });

  it.each(["preview", "production"])("refuses dev-only backends in %s", (vercelEnv) => {
    const issues = issuesOf({
      ...prodEnv,
      VERCEL_ENV: vercelEnv,
      DATABASE_URL: "pglite:./x",
      EMAIL_TRANSPORT: "console",
      RATE_LIMIT_BACKEND: "memory",
    }).join("\n");
    expect(issues).toMatch(/DATABASE_URL: pglite/);
    expect(issues).toMatch(/EMAIL_TRANSPORT/);
    expect(issues).toMatch(/RATE_LIMIT_BACKEND/);
  });

  it("requires credentials for the backends you pick", () => {
    expect(issuesOf({ ...devEnv, EMAIL_TRANSPORT: "resend" }).join()).toMatch(/AUTH_RESEND_KEY/);
    expect(issuesOf({ ...devEnv, RATE_LIMIT_BACKEND: "upstash" }).join()).toMatch(/UPSTASH/);
    expect(issuesOf({ ...devEnv, AUTH_GOOGLE_ID: "id" }).join()).toMatch(/AUTH_GOOGLE_SECRET/);
  });

  it("treats empty optional strings as unset", () => {
    const env = parseEnv({ ...devEnv, AUTH_GOOGLE_ID: "", AUTH_GOOGLE_SECRET: "" });
    expect(env.AUTH_GOOGLE_ID).toBeUndefined();
  });

  it("refuses SERVER_TIMING=1 in production; allows it on a preview (load test)", () => {
    expect(issuesOf({ ...prodEnv, SERVER_TIMING: "1" }).join()).toMatch(/SERVER_TIMING/);
    expect(parseEnv({ ...prodEnv, VERCEL_ENV: "preview", SERVER_TIMING: "1" }).SERVER_TIMING).toBe("1");
  });

  it("refuses AGENT_IP_LIMIT_PER_MIN in production; allows it on a preview (load test)", () => {
    expect(issuesOf({ ...prodEnv, AGENT_IP_LIMIT_PER_MIN: "100000" }).join()).toMatch(/AGENT_IP_LIMIT_PER_MIN/);
    expect(parseEnv({ ...prodEnv, VERCEL_ENV: "preview", AGENT_IP_LIMIT_PER_MIN: "100000" }).AGENT_IP_LIMIT_PER_MIN).toBe(100_000);
  });

  it.each(["preview", "production"])("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 in %s (it would turn off certificate checks)", (vercelEnv) => {
    expect(issuesOf({ ...prodEnv, VERCEL_ENV: vercelEnv, NODE_TLS_REJECT_UNAUTHORIZED: "0" }).join()).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(issuesOf({ ...prodEnv, VERCEL_ENV: vercelEnv, NODE_TLS_REJECT_UNAUTHORIZED: "1" })).toEqual([]);
  });

  it("requires both coordinator keys in preview and production, not in dev", () => {
    const noKeys: Record<string, string | undefined> = { ...prodEnv, COORDINATOR_SIGNING_KEY: undefined, DATA_ENCRYPTION_KEY: undefined };
    const issues = issuesOf(noKeys).join();
    expect(issues).toMatch(/COORDINATOR_SIGNING_KEY: required/);
    expect(issues).toMatch(/DATA_ENCRYPTION_KEY: required/);
    expect(issuesOf({ ...noKeys, VERCEL_ENV: "preview" }).join()).toMatch(/COORDINATOR_SIGNING_KEY/);
    expect(() => parseEnv(devEnv)).not.toThrow();
  });

  it("accepts only an Ed25519 PKCS#8 key for COORDINATOR_SIGNING_KEY", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(() => parseEnv({ ...devEnv, COORDINATOR_SIGNING_KEY: ED25519 })).not.toThrow();
    expect(issuesOf({ ...devEnv, COORDINATOR_SIGNING_KEY: rsa }).join()).toMatch(/Ed25519/);
    expect(issuesOf({ ...devEnv, COORDINATOR_SIGNING_KEY: Buffer.from("not a key").toString("base64") }).join()).toMatch(/Ed25519/);
  });

  it("checks DATA_ENCRYPTION_KEY is exactly 32 bytes", () => {
    expect(() => parseEnv({ ...devEnv, DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") })).not.toThrow();
    expect(issuesOf({ ...devEnv, DATA_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }).join()).toMatch(
      /DATA_ENCRYPTION_KEY/,
    );
  });

  it("never includes secret values in error messages", () => {
    const issues = issuesOf({ ...devEnv, AUTH_SECRET: "hunter2" }).join("\n");
    expect(issues).not.toContain("hunter2");
  });

  it("refuses secret-looking NEXT_PUBLIC_ variables", () => {
    expect(issuesOf({ ...devEnv, NEXT_PUBLIC_STRIPE_SECRET: "x" }).join()).toMatch(/NEXT_PUBLIC_STRIPE_SECRET/);
    expect(findLeakedPublicSecrets({ NEXT_PUBLIC_APP_NAME: "x", NEXT_PUBLIC_API_KEY: "y", NEXT_PUBLIC_DSN: "z" })).toEqual([
      "NEXT_PUBLIC_API_KEY",
      "NEXT_PUBLIC_DSN",
    ]);
  });
});

describe("resolveAppEnv", () => {
  it("maps Vercel and Node environments", () => {
    expect(resolveAppEnv({ VERCEL_ENV: "production" })).toBe("production");
    expect(resolveAppEnv({ VERCEL_ENV: "preview" })).toBe("preview");
    expect(resolveAppEnv({ NODE_ENV: "test" })).toBe("test");
    expect(resolveAppEnv({})).toBe("development");
    expect(resolveAppEnv({ APP_ENV: "preview", VERCEL_ENV: "production" })).toBe("preview");
    expect(resolveAppEnv({ APP_ENV: "nonsense", VERCEL_ENV: "preview" })).toBe("preview");
  });
});

describe("deployed defaults and Vercel Marketplace names", () => {
  it("defaults deployed environments to Resend and Upstash", () => {
    const env = parseEnv({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/db",
      AUTH_SECRET: SECRET,
      CRON_SECRET: SECRET,
      AUTH_RESEND_KEY: "re_k",
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "tok",
      COORDINATOR_SIGNING_KEY: ED25519,
      DATA_ENCRYPTION_KEY: DATA_KEY,
    });
    expect(env.EMAIL_TRANSPORT).toBe("resend");
    expect(env.RATE_LIMIT_BACKEND).toBe("upstash");
    expect(env.UPSTASH_REDIS_REST_URL).toBe("https://example.upstash.io");
    expect(env.UPSTASH_REDIS_REST_TOKEN).toBe("tok");
  });

  it("explicit UPSTASH_* values win over KV_*", () => {
    const env = parseEnv({ ...prodEnv, KV_REST_API_URL: "https://other.upstash.io" });
    expect(env.UPSTASH_REDIS_REST_URL).toBe("https://example.upstash.io");
  });
});

describe("admin allowlist and database TLS (Phase 8)", () => {
  it("ADMIN_EMAILS is a lower-cased list; empty means nobody is an admin", () => {
    expect(parseEnv(devEnv).ADMIN_EMAILS).toEqual([]);
    expect(parseEnv({ ...devEnv, ADMIN_EMAILS: " Me@Example.in , you@example.in " }).ADMIN_EMAILS).toEqual(["me@example.in", "you@example.in"]);
    expect(issuesOf({ ...devEnv, ADMIN_EMAILS: "me@example.in, not-an-email" }).join()).toMatch(/ADMIN_EMAILS/);
  });

  it("an ADMIN_ variable can't be NEXT_PUBLIC_ (it would ship to the browser)", () => {
    expect(issuesOf({ ...devEnv, NEXT_PUBLIC_ADMIN_EMAILS: "me@example.in" }).join()).toMatch(/NEXT_PUBLIC_ADMIN_EMAILS/);
  });

  it("deployed: the database connection must verify the server certificate", () => {
    expect(issuesOf(prodEnv)).toEqual([]);
    // Neon: wss://, verified by Node. Anything else needs sslmode=verify-full.
    expect(issuesOf({ ...prodEnv, DATABASE_URL: "postgresql://u:p@db.example.com/db" }).join()).toMatch(/DATABASE_URL: must use TLS/);
    expect(issuesOf({ ...prodEnv, DATABASE_URL: "postgresql://u:p@db.example.com/db?sslmode=require" }).join()).toMatch(/DATABASE_URL: must use TLS/);
    expect(issuesOf({ ...prodEnv, DATABASE_URL: "postgresql://u:p@db.example.com/db?sslmode=verify-full" })).toEqual([]);
    expect(issuesOf({ ...prodEnv, DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/db?sslmode=disable" }).join()).toMatch(/DATABASE_URL: must use TLS/);
    expect(issuesOf({ ...prodEnv, DATABASE_URL_READONLY: "postgresql://r:p@db.example.com/db" }).join()).toMatch(/DATABASE_URL_READONLY: must use TLS/);
    // Local dev is unaffected.
    expect(issuesOf({ ...devEnv, DATABASE_URL: "postgres://postgres:postgres@localhost:5432/x" })).toEqual([]);
  });
});
