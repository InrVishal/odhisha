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

  it("adds upgrade-insecure-requests only for pages served over HTTPS", () => {
    expect(buildPageCsp("n", "production", true)).toContain("upgrade-insecure-requests");
    expect(buildPageCsp("n", "production", false)).not.toContain("upgrade-insecure-requests");
    expect(buildPageCsp("n", "development", true)).not.toContain("upgrade-insecure-requests");
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

  it("upgrades insecure requests on HTTPS (and behind an HTTPS proxy), not on plain-HTTP local servers", () => {
    vi.stubEnv("NODE_ENV", "production");
    const csp = (req: NextRequest) => proxy(req).headers.get("content-security-policy")!;
    expect(csp(new NextRequest("https://nightshift.test/"))).toContain("upgrade-insecure-requests");
    expect(csp(new NextRequest("http://127.0.0.1:3300/"))).not.toContain("upgrade-insecure-requests");
    expect(csp(new NextRequest("http://internal/", { headers: { "x-forwarded-proto": "https" } }))).toContain(
      "upgrade-insecure-requests",
    );
  });

  it("gives API routes a deny-all CSP and no-store from next.config.ts, without running the proxy", async () => {
    const { default: config } = await import("@/next.config");
    const { config: proxyConfig } = await import("@/proxy");
    const rules = await config.headers!();
    const api = rules.find((r) => r.source === "/api/:path*");
    const h = Object.fromEntries((api?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
    expect(h["content-security-policy"]).toBe(API_CSP);
    expect(h["cache-control"]).toBe("no-store");
    expect(h["strict-transport-security"]).toContain("preload");
    for (const k of Object.keys(STATIC_SECURITY_HEADERS)) expect(h[k.toLowerCase()]).toBe(STATIC_SECURITY_HEADERS[k]);
    // The proxy's matcher skips /api/ (so no second CSP), and still covers pages.
    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
    expect(matcher.test("/api/agent/lease")).toBe(false);
    expect(matcher.test("/pricing")).toBe(true);
    expect(matcher.test("/dashboard/jobs")).toBe(true);
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

describe("site URL", () => {
  it("never throws, whatever the build sees", async () => {
    const { siteUrl } = await import("@/lib/site-url");
    expect(siteUrl({ SITE_URL: "https://nightshift.in" }).origin).toBe("https://nightshift.in");
    expect(siteUrl({ SITE_URL: "[SENSITIVE]", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" }).origin).toBe("https://x.vercel.app");
    expect(siteUrl({ SITE_URL: "javascript:alert(1)" }).origin).toBe("http://localhost:3000");
    expect(siteUrl({}).origin).toBe("http://localhost:3000");
  });
});
