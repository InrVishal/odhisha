import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { setOpsAlertSink } from "@/lib/ops-alert";
import {
  FAIL_CLOSED,
  policyFor,
  withFallback,
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

describe("when the shared limiter fails (e.g. Upstash quota used up)", () => {
  const failing = async (): Promise<never> => {
    throw new Error("ERR max requests limit exceeded");
  };

  it("agent and buyer limits fall back to the instance's own counter: still limits, never throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const degraded = vi.fn();
    const p = POLICIES.agentNode;
    const l = withFallback("agentNode", failing, new MemoryLimiter(p), { failClosed: false, policy: p, onDegraded: degraded });
    const results = [];
    for (let i = 0; i < p.max + 1; i++) results.push((await l.limit("token:abc")).success);
    expect(results.slice(0, p.max).every(Boolean)).toBe(true);
    expect(results.at(-1)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toContain("token:abc");
    log.mockRestore();
  });

  it("sign-in, login email, waitlist and admin-code limits fail closed: refused as unavailable (503), not counted per instance", async () => {
    expect([...FAIL_CLOSED].sort()).toEqual(["adminMfaUser", "loginEmail", "loginIp", "waitlistIp"]);
    for (const name of ["agentNode", "agentIp", "quoteUser", "jobSubmitUser"] as const) expect(FAIL_CLOSED.has(name)).toBe(false);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const degraded = vi.fn();
    const p = POLICIES.loginEmail;
    const l = withFallback("loginEmail", failing, new MemoryLimiter(p), { failClosed: true, policy: p, onDegraded: degraded });
    const first = await l.limit("a@b.in");
    expect(first).toMatchObject({ success: false, unavailable: true });
    expect((await l.limit("a@b.in")).success).toBe(false);
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toContain("a@b.in");
    const res = tooManyRequests(first);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toMatchObject({ error: "unavailable" });
    log.mockRestore();
  });

  it("raises one owner alert per kind per instance (fail-closed and fallback are separate kinds)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("DATABASE_URL", "pglite:memory");
    vi.stubEnv("AUTH_SECRET", "x".repeat(40));
    vi.stubEnv("CRON_SECRET", "x".repeat(40));
    vi.stubEnv("RATE_LIMIT_BACKEND", "upstash");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok");
    resetEnvCache();
    resetLimiters();
    const alerts: string[] = [];
    setOpsAlertSink(async (kind) => {
      alerts.push(kind);
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    try {
      expect((await checkLimit("loginIp", "1.2.3.4")).unavailable).toBe(true);
      expect((await checkLimit("loginEmail", "a@b.in")).unavailable).toBe(true);
      expect((await checkLimit("agentNode", "token:x")).success).toBe(true);
      expect((await checkLimit("quoteUser", "u1")).success).toBe(true);
      expect(alerts.sort()).toEqual(["ratelimit_fail_closed", "ratelimit_fallback"]);
    } finally {
      globalThis.fetch = realFetch;
      setOpsAlertSink(null);
      vi.unstubAllEnvs();
      resetEnvCache();
      resetLimiters();
      vi.restoreAllMocks();
    }
  });
});

describe("AGENT_IP_LIMIT_PER_MIN (preview load test only)", () => {
  it("raises only the per-IP agent limit, and never in production", () => {
    const preview = { APP_ENV: "preview" as const, AGENT_IP_LIMIT_PER_MIN: 100_000 };
    // Counted per instance: never in Upstash (it can't fire at this size anyway).
    expect(policyFor("agentIp", preview)).toEqual({ max: 100_000, windowSec: 60, perInstance: true });
    for (const other of ["agentNode", "quoteUser", "jobSubmitUser", "loginIp", "accountUser"] as const) {
      expect(policyFor(other, preview)).toEqual(POLICIES[other]);
    }
    expect(policyFor("agentIp", { ...preview, APP_ENV: "production" })).toEqual(POLICIES.agentIp);
    expect(policyFor("agentIp", { APP_ENV: "preview", AGENT_IP_LIMIT_PER_MIN: undefined })).toEqual(POLICIES.agentIp);
  });
});
