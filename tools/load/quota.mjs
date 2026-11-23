#!/usr/bin/env node
/**
 * Free-tier use of one preview load run, from k6's summary export:
 * - Vercel: one function call per request (pages are not requested);
 * - Upstash: rate-limit calls per request (each Upstash sliding-window check
 *   is one script call): agent endpoints check the IP and the PC (2), quote
 *   and confirm check the user (1).
 *
 *   node tools/load/quota.mjs k6-summary.json
 */
import { readFileSync } from "node:fs";

const m = JSON.parse(readFileSync(process.argv[2] ?? "k6-summary.json", "utf8")).metrics ?? {};
const total = m.http_reqs?.count ?? 0;
const per = { heartbeat: 2, lease: 2, "hand-in": 2, quote: 1, confirm: 1 };
let measured = 0;
let limiterCalls = 0;
for (const [name, calls] of Object.entries(per)) {
  const n = m[`http_req_duration{name:${name},scenario:agents}`]?.count ?? 0;
  measured += n;
  limiterCalls += n * calls;
}
// Warm-up requests aren't broken down by endpoint; scale them by the same mix.
const scale = measured > 0 ? total / measured : 1;
console.log(`Vercel: ${total} function calls (Hobby includes 1,000,000 a month)`);
console.log(`Upstash: about ${Math.round(limiterCalls * scale)} rate-limit commands (free plan: 500,000 a month, shared with production)`);
