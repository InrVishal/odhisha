#!/usr/bin/env node
/**
 * Smoke test of a deployed NightShift (production after every deploy, and
 * the preview). Read-only: it never writes anything.
 *
 *   node scripts/smoke.mjs https://nightshift-ten-iota.vercel.app
 *   (VERCEL_AUTOMATION_BYPASS_SECRET is sent if set, for protected previews)
 *
 * Checks that the site is up and that nothing leaks: no exposed config or
 * source files, no public source maps, /admin and the admin API are a plain
 * 404 for a stranger (spoofed headers or not), and error pages and
 * /api/health give away no environment names, versions or stack traces.
 */
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/smoke.mjs <base-url>");
  process.exit(2);
}
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const extra = bypass ? { "x-vercel-protection-bypass": bypass } : {};

const ENV_NAMES = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "CRON_SECRET",
  "COORDINATOR_SIGNING_KEY",
  "DATA_ENCRYPTION_KEY",
  "AUTH_RESEND_KEY",
  "AUTH_GOOGLE_SECRET",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_TOKEN",
  "ADMIN_EMAILS",
];
const STACK = /\n\s+at [\w.<>$]+ \(|node_modules\/|webpack-internal:|\/var\/task\/|\.next\/server/;

let failures = 0;
let passes = 0;
function ok(cond, what) {
  if (cond) passes += 1;
  else {
    failures += 1;
    console.error(`FAIL  ${what}`);
  }
}

async function get(path, init = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...init, headers: { ...extra, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { res, text };
}

function revealsNothing(text, headers, what) {
  for (const n of ENV_NAMES) ok(!text.includes(n), `${what} doesn't name ${n}`);
  ok(!STACK.test(text), `${what} has no stack trace or server paths`);
  ok(!/next\.js\s*v?\d|"version"\s*:\s*"\d/i.test(text), `${what} has no version numbers`);
  ok(!headers.get("x-powered-by"), `${what} has no X-Powered-By`);
  ok(!/\d+\.\d+/.test(headers.get("server") ?? ""), `${what}'s Server header has no version`);
}

async function main() {
  // Up, with its security headers.
  const home = await get("/");
  ok(home.res.status === 200, "/ answers 200");
  ok(Boolean(home.res.headers.get("content-security-policy")), "/ has a Content-Security-Policy");
  if (base.startsWith("https://")) ok(/max-age=\d{7,}/.test(home.res.headers.get("strict-transport-security") ?? ""), "/ has HSTS");

  // Health: up/down only.
  const health = await get("/api/health");
  ok(health.res.status === 200, "/api/health answers 200");
  ok(health.text === '{"status":"ok"}', `/api/health says only {"status":"ok"} (got ${health.text.slice(0, 80)})`);
  revealsNothing(health.text, health.res.headers, "/api/health");

  // CORS: no page or API lets another site read it, even when asked by a hostile
  // Origin. (Vercel's CDN adds "Access-Control-Allow-Origin: *" to public static
  // files only, such as JS chunks, fonts and robots.txt, which hold no user data.)
  const evil = { origin: "https://evil.example" };
  for (const [p, method] of [["/", "GET"], ["/signin", "GET"], ["/dashboard", "GET"], ["/api/health", "GET"], ["/api/agent/signing-key", "GET"], ["/api/account/export", "GET"], ["/api/jobs/quote", "POST"], ["/api/jobs/quote", "OPTIONS"]]) {
    const r = await get(p, { method, headers: evil, ...(method === "POST" ? { body: "{}" } : {}) });
    const acao = r.res.headers.get("access-control-allow-origin");
    const creds = r.res.headers.get("access-control-allow-credentials");
    ok(acao === null && creds === null, `${method} ${p} with a hostile Origin sends no CORS allow headers (got ${acao ?? "none"}${creds ? `, credentials ${creds}` : ""})`);
  }

  // Error pages.
  const missing = await get(`/no-such-page-${Date.now()}`);
  ok(missing.res.status === 404, "an unknown page is a 404");
  revealsNothing(missing.text, missing.res.headers, "the 404 page");
  const apiErr = await get("/api/jobs");
  ok(apiErr.res.status === 401, "an API call without a session is a 401");
  ok(/^\{"error":"unauthenticated","message":"[^"]*"\}$/.test(apiErr.text), "the API error is just a code and a message");
  revealsNothing(apiErr.text, apiErr.res.headers, "an API error");

  // Files that must never be served.
  for (const p of [
    "/.env",
    "/.env.local",
    "/.env.production",
    "/.env.example",
    "/.git/config",
    "/.git/HEAD",
    "/next.config.js",
    "/next.config.ts",
    "/package.json",
    "/package-lock.json",
    "/tsconfig.json",
    "/.vercel/project.json",
    "/drizzle/meta/_journal.json",
    "/drizzle/0000_init.sql",
    "/lib/env.ts",
    "/.next/server/server-reference-manifest.json",
    "/_next/server/server-reference-manifest.json",
    "/%2e%2e/.env",
    "/_next/static/../../.env",
  ]) {
    const r = await get(p);
    ok(r.res.status === 404, `${p} is a 404 (got ${r.res.status})`);
    ok(!/DATABASE_URL=|"dependencies"|\[core\]|AUTH_SECRET=/.test(r.text), `${p} has no file contents`);
  }

  // No public source maps.
  const scripts = [...home.text.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]).slice(0, 25);
  ok(scripts.length > 0, "the home page loads scripts from /_next/static");
  for (const s of scripts) {
    const js = await get(s);
    ok(!/[#@]\s*sourceMappingURL=(?!data:)/.test(js.text), `${s} has no sourceMappingURL`);
    const map = await get(`${s}.map`);
    ok(map.res.status === 404, `${s}.map is a 404 (got ${map.res.status})`);
  }

  // Admin is nothing to a stranger, with or without made-up headers.
  const spoofs = [
    {},
    { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" },
    { "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" },
    { "x-user-role": "admin", "x-admin": "true", "x-role": "admin", cookie: "role=admin; isAdmin=true" },
  ];
  for (const headers of spoofs) {
    const label = Object.keys(headers)[0] ?? "no extra headers";
    for (const p of ["/admin", "/admin/anything", "/dashboard/admin"]) {
      const r = await get(p, { headers });
      ok(r.res.status === 404 || (r.res.status >= 300 && r.res.status < 400 && /\/signin/.test(r.res.headers.get("location") ?? "")), `${p} with ${label} gives nothing (got ${r.res.status})`);
      ok(!/Quarantine list|Audit log|authenticator/i.test(r.text), `${p} with ${label} shows no admin content`);
    }
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const r = await get("/api/admin/nodes/00000000-0000-4000-8000-000000000000/release", { method, headers: { ...headers, origin: base } });
      ok(r.res.status === 404, `${method} /api/admin/... with ${label} is a 404 (got ${r.res.status})`);
    }
  }

  // The one public key endpoint publishes a public key and nothing else.
  const key = await get("/api/agent/signing-key");
  ok(key.res.status === 200 && /"alg":"Ed25519"/.test(key.text) && !/PRIVATE/.test(key.text), "/api/agent/signing-key has the public key only");

  console.log(`smoke ${base}: ${passes} checks passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error("smoke test error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
