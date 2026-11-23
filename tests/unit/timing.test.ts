import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { timePool, timed, withServerTiming } from "@/lib/timing";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("Server-Timing (preview load test only)", () => {
  it("is off unless SERVER_TIMING=1, and never on in production", async () => {
    const plain = await withServerTiming(async () => Response.json({ ok: true }));
    expect(plain.headers.get("server-timing")).toBeNull();
    vi.stubEnv("SERVER_TIMING", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    const prod = await withServerTiming(async () => Response.json({ ok: true }));
    expect(prod.headers.get("server-timing")).toBeNull();
  });

  it("splits a request into rate-limit calls, database queries and the total", async () => {
    vi.stubEnv("SERVER_TIMING", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const pool = {
      query: async (text: unknown) => ({ rows: [text] }),
      connect: async () => ({ query: async () => ({ rows: [] }) }),
    };
    timePool(pool);
    const res = await withServerTiming(async () => {
      await pool.query("select 1");
      const client = (await pool.connect()) as { query: (t: string) => Promise<unknown> };
      await client.query("select 2");
      await timed("rl", async () => "limit check 1");
      await timed("rl", async () => "limit check 2");
      return Response.json({ ok: true }, { status: 201 });
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    const h = res.headers.get("server-timing") ?? "";
    expect(h).toMatch(/^rl;dur=[\d.]+;desc="2 calls", db;dur=[\d.]+;desc="2 queries", total;dur=[\d.]+(, cold)?$/);
    // Only an instance's first request is its cold start.
    const next = await withServerTiming(async () => new Response("ok"));
    expect(next.headers.get("server-timing")).not.toContain("cold");
  });
});

describe("Server-Timing counts each query once", () => {
  it("doesn't count a client query nested inside a pool query, but counts parallel ones", async () => {
    vi.stubEnv("SERVER_TIMING", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const client = { query: async () => ({ rows: [] }) };
    const pool = {
      // Like pg: pool.query borrows a client and runs client.query on it.
      query: async () => {
        const c = (await pool.connect()) as typeof client;
        return c.query();
      },
      connect: async () => client,
    };
    timePool(pool);
    const res = await withServerTiming(async () => {
      await Promise.all([pool.query(), pool.query(), pool.query()]);
      return new Response("ok");
    });
    expect(res.headers.get("server-timing")).toContain('desc="3 queries"');
  });
});
