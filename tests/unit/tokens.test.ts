import { describe, expect, it } from "vitest";
import {
  clientIp,
  generateNodeToken,
  hashIp,
  hashToken,
  isAuthorizedCron,
  isWellFormedNodeToken,
  safeEqual,
} from "@/lib/security/tokens";

describe("node tokens", () => {
  it("carry 256 bits of randomness and are unique", () => {
    const tokens = Array.from({ length: 500 }, generateNodeToken);
    expect(new Set(tokens).size).toBe(500);
    for (const t of tokens) {
      expect(isWellFormedNodeToken(t)).toBe(true);
      expect(Buffer.from(t.slice(4), "base64url")).toHaveLength(32);
    }
  });

  it("are stored as a SHA-256 hex hash that differs from the token", () => {
    const t = generateNodeToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t.slice(4, 20));
    expect(hashToken(t)).toBe(h);
  });

  it("rejects malformed tokens before any lookup", () => {
    for (const bad of ["", "nsn_", "nsn_short", `xyz_${"a".repeat(43)}`, `nsn_${"a".repeat(42)}!`, `nsn_${"a".repeat(44)}`]) {
      expect(isWellFormedNodeToken(bad)).toBe(false);
    }
  });
});

describe("cron auth", () => {
  const secret = "s".repeat(40);
  it("accepts only the exact bearer secret", () => {
    expect(isAuthorizedCron(`Bearer ${secret}`, secret)).toBe(true);
    expect(isAuthorizedCron(null, secret)).toBe(false);
    expect(isAuthorizedCron(secret, secret)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isAuthorizedCron("Bearer ", secret)).toBe(false);
  });
});

describe("helpers", () => {
  it("safeEqual compares correctly across lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("hashIp is keyed: same IP + key matches, other key differs", () => {
    expect(hashIp("1.2.3.4", "k1")).toBe(hashIp("1.2.3.4", "k1"));
    expect(hashIp("1.2.3.4", "k1")).not.toBe(hashIp("1.2.3.4", "k2"));
  });

  it("clientIp prefers x-real-ip, then the first x-forwarded-for hop", () => {
    expect(clientIp(new Headers({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers({ "x-forwarded-for": " 1.1.1.1 , 2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
