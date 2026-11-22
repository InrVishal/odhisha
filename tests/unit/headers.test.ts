import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_CSP, buildPageCsp, generateNonce, STATIC_SECURITY_HEADERS } from "@/lib/security/headers";
import { proxy } from "@/proxy";

function directives(csp: string): Map<string, string> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...rest] = d.split(/\s+/);
        return [name!, rest.join(" ")];
      }),
  );
}

describe("page CSP", () => {
  const csp = buildPageCsp("abc123", "production");
  const d = directives(csp);

  it("never allows unsafe-inline or unsafe-eval in production", () => {
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("uses the nonce with strict-dynamic for scripts and styles", () => {
    expect(d.get("script-src")).toContain("'nonce-abc123'");
    expect(d.get("script-src")).toContain("'strict-dynamic'");
    expect(d.get("style-src")).toContain("'nonce-abc123'");
  });

  it("blocks framing, plugins and base-tag hijacking", () => {
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("object-src")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'self'");
    expect(d.get("form-action")).toBe("'self'");
    expect(d.has("upgrade-insecure-requests")).toBe(true);
  });

  it("only adds unsafe-eval in development", () => {
    expect(buildPageCsp("n", "development")).toContain("'unsafe-eval'");
    expect(buildPageCsp("n", "development")).not.toContain("unsafe-inline");
  });
});

describe("nonces", () => {
  it("are 128-bit and unique", () => {
    const seen = new Set(Array.from({ length: 200 }, generateNonce));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(Buffer.from(n, "base64")).toHaveLength(16);
  });
});

describe("proxy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sets every security header and a fresh nonce CSP on pages", () => {
    vi.stubEnv("NODE_ENV", "production");
    const a = proxy(new NextRequest("https://nightshift.test/pricing"));
    const b = proxy(new NextRequest("https://nightshift.test/pricing"));

    for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) expect(a.headers.get(k)).toBe(v);
    const cspA = a.headers.get("content-security-policy")!;
    const cspB = b.headers.get("content-security-policy")!;
    expect(cspA).toMatch(/'nonce-[A-Za-z0-9+/=]{24}'/);
    expect(cspA).not.toBe(cspB);
    expect(cspA).not.toContain("unsafe");
  });

  it("passes the same nonce to the renderer via request headers", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = proxy(new NextRequest("https://nightshift.test/"));
    const csp = res.headers.get("content-security-policy")!;
    // NextResponse.next({ request: { headers } }) encodes overridden request headers.
    const forwardedNonce = res.headers.get("x-middleware-request-x-nonce");
    expect(forwardedNonce).toBeTruthy();
    expect(csp).toContain(`'nonce-${forwardedNonce}'`);
  });

  it("gives API routes a deny-all CSP and no-store", () => {
    const res = proxy(new NextRequest("https://nightshift.test/api/health"));
    expect(res.headers.get("content-security-policy")).toBe(API_CSP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("strict-transport-security")).toContain("preload");
  });

  it("HSTS is preload-ready (2 years, subdomains, preload)", () => {
    const hsts = STATIC_SECURITY_HEADERS["Strict-Transport-Security"]!;
    expect(hsts).toMatch(/max-age=(\d+)/);
    expect(Number(/max-age=(\d+)/.exec(hsts)![1])).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).toContain("preload");
  });

  it("Permissions-Policy turns off camera, mic, location and payment", () => {
    const pp = STATIC_SECURITY_HEADERS["Permissions-Policy"]!;
    for (const f of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()"]) expect(pp).toContain(f);
  });
});
