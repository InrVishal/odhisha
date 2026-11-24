#!/usr/bin/env node
/**
 * Runs before every preview load test (.github/workflows/load-preview.yml) and
 * refuses unless:
 * 1. the Redis the load deployment will use is preview-only: its owner marker
 *    (lib/isolation.ts) says "preview" (claimed now if nobody has);
 * 2. Upstash's Developer API can see that database (UPSTASH_EMAIL and
 *    UPSTASH_API_KEY are set): without this month's count there is no budget;
 * 3. the run's estimated commands (tools/load/upstash-budget.mjs) are at most
 *    25% of what that database has left this month.
 * scripts/check-env-isolation.mjs runs before it (no Redis variable shared
 * with Production).
 *
 *   node tools/load/upstash-guard.mjs .vercel/.env.preview.local          (before)
 *   node tools/load/upstash-guard.mjs .vercel/.env.preview.local --after <used before>
 *
 * VUS and DURATION as for k6 (defaults 200 and 3m). Prints counts and the
 * database's name; never its URL or token.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { matchesHost, usage } from "../../scripts/upstash-usage.mjs";
import { estimateCommands, judgeBudget, MAX_SHARE_OF_REMAINING } from "./upstash-budget.mjs";

const OWNER_KEY = "ns:owner-env";

function refuse(msg) {
  console.error(`upstash-guard: REFUSED: ${msg}`);
  process.exit(1);
}

/** KEY="value" lines, as vercel pull writes them. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    out[m[1]] = v;
  }
  return out;
}

async function redis(url, token, command) {
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(command), signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Redis answered ${res.status}${body.error ? " (an error; quota or token?)" : ""}`);
  return body.result;
}

async function main() {
  const [envPath, flag, before] = process.argv.slice(2);
  if (!envPath) refuse("usage: upstash-guard.mjs <pulled preview env file> [--after <used before>]");
  const env = parseEnvFile(readFileSync(envPath, "utf8"));
  // Same precedence as lib/env.ts withDefaults.
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) refuse("the Preview environment has no Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN)");

  const rows = await usage();
  if (!rows) refuse("UPSTASH_EMAIL / UPSTASH_API_KEY are not set, so this month's use can't be checked; no budget, no run");
  const row = rows.find((r) => matchesHost(r.db, url));
  if (!row) refuse("the Preview Redis isn't one of the databases the Upstash API key can see");

  if (flag === "--after") {
    const was = Number(before);
    console.log(`upstash-guard: ${row.name}: ${row.used.toLocaleString("en-US")} commands this month now, ${(row.used - was).toLocaleString("en-US")} since the run started (Upstash's count can lag by a few minutes)`);
    return;
  }

  // 1. Preview-only.
  await redis(url, token, ["SET", OWNER_KEY, "preview", "NX"]);
  const owner = await redis(url, token, ["GET", OWNER_KEY]);
  if (owner !== "preview") refuse(`the Preview Redis (${row.name}) is marked "${owner}", not "preview": production uses it`);

  // 2-3. Budget.
  const vus = Number(process.env.VUS || 200);
  const duration = process.env.DURATION || "3m";
  const estimate = estimateCommands({ vus, duration });
  const b = judgeBudget({ estimate, used: row.used, limit: row.limit });
  console.log(`upstash-guard: Redis ${row.name} is preview-only (marker "preview")`);
  console.log(`upstash-guard: used this month ${row.used.toLocaleString("en-US")} of ${row.limit.toLocaleString("en-US")}; left ${b.remaining.toLocaleString("en-US")}`);
  console.log(`upstash-guard: this run (${vus} users, ${duration}): about ${estimate.toLocaleString("en-US")} commands; allowed ${b.allowed.toLocaleString("en-US")} (${MAX_SHARE_OF_REMAINING * 100}% of what's left)`);
  if (!b.ok) refuse(`the run would use more than ${MAX_SHARE_OF_REMAINING * 100}% of the Preview Redis's remaining monthly commands`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `used_before=${row.used}\nestimate=${estimate}\n`);
}

if (process.argv[1]?.endsWith("upstash-guard.mjs")) {
  main().catch((err) => refuse(err instanceof Error ? err.message : "error"));
}
