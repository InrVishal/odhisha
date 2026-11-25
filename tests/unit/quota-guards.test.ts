import { describe, expect, it } from "vitest";
// @ts-expect-error: plain ES module script, no type declarations.
import { findSharing } from "../../scripts/check-env-isolation.mjs";
// @ts-expect-error: plain ES module script, no type declarations.
import { FREE_MONTHLY_COMMANDS, matchesHost, monthlyLimit } from "../../scripts/upstash-usage.mjs";
// @ts-expect-error: plain ES module script, no type declarations.
import { estimateCommands, judgeBudget, parseDuration } from "../../tools/load/upstash-budget.mjs";
// @ts-expect-error: plain ES module script, no type declarations.
import { parseEnvFile } from "../../tools/load/upstash-guard.mjs";

describe("Preview and Production share no Redis or database (Vercel variable list)", () => {
  it("refuses one Redis variable set for both environments: the 2026-11-24 setup", () => {
    const envs = [
      { key: "KV_REST_API_URL", target: ["production", "preview"], contentHint: { storeId: "store_a" } },
      { key: "DATABASE_URL", target: ["production"] },
    ];
    const problems = findSharing(envs) as string[];
    expect(problems.some((p) => p.includes("KV_REST_API_URL is one variable set for both"))).toBe(true);
  });

  it("refuses two variables, one per environment, from the same store", () => {
    const envs = [
      { key: "KV_REST_API_URL", target: ["production"], contentHint: { storeId: "store_a" } },
      { key: "KV_REST_API_URL", target: ["preview"], contentHint: { storeId: "store_a" } },
    ];
    expect(findSharing(envs)).toEqual(["KV_REST_API_URL: Preview and Production use the same store"]);
  });

  it("passes separate stores per environment, and ignores unrelated variables", () => {
    const envs = [
      { key: "KV_REST_API_URL", target: ["production"], contentHint: { storeId: "store_prod" } },
      { key: "KV_REST_API_URL", target: ["preview", "development"], contentHint: { storeId: "store_preview" } },
      { key: "AUTH_SECRET", target: ["production", "preview"] },
      { key: "DATABASE_URL", target: ["production"] },
    ];
    expect(findSharing(envs)).toEqual([]);
  });

  it("reads a single-string target too", () => {
    expect(findSharing([{ key: "REDIS_URL", target: "production" }])).toEqual([]);
  });
});

describe("Upstash usage", () => {
  it("uses a database's own stated limit, else the free plan's 500,000 a month", () => {
    expect(monthlyLimit({ db_request_limit: 500000 })).toBe(500000);
    expect(monthlyLimit({ db_request_limit: 8024278031528737000 })).toBe(FREE_MONTHLY_COMMANDS);
    expect(monthlyLimit({})).toBe(FREE_MONTHLY_COMMANDS);
  });

  it("matches a REST URL to its database by endpoint (slug or full host), not by a prefix of another name", () => {
    expect(matchesHost({ endpoint: "beloved-stallion-58500" }, "https://beloved-stallion-58500.upstash.io")).toBe(true);
    expect(matchesHost({ endpoint: "beloved-stallion-58500.upstash.io" }, "https://beloved-stallion-58500.upstash.io")).toBe(true);
    expect(matchesHost({ endpoint: "beloved-stallion-5850" }, "https://beloved-stallion-58500.upstash.io")).toBe(false);
    expect(matchesHost({ endpoint: "" }, "https://x.upstash.io")).toBe(false);
  });
});

describe("load-test Upstash budget (at most 25% of what's left this month)", () => {
  it("estimates a full run (200 users, 3 minutes) at about 100-120k commands", () => {
    const n = estimateCommands({ vus: 200, duration: "3m" }) as number;
    expect(n).toBeGreaterThan(100_000);
    expect(n).toBeLessThan(125_000);
    expect(parseDuration("3m")).toBe(180);
    expect(parseDuration("90s")).toBe(90);
  });

  it("allows a full run on a fresh free database, refuses once less than 4x the estimate is left", () => {
    const estimate = estimateCommands({ vus: 200, duration: "3m" }) as number;
    expect(judgeBudget({ estimate, used: 0, limit: 500_000 }).ok).toBe(true);
    expect(judgeBudget({ estimate, used: 500_000 - estimate * 4 + 1, limit: 500_000 }).ok).toBe(false);
    expect(judgeBudget({ estimate, used: 600_000, limit: 500_000 })).toMatchObject({ remaining: 0, allowed: 0, ok: false });
  });

  it("reads the pulled env file without needing the values printed", () => {
    expect(parseEnvFile('KV_REST_API_URL="https://a.upstash.io"\nKV_REST_API_TOKEN="t\\"k"\n# comment\n')).toEqual({ KV_REST_API_URL: "https://a.upstash.io", KV_REST_API_TOKEN: 't"k' });
  });
});
