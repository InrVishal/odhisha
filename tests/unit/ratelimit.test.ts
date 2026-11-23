import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import {
  policyFor,
  checkLimit,
  getLimiter,
  MemoryLimiter,
  POLICIES,
  resetLimiters,
  retryAfterSeconds,
  tooManyRequests,
} from "@/lib/ratelimit";

describe("MemoryLimiter", () => {
  it("allows up to max per window, then blocks, then resets", async () => {
    let now = 1_000_000;
    const l = new MemoryLimiter({ max: 3, windowSec: 60 }, () => now);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await l.limit("k"));
    expect(results.map((r) => r.success)).toEqual([true, true, true, false]);
    expect(results[3]!.remaining).toBe(0);

    // Other keys are independent.
    expect((await l.limit("other")).success).toBe(true);

    now += 60_000;
    expect((await l.limit("k")).success).toBe(true);
  });
});

describe("429 response", () => {
  it("has status 429 and a Retry-After in whole seconds", async () => {
    const reset = Date.now() + 42_500;
    const res = tooManyRequests({ success: false, limit: 5, remaining: 0, reset });
    expect(res.status).toBe(429);
    const ra = Number(res.headers.get("retry-after"));
    expect(ra).toBeGreaterThanOrEqual(42);
    expect(ra).toBeLessThanOrEqual(43);
    expect(res.headers.get("ratelimit-limit")).toBe("5");
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  it("Retry-After is at least 1 second", () => {
    expect(retryAfterSeconds({ success: false, limit: 1, remaining: 0, reset: 0 }, 10_000)).toBe(1);
  });
});

describe("policies", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "pglite:memory");
    vi.stubEnv("AUTH_SECRET", "x".repeat(40));
    vi.stubEnv("CRON_SECRET", "x".repeat(40));
    resetEnvCache();
    resetLimiters();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
    resetLimiters();
  });

  it("cover every surface the spec requires", () => {
    for (const name of ["loginIp", "loginEmail", "waitlistIp", "quoteUser", "jobSubmitUser", "agentNode"]) {
      expect(POLICIES).toHaveProperty(name);
    }
  });

  it("blocks login after the policy max", async () => {
    const max = POLICIES.loginEmail.max;
    for (let i = 0; i < max; i++) expect((await checkLimit("loginEmail", "a@b.in")).success).toBe(true);
    expect((await checkLimit("loginEmail", "a@b.in")).success).toBe(false);
  });

  it("reuses one limiter per policy", () => {
    expect(getLimiter("quoteUser")).toBe(getLimiter("quoteUser"));
    expect(getLimiter("quoteUser")).not.toBe(getLimiter("jobSubmitUser"));
  });
});

describe("upstash backend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
    resetLimiters();
  });

  it("is used when configured (constructed without contacting Redis)", () => {
    vi.stubEnv("DATABASE_URL", "pglite:memory");
    vi.stubEnv("AUTH_SECRET", "x".repeat(40));
    vi.stubEnv("CRON_SECRET", "x".repeat(40));
    vi.stubEnv("RATE_LIMIT_BACKEND", "upstash");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok");
    resetEnvCache();
    resetLimiters();
    const l = getLimiter("agentNode");
    expect(l).not.toBeInstanceOf(MemoryLimiter);
    expect(typeof l.limit).toBe("function");
  });
});

describe("AGENT_IP_LIMIT_PER_MIN (preview load test only)", () => {
  it("raises only the per-IP agent limit, and never in production", () => {
    const preview = { APP_ENV: "preview" as const, AGENT_IP_LIMIT_PER_MIN: 100_000 };
    expect(policyFor("agentIp", preview)).toEqual({ max: 100_000, windowSec: 60 });
    for (const other of ["agentNode", "quoteUser", "jobSubmitUser", "loginIp", "accountUser"] as const) {
      expect(policyFor(other, preview)).toEqual(POLICIES[other]);
    }
    expect(policyFor("agentIp", { ...preview, APP_ENV: "production" })).toEqual(POLICIES.agentIp);
    expect(policyFor("agentIp", { APP_ENV: "preview", AGENT_IP_LIMIT_PER_MIN: undefined })).toEqual(POLICIES.agentIp);
  });
});
