/**
 * Security headers, built as pure functions so tests can check them directly.
 *
 * Pages get a nonce-based CSP from `proxy.ts`. API routes and static files get
 * a deny-everything CSP. Nothing here allows 'unsafe-inline', and
 * 'unsafe-eval' is only added in `next dev` (React needs it for error
 * overlays). Production never gets it.
 *
 * Rule for components: no inline `style="..."` attributes in server-rendered
 * HTML. A nonce does not cover style attributes, so the browser blocks them.
 * Use Tailwind classes, or set styles from JS after hydration.
 */

export type Mode = "development" | "production";

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

/**
 * @param https whether the page itself was served over HTTPS. Only then is
 *   `upgrade-insecure-requests` added: on plain-HTTP local servers WebKit
 *   would rewrite every asset URL to https:// and the page would break.
 *   Deployed environments are always HTTPS, so they always get it.
 */
export function buildPageCsp(nonce: string, mode: Mode, https = true): string {
  const dev = mode === "development";
  const directives: string[] = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Vercel Analytics and Sentry report to same-origin endpoints (tunnelled).
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (https && !dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** CSP for JSON APIs and files: nothing may load or frame them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "bluetooth=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/** Headers that apply to every response, independent of CSP. */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": PERMISSIONS_POLICY,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-DNS-Prefetch-Control": "off",
  "X-Permitted-Cross-Domain-Policies": "none",
});

export function applySecurityHeaders(headers: Headers, csp: string): void {
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) headers.set(k, v);
  headers.set("Content-Security-Policy", csp);
}
