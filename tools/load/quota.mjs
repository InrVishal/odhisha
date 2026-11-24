#!/usr/bin/env node
/**
 * Free-tier use of one preview load run, from k6's summary export:
 * - Vercel: one function call per request (pages are not requested);
 * - Upstash: each request checks one shared limit (the PC's token, or the
 *   buyer's account; the per-IP agent limit is per instance in load tests),
 *   and each check is ~4.1 Redis COMMANDS, not one: Upstash bills the EVAL
 *   plus every command inside the script (tools/load/upstash-budget.mjs).
 *   Counting checks as commands is how the estimate before 2026-11-24 came
 *   out 4x too low (docs/INCIDENTS.md). The workflow also prints Upstash's
 *   own count before and after the run.
 *
 *   node tools/load/quota.mjs k6-summary.json
 */
import { readFileSync } from "node:fs";
import { COMMANDS_PER_CHECK } from "./upstash-budget.mjs";

const m = JSON.parse(readFileSync(process.argv[2] ?? "k6-summary.json", "utf8")).metrics ?? {};
const total = m.http_reqs?.count ?? 0;
const per = { heartbeat: 1, lease: 1, "hand-in": 1, quote: 1, confirm: 1 };
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
console.log(`Upstash: about ${Math.round(limiterCalls * scale * COMMANDS_PER_CHECK)} commands (${Math.round(limiterCalls * scale)} limit checks x ${COMMANDS_PER_CHECK}; free plan: 500,000 a month, Preview's own database)`);
