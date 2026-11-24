#!/usr/bin/env node
/**
 * Upstash command use this month, per database, from Upstash's Developer API
 * (it costs no Redis commands). Fails at 70% of a database's monthly
 * allowance, so GitHub emails the owner well before rate limits break
 * (incident 2026-11-24, docs/INCIDENTS.md).
 *
 *   UPSTASH_EMAIL=... UPSTASH_API_KEY=... node scripts/upstash-usage.mjs [--fail-at 0.7] [--require-creds]
 *
 * UPSTASH_API_KEY: console.upstash.com -> Account -> Management API (a
 * read-only key is enough). Both are GitHub secrets; neither is printed.
 * Prints database names and counts, never endpoints or tokens.
 */

/** The free plan's monthly allowance (Upstash pricing, 2026). */
export const FREE_MONTHLY_COMMANDS = 500_000;

function auth() {
  const { UPSTASH_EMAIL, UPSTASH_API_KEY } = process.env;
  if (!UPSTASH_EMAIL || !UPSTASH_API_KEY) return null;
  return `Basic ${Buffer.from(`${UPSTASH_EMAIL}:${UPSTASH_API_KEY}`).toString("base64")}`;
}

async function api(path, header) {
  const res = await fetch(`https://api.upstash.com/v2${path}`, { headers: { Authorization: header }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Upstash API ${path.split("/").slice(0, 3).join("/")} answered ${res.status}`);
  return res.json();
}

/** A database's monthly allowance: its own limit when it states a real one, else the free plan's. */
export function monthlyLimit(db) {
  const n = Number(db.db_request_limit);
  if (Number.isFinite(n) && n > 0 && n < 1e12) return n;
  return FREE_MONTHLY_COMMANDS;
}

/** Does an Upstash REST URL (or host) belong to this database? */
export function matchesHost(db, urlOrHost) {
  let host = String(urlOrHost);
  try {
    host = new URL(host).hostname;
  } catch {
    // already a host
  }
  const ep = String(db.endpoint ?? "").toLowerCase();
  host = host.toLowerCase();
  return ep !== "" && (host === ep || host.startsWith(`${ep}.`));
}

/** Every database with this month's use. Null when the API credentials aren't set. */
export async function usage() {
  const header = auth();
  if (!header) return null;
  const dbs = await api("/redis/databases", header);
  const out = [];
  for (const db of dbs) {
    const stats = await api(`/redis/stats/${encodeURIComponent(db.database_id)}`, header);
    const used = Number(stats.total_monthly_requests ?? 0);
    const limit = monthlyLimit(db);
    out.push({ db, name: db.database_name, used, limit, share: used / limit });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const failAt = Number(args[args.indexOf("--fail-at") + 1] || 0.7);
  const rows = await usage();
  if (!rows) {
    const msg = "upstash-usage: UPSTASH_EMAIL / UPSTASH_API_KEY not set, so Upstash use can't be checked (add them as GitHub secrets)";
    if (args.includes("--require-creds")) {
      console.error(msg);
      process.exit(2);
    }
    console.log(`::warning::${msg}`);
    return;
  }
  let over = 0;
  for (const r of rows) {
    const pct = (r.share * 100).toFixed(1);
    const flag = r.share >= failAt ? "  <-- OVER" : "";
    console.log(`upstash-usage: ${r.name}: ${r.used.toLocaleString("en-US")} of ${r.limit.toLocaleString("en-US")} commands this month (${pct}%)${flag}`);
    if (r.share >= failAt) over++;
  }
  if (over) {
    console.log(`::error::Upstash: ${over} database(s) at or over ${Math.round(failAt * 100)}% of the monthly allowance. Rate limits stop working at 100% (docs/INCIDENTS.md).`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("upstash-usage.mjs")) {
  main().catch((err) => {
    console.error(`upstash-usage: ${err instanceof Error ? err.message : "error"}`);
    process.exit(1);
  });
}
