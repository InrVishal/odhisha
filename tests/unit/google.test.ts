import { describe, expect, it } from "vitest";
import { googleEnabledFor, requestOrigin } from "@/lib/auth/google";
import { parseEnv } from "@/lib/env";

const base = { DATABASE_URL: "pglite:memory", AUTH_SECRET: "x".repeat(40), CRON_SECRET: "x".repeat(40) };
const withGoogle = parseEnv({
  ...base,
  AUTH_GOOGLE_ID: "id",
  AUTH_GOOGLE_SECRET: "secret",
  AUTH_GOOGLE_REDIRECT_ORIGINS: "http://localhost:3000, https://nightshift.example/",
});

describe("requestOrigin", () => {
  it("prefers AUTH_URL when set", () => {
    expect(requestOrigin(new Headers({ host: "evil.test" }), "https://nightshift.example/x")).toBe("https://nightshift.example");
  });
  it("uses forwarded host and proto (Vercel)", () => {
    const h = new Headers({ "x-forwarded-host": "nightshift-git-pr-7.vercel.app", "x-forwarded-proto": "https", host: "internal" });
    expect(requestOrigin(h)).toBe("https://nightshift-git-pr-7.vercel.app");
  });
  it("defaults to http for localhost and https elsewhere", () => {
    expect(requestOrigin(new Headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(requestOrigin(new Headers({ host: "nightshift.example" }))).toBe("https://nightshift.example");
  });
  it("returns null without a usable host", () => {
    expect(requestOrigin(new Headers())).toBeNull();
    expect(requestOrigin(new Headers({ host: "bad host" }))).toBeNull();
  });
});

describe("googleEnabledFor", () => {
  it("is on only for registered origins", () => {
    expect(googleEnabledFor(withGoogle, "http://localhost:3000")).toBe(true);
    expect(googleEnabledFor(withGoogle, "https://nightshift.example")).toBe(true);
  });
  it("is off on Vercel preview URLs (Google has no wildcard redirects)", () => {
    expect(googleEnabledFor(withGoogle, "https://nightshift-git-pr-7.vercel.app")).toBe(false);
  });
  it("is off when Google isn't configured or the origin is unknown", () => {
    expect(googleEnabledFor(parseEnv(base), "http://localhost:3000")).toBe(false);
    expect(googleEnabledFor(withGoogle, null)).toBe(false);
  });
});

describe("env rules for Google", () => {
  it("requires redirect origins when Google is configured", () => {
    expect(() => parseEnv({ ...base, AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "s" })).toThrow(/AUTH_GOOGLE_REDIRECT_ORIGINS/);
  });
  it("rejects a non-URL origin", () => {
    expect(() =>
      parseEnv({ ...base, AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "s", AUTH_GOOGLE_REDIRECT_ORIGINS: "not a url" }),
    ).toThrow(/not a URL/);
  });
});
