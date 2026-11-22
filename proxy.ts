import { NextResponse, type NextRequest } from "next/server";
import { API_CSP, applySecurityHeaders, buildPageCsp, generateNonce } from "@/lib/security/headers";

/**
 * Runs before every page and API request (Node runtime in Next 16).
 *
 * - Pages: fresh nonce per request, nonce-based CSP on both the request
 *   (so Next.js can read it while rendering) and the response.
 * - API routes: deny-all CSP and no-store caching.
 *
 * Proxy is NOT an auth boundary. Every route handler and server action checks
 * the session itself (see lib/auth/guards.ts).
 */
export function proxy(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (isApi) {
    const response = NextResponse.next();
    applySecurityHeaders(response.headers, API_CSP);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

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
    // Everything except build assets, which get headers from next.config.ts.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
