#!/usr/bin/env node
/**
 * Fails if Preview and Production could be pointing at the same Redis or
 * database (incident 2026-11-24, docs/INCIDENTS.md). Run by CI before every
 * preview and production deploy, and before every load test.
 *
 *   VERCEL_TOKEN=... VERCEL_PROJECT_ID=... VERCEL_ORG_ID=... node scripts/check-env-isolation.mjs
 *
 * Reads the project's variable list from Vercel's API WITHOUT values
 * (decrypt is never requested): names, target environments and, for
 * Marketplace stores, the store each variable comes from. Refuses when:
 * - one Redis or database variable is set for both Preview and Production
 *   (how the Upstash database was shared: one KV_* set, both environments);
 * - Preview's and Production's copies of a variable come from the same store.
 * Values can't be compared here (Sensitive ones can't be read back at all);
 * the markers in lib/isolation.ts catch two variables holding the same value.
 * Prints names only.
 */

/** Variables that pick a Redis or a database. */
export const ISOLATED_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "KV_REST_API_READ_ONLY_TOKEN",
  "KV_URL",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "DATABASE_URL_READONLY",
];

const targetsOf = (e) => (Array.isArray(e.target) ? e.target : e.target ? [e.target] : []);
const storeOf = (e) => e.contentHint?.storeId ?? null;

/** Pure: the problems in a Vercel env list (exported for tests). */
export function findSharing(envs) {
  const problems = [];
  for (const key of ISOLATED_KEYS) {
    const entries = envs.filter((e) => e.key === key);
    for (const e of entries) {
      const t = targetsOf(e);
      if (t.includes("production") && t.includes("preview")) problems.push(`${key} is one variable set for both Production and Preview`);
    }
    const prodStores = new Set(entries.filter((e) => targetsOf(e).includes("production")).map(storeOf).filter(Boolean));
    for (const e of entries.filter((x) => targetsOf(x).includes("preview"))) {
      const s = storeOf(e);
      if (s && prodStores.has(s)) problems.push(`${key}: Preview and Production use the same store`);
    }
  }
  return [...new Set(problems)];
}

async function main() {
  const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID } = process.env;
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
    console.error("check-env-isolation: VERCEL_TOKEN and VERCEL_PROJECT_ID are required");
    process.exit(2);
  }
  const team = VERCEL_ORG_ID ? `?teamId=${encodeURIComponent(VERCEL_ORG_ID)}` : "";
  const res = await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}/env${team}`, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`check-env-isolation: Vercel API answered ${res.status}`);
    process.exit(1);
  }
  const { envs = [] } = await res.json();
  const problems = findSharing(envs);
  const seen = ISOLATED_KEYS.filter((k) => envs.some((e) => e.key === k));
  console.log(`check-env-isolation: checked ${seen.length} Redis/database variables (${seen.join(", ") || "none set in Vercel"})`);
  if (problems.length) {
    for (const p of problems) console.error(`  REFUSED: ${p}`);
    console.error("Preview and Production must each have their own Redis and database (docs/INCIDENTS.md). Fix it in Vercel -> Storage / Environment Variables.");
    process.exit(1);
  }
  console.log("check-env-isolation: no Redis or database variable is shared between Preview and Production");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-env-isolation.mjs")) {
  main().catch((err) => {
    console.error(`check-env-isolation: ${err instanceof Error ? err.name : "error"}`);
    process.exit(1);
  });
}
