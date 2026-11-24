import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { checkRedisOwner, judgeDatabase, neonEndpointId, REDIS_OWNER_KEY, type OwnerStore } from "@/lib/isolation";
import { setOpsAlertSink } from "@/lib/ops-alert";
import { checkLimit, LIMIT_TIMEOUT_MS, resetLimiters } from "@/lib/ratelimit";

function store(initial?: string): OwnerStore & { data: Map<string, string>; calls: number } {
  const data = new Map<string, string>();
  if (initial) data.set(REDIS_OWNER_KEY, initial);
  return {
    data,
    calls: 0,
    async set(key, value) {
      this.calls++;
      if (data.has(key)) return null;
      data.set(key, value);
      return "OK";
    },
    async get(key) {
      this.calls++;
      return data.get(key) ?? null;
    },
  };
}

describe("Redis owner marker (preview and production never share a Redis)", () => {
  it("the first environment to use a Redis claims it; the same environment passes after that", async () => {
    const s = store();
    expect(await checkRedisOwner(s, "preview")).toEqual({ ok: true, owner: "preview" });
    expect(s.data.get(REDIS_OWNER_KEY)).toBe("preview");
    expect(await checkRedisOwner(s, "preview")).toEqual({ ok: true, owner: "preview" });
  });

  it("the other environment is refused, in both directions", async () => {
    const prod = await checkRedisOwner(store("production"), "preview");
    expect(prod.ok).toBe(false);
    expect(prod.owner).toBe("production");
    const prev = await checkRedisOwner(store("preview"), "production");
    expect(prev.ok).toBe(false);
  });

  it("costs at most two commands", async () => {
    const s = store("production");
    await checkRedisOwner(s, "production");
    expect(s.calls).toBeLessThanOrEqual(2);
  });
});

describe("Database marker (production's Neon endpoint id)", () => {
  it("reads the endpoint id from pooled and direct Neon URLs alike; nothing for other hosts", () => {
    expect(neonEndpointId("postgresql://u:p@ep-cool-river-123456-pooler.c-2.us-east-2.aws.neon.tech/db?sslmode=require")).toBe("ep-cool-river-123456");
    expect(neonEndpointId("postgresql://u:p@ep-cool-river-123456.c-2.us-east-2.aws.neon.tech/db")).toBe("ep-cool-river-123456");
    expect(neonEndpointId("postgresql://u:p@localhost:5432/db")).toBeNull();
    expect(neonEndpointId("pglite:memory")).toBeNull();
    expect(neonEndpointId("postgresql://u:p@ep-x.evil.example/db")).toBeNull();
    expect(neonEndpointId(undefined)).toBeNull();
  });

  it("a preview on production's endpoint is refused; a preview branch (its own endpoint) passes", () => {
    expect(judgeDatabase("preview", "ep-prod", "ep-prod").ok).toBe(false);
    expect(judgeDatabase("preview", "ep-branch", "ep-prod").ok).toBe(true);
  });

  it("production on anything but the marked endpoint is flagged", () => {
    expect(judgeDatabase("production", "ep-prod", "ep-prod").ok).toBe(true);
    expect(judgeDatabase("production", "ep-branch", "ep-prod").ok).toBe(false);
  });

  it("no marker or no Neon endpoint: nothing to compare, passes", () => {
    expect(judgeDatabase("preview", "ep-x", null).ok).toBe(true);
    expect(judgeDatabase("production", null, "ep-prod").ok).toBe(true);
  });
});

describe("a slow Redis is a failure, not a pass", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
    resetLimiters();
    setOpsAlertSink(null);
    vi.restoreAllMocks();
  });

  it(`a limit check that hangs is refused (fail-closed) after ${LIMIT_TIMEOUT_MS} ms, not let through`, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("DATABASE_URL", "pglite:memory");
    vi.stubEnv("AUTH_SECRET", "x".repeat(40));
    vi.stubEnv("CRON_SECRET", "x".repeat(40));
    vi.stubEnv("RATE_LIMIT_BACKEND", "upstash");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok");
    resetEnvCache();
    resetLimiters();
    setOpsAlertSink(async () => {});
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    try {
      const t0 = Date.now();
      const r = await checkLimit("loginIp", "1.2.3.4");
      expect(r).toMatchObject({ success: false, unavailable: true });
      expect(Date.now() - t0).toBeLessThan(LIMIT_TIMEOUT_MS + 1000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
