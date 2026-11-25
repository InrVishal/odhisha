#!/usr/bin/env node
/**
 * Per-endpoint table from a k6 summary export: success-only p50/p95, failures
 * and 429s, and (when the target sent Server-Timing) where the time went.
 *
 *   node tools/load/split.mjs k6-summary.json
 */
import { readFileSync } from "node:fs";

const m = JSON.parse(readFileSync(process.argv[2] ?? "k6-summary.json", "utf8")).metrics ?? {};
const f = (v) => (v === undefined || Number.isNaN(v) ? "-" : Math.round(v).toString());
const pair = (k) => {
  const x = m[k];
  return x ? `${f(x.med)} / ${f(x["p(95)"])}` : "-";
};
const rows = [["endpoint", "ok p50 / p95", "count", "429", "5xx", "rate limits p50 / p95", "db p50 / p95", "queries p50", "app p50 / p95", "function total p50 / p95", "outside function p50 / p95", "cold starts (share, p95 ms)"]];
for (const name of ["heartbeat", "lease", "hand-in", "quote", "confirm"]) {
  const ok = m[`http_req_duration{name:${name},scenario:agents,expected_response:true}`] ?? m[`http_req_duration{name:${name},scenario:agents}`];
  rows.push([
    name,
    ok ? `${f(ok.med)} / ${f(ok["p(95)"])}` : "-",
    ok ? String(ok.count ?? "-") : "-",
    String(m[`responses_429{name:${name},scenario:agents}`]?.count ?? 0),
    String(m[`responses_5xx{name:${name},scenario:agents}`]?.count ?? 0),
    pair(`split_ratelimit_ms{name:${name}}`),
    pair(`split_db_ms{name:${name}}`),
    f(m[`split_db_queries{name:${name}}`]?.med),
    pair(`split_app_ms{name:${name}}`),
    pair(`split_function_total_ms{name:${name}}`),
    pair(`split_outside_function_ms{name:${name}}`),
    m[`split_cold_start{name:${name}}`] ? `${(m[`split_cold_start{name:${name}}`].value * 100).toFixed(1)}%, ${f(m[`split_cold_start_ms{name:${name}}`]?.["p(95)"])}` : "-",
  ]);
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  "));
const failed = m["http_req_failed{scenario:agents}"];
if (failed) console.log(`\nfailed requests (measured scenario): ${(failed.value * 100).toFixed(2)}%`);
console.log("times in ms; db and rate limits are sums per request; outside function = k6's time minus the function's own total (network, Vercel edge, cold starts)");
