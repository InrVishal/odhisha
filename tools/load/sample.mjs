#!/usr/bin/env node
/**
 * Samples where time goes during a load run (LOCAL database only), then
 * prints a summary: CPU per process (app, Postgres, k6) and what Postgres
 * backends are doing (running, waiting on a lock, on I/O, or idle).
 *
 *   ADMIN_URL=postgres://...localhost... node tools/load/sample.mjs <seconds> [startDelaySec]
 *
 * Prints counts and query shapes only (no values, no URLs).
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

const seconds = Number(process.argv[2] ?? 180);
const delay = Number(process.argv[3] ?? 30);
const url = process.env.ADMIN_URL ?? "";
if (!/@(localhost|127\.0\.0\.1):/.test(url)) {
  console.error("sample: refusing a non-local database");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cpu = new Map(); // command -> [sum of %cpu, samples]
const waits = new Map(); // state/wait -> count
const queries = new Map(); // active query shape -> count
let samples = 0;

await sleep(delay * 1000);
const client = new pg.Client({ connectionString: url });
await client.connect();
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  samples += 1;
  try {
    const out = execFileSync("ps", ["-eo", "pcpu=,comm="], { encoding: "utf8" });
    const per = new Map();
    for (const line of out.trim().split("\n")) {
      const m = /^\s*([\d.]+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const name = m[2].startsWith("postgres") ? "postgres" : m[2].startsWith("next-server") || m[2] === "node" ? "node (app + tools)" : m[2];
      per.set(name, (per.get(name) ?? 0) + Number(m[1]));
    }
    for (const [k, v] of per) {
      const [s, n] = cpu.get(k) ?? [0, 0];
      cpu.set(k, [s + v, n + 1]);
    }
  } catch {
    // ps missing: CPU section stays empty
  }
  const r = await client.query(
    "select state, coalesce(wait_event_type || ':' || wait_event, 'on CPU') as w, left(regexp_replace(query, '\\$\\d+', '?', 'g'), 90) as q from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid() and usename = 'app_runtime'",
  );
  for (const row of r.rows) {
    const k = row.state === "active" ? `active, ${row.w}` : row.state;
    waits.set(k, (waits.get(k) ?? 0) + 1);
    if (row.state === "active") queries.set(row.q, (queries.get(row.q) ?? 0) + 1);
  }
  await sleep(1000);
}
await client.end();

console.log(`\nsample: ${samples} samples, 1 per second`);
console.log("average CPU % by process (100 = one vCPU):");
for (const [k, [s, n]] of [...cpu].sort((a, b) => b[1][0] - a[1][0]).slice(0, 6)) console.log(`  ${(s / samples).toFixed(0).padStart(4)}  ${k} (seen in ${n})`);
console.log("app_runtime connections by state (average per sample):");
for (const [k, n] of [...waits].sort((a, b) => b[1] - a[1])) console.log(`  ${(n / samples).toFixed(1).padStart(5)}  ${k}`);
console.log("busiest query shapes (times seen running):");
for (const [q, n] of [...queries].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(5)}  ${q}`);
