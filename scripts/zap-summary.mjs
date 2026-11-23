#!/usr/bin/env node
/**
 * Prints a ZAP JSON report as a short table in the CI log (no upload: this
 * repo is public). Alert name, rule id, risk, how many URLs, and up to three
 * paths each. Paths only, never query strings, request headers or evidence.
 *
 *   node scripts/zap-summary.mjs zap/report.json
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: zap-summary.mjs <report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, "utf8"));
const RISK = { 3: "High", 2: "Medium", 1: "Low", 0: "Info" };
const rows = [];
for (const site of report.site ?? []) {
  for (const a of site.alerts ?? []) {
    const paths = [...new Set((a.instances ?? []).map((i) => {
      try {
        return new URL(i.uri).pathname;
      } catch {
        return "?";
      }
    }))];
    rows.push({ risk: Number(a.riskcode), name: a.name ?? a.alert, id: a.pluginid, count: Number(a.count ?? paths.length), paths });
  }
}
rows.sort((x, y) => y.risk - x.risk || y.count - x.count);
const byRisk = rows.reduce((m, r) => ((m[RISK[r.risk]] = (m[RISK[r.risk]] ?? 0) + 1), m), {});
console.log(`ZAP alerts by risk: ${JSON.stringify(byRisk)}`);
for (const r of rows) {
  console.log(`${RISK[r.risk].padEnd(6)} [${r.id}] ${r.name} x${r.count}: ${r.paths.slice(0, 3).join(", ")}${r.paths.length > 3 ? ", ..." : ""}`);
}
