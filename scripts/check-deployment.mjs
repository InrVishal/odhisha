#!/usr/bin/env node
/**
 * A deployment's own health check, before it gets traffic: CI deploys
 * production without its domain (vercel deploy --skip-domain), runs this on
 * the new deployment's URL, and only then promotes it. /api/health is down
 * (503) when the database or Redis is unreachable, or shared with the other
 * environment (lib/isolation.ts), so a production build pointed at preview's
 * Redis, or at a preview branch, never goes live.
 *
 *   VERCEL_AUTOMATION_BYPASS_SECRET=... node scripts/check-deployment.mjs <deployment url>
 *
 * Tries 4 times, 10 s apart (a new deployment's first request is a cold start).
 */
const url = process.argv[2];
if (!url) {
  console.error("check-deployment: usage: check-deployment.mjs <deployment url>");
  process.exit(2);
}
const host = new URL(url).hostname;
const headers = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {};

let last = "no answer";
for (let i = 1; i <= 4; i++) {
  try {
    const res = await fetch(new URL("/api/health", url), { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (res.status === 200 && text === '{"status":"ok"}') {
      console.log(`check-deployment: https://${host}/api/health is ok (try ${i})`);
      process.exit(0);
    }
    last = `HTTP ${res.status} ${text.slice(0, 40)}`;
  } catch (err) {
    last = err instanceof Error ? err.name : "error";
  }
  console.log(`check-deployment: try ${i}: ${last}`);
  if (i < 4) await new Promise((r) => setTimeout(r, 10_000));
}
console.error(`check-deployment: https://${host} is not healthy (${last}); not promoting it`);
process.exit(1);
