import { NextResponse, type NextRequest } from "next/server";
import { applySecurityHeaders, buildPageCsp, generateNonce } from "@/lib/security/headers";

/**
 * Runs before every page request (Node runtime in Next 16): a fresh nonce
 * per request, and a nonce-based CSP on both the request (so Next.js can
 * read it while rendering) and the response.
 *
 * Not for API routes: their headers never change (deny-all CSP, no-store),
 * so next.config.ts sets them, which Vercel applies without running this
 * proxy. On Vercel the proxy is its own step before the route function;
 * skipping it takes that hop off every agent request (the preview load test
 * measured the time spent outside the route function).
 *
 * Proxy is NOT an auth boundary. Every route handler and server action checks
 * the session itself (see lib/auth/guards.ts).
 */
export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const csp = buildPageCsp(nonce, process.env.NODE_ENV === "development" ? "development" : "production", https);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response.headers, csp);
  return response;
}

export const config = {
  matcher: [
    // Pages only. Build assets and API routes get their headers from next.config.ts.
    "/((?!api/|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
