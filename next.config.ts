import type { NextConfig } from "next";
import { API_CSP, STATIC_SECURITY_HEADERS } from "./lib/security/headers";

const nextConfig: NextConfig = {
  // Nonce-based CSP needs every page rendered per request. Cache Components /
  // Partial Prerendering serve a static shell that cannot carry a nonce, so
  // they stay off. See node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md
  cacheComponents: false,
  poweredByHeader: false,
  // No public browser source maps (scripts/scan-bundle.mjs fails the build if
  // any .map file or sourceMappingURL comment is served).
  productionBrowserSourceMaps: false,
  reactStrictMode: true,
  // PGlite ships WASM; keep it out of the server bundle (dev/test only).
  serverExternalPackages: ["@electric-sql/pglite"],
  turbopack: {
    root: import.meta.dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    // Only the paths proxy.ts skips (build assets and API routes). Pages get
    // their headers from proxy.ts. Overlapping here would send two CSP
    // headers, and the browser enforces both.
    const headers = [
      ...Object.entries(STATIC_SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
      { key: "Content-Security-Policy", value: API_CSP },
    ];
    return [
      ...["/_next/static/:path*", "/_next/image", "/favicon.ico", "/robots.txt", "/sitemap.xml"].map((source) => ({ source, headers })),
      // API routes: the same headers, and never cached.
      { source: "/api/:path*", headers: [...headers, { key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
