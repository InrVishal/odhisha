#!/usr/bin/env node
// Checks security headers on a live deployment. CI runs this against every
// preview and again against production right after deploy.
//
//   node scripts/check-headers.mjs https://nightshift-xyz.vercel.app
//
// If Vercel Deployment Protection is on for previews, set
// VERCEL_AUTOMATION_BYPASS_SECRET and the check sends the bypass header.

const base = process.argv[2];
if (!base) {
  console.error("usage: check-headers.mjs <base-url>");
  process.exit(2);
}

const extra = {};
if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
  extra["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
}

const common = {
  "strict-transport-security": (v) => /max-age=(\d+)/.test(v) && Number(/max-age=(\d+)/.exec(v)[1]) >= 31536000 && v.includes("includeSubDomains") && v.includes("preload"),
  "x-content-type-options": (v) => v === "nosniff",
  "referrer-policy": (v) => v === "strict-origin-when-cross-origin",
  "permissions-policy": (v) => ["camera=()", "microphone=()", "geolocation=()", "payment=()"].every((f) => v.includes(f)),
  "x-frame-options": (v) => v === "DENY",
};

const pageCsp = (v) =>
  v.includes("frame-ancestors 'none'") &&
  /script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/.test(v) &&
  !v.includes("unsafe-inline") &&
  !v.includes("unsafe-eval");

const apiCsp = (v) => v.includes("default-src 'none'") && v.includes("frame-ancestors 'none'");

const checks = [
  { path: "/", csp: pageCsp },
  { path: "/signin", csp: pageCsp },
  { path: "/api/health", csp: apiCsp },
];

let failed = 0;
for (const { path, csp } of checks) {
  const url = new URL(path, base);
  const res = await fetch(url, { headers: extra, redirect: "manual" });
  const problems = [];
  for (const [name, ok] of Object.entries({ ...common, "content-security-policy": csp })) {
    const value = res.headers.get(name);
    if (value === null) problems.push(`${name}: missing`);
    else if (!ok(value)) problems.push(`${name}: unexpected value "${value}"`);
  }
  const cspCount = (res.headers.get("content-security-policy") ?? "").split(/,\s*(?=default-src)/).length;
  if (cspCount > 1) problems.push("content-security-policy: sent more than once");
  if (res.headers.get("x-powered-by")) problems.push("x-powered-by: should not be sent");

  if (problems.length) {
    failed++;
    console.error(`FAIL ${url} (${res.status})\n  - ${problems.join("\n  - ")}`);
  } else {
    console.log(`ok   ${url} (${res.status})`);
  }
}

process.exit(failed ? 1 : 0);
