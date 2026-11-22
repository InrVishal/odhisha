/**
 * Owner and buyer commands for the coordinator API, until the dashboards
 * (phase 5) exist. Uses your browser session:
 *
 *   1. Sign in on the site (Google or the email link).
 *   2. In the browser's dev tools (Application → Cookies), copy the value of
 *      `__Secure-authjs.session-token`.
 *   3. NIGHTSHIFT_SESSION=<value> npx tsx scripts/nightshift.ts <command>
 *
 * Optional: NIGHTSHIFT_API (default https://nightshift-ten-iota.vercel.app).
 * Payments are simulated (demo mode).
 *
 * Commands:
 *   node add <name> <rtx3060|rtx4070|rtx4090|cpu>   register a PC; prints its token ONCE
 *   node list
 *   node window <nodeId> <HH:MM-HH:MM|all-day>
 *   node pause|resume <nodeId>
 *   quote <texts.txt> [class]                       one text per line; default class cpu
 *   confirm <jobId>
 *   status <jobId>
 *   results <jobId> <out.json>
 *   earnings
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const API = (process.env.NIGHTSHIFT_API ?? "https://nightshift-ten-iota.vercel.app").replace(/\/$/, "");
const SESSION = process.env.NIGHTSHIFT_SESSION ?? "";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!API.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) die("NIGHTSHIFT_API must be https://");
if (!SESSION) die("Set NIGHTSHIFT_SESSION to your __Secure-authjs.session-token cookie (see the top of this file).");
const cookieName = API.startsWith("https://") ? "__Secure-authjs.session-token" : "authjs.session-token";

async function call<T = Record<string, unknown>>(method: string, path: string, json?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { cookie: `${cookieName}=${SESSION}`, origin: API, ...(json === undefined ? {} : { "content-type": "application/json" }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) die(`${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

function minutes(hhmm: string): number {
  const m = /^(\d\d):(\d\d)$/.exec(hhmm);
  if (!m) die(`bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  switch (`${cmd} ${cmd === "node" ? sub : ""}`.trim()) {
    case "node add": {
      const [name, gpuClass] = rest;
      if (!name || !gpuClass) die("usage: node add <name> <class>");
      const r = await call<{ node: { id: string }; token: string }>("POST", "/api/nodes", { name, gpuClass });
      console.log(`Registered ${name}: node ${r.node.id}`);
      console.log(`Token (shown once, paste it into \`nightshift-agent login -\` on that PC):\n${r.token}`);
      return;
    }
    case "node list": {
      const r = await call<{ nodes: Array<Record<string, unknown>> }>("GET", "/api/nodes");
      for (const n of r.nodes) {
        console.log(`${n.id}  ${String(n.name).padEnd(20)} ${n.gpuClass}  ${n.status}${n.available ? " (taking work)" : ` (${n.unavailableReason})`}  ${n.measuredWatts ?? n.defaultWatts} W${n.wattsEstimated ? " est." : ""}`);
      }
      return;
    }
    case "node window": {
      const [id, w] = rest;
      if (!id || !w) die("usage: node window <nodeId> <HH:MM-HH:MM|all-day>");
      const [a, b] = w === "all-day" ? ["00:00", "00:00"] : w.split("-");
      await call("PATCH", `/api/nodes/${id}`, { nightWindowStartMin: minutes(a!), nightWindowEndMin: minutes(b!) });
      console.log("Night window updated.");
      return;
    }
    case "node pause":
    case "node resume": {
      const [id] = rest;
      await call("PATCH", `/api/nodes/${id}`, { paused: sub === "pause" });
      console.log(sub === "pause" ? "Paused." : "Resumed.");
      return;
    }
    case "quote": {
      const file = sub;
      const gpuClass = rest[0] ?? "cpu";
      if (!file) die("usage: quote <texts.txt> [class]");
      const raw = readFileSync(file, "utf8");
      if (Buffer.byteLength(raw) > 3 * 1024 * 1024) die("that file is over 3 MB, the job limit");
      const texts = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const r = await call<{ job: { id: string; pricePaise: number; deadlineAt: string; breakdown: Record<string, number> } }>("POST", "/api/jobs/quote", {
        workloadType: "text_embeddings",
        gpuClass,
        params: {},
        texts,
      });
      const b = r.job.breakdown;
      console.log(`Job ${r.job.id}: ${texts.length} texts in ${b.fragments} pieces`);
      console.log(`Price ${rupees(r.job.pricePaise)} (owners ${rupees(b.ownerPayPaise!)} + electricity ${rupees(b.electricityPaise!)} + buffer ${rupees(b.verificationBufferPaise!)} + fee ${rupees(b.nightshiftFeePaise!)}), done by ${new Date(r.job.deadlineAt).toLocaleString()}`);
      console.log(`Held for 10 minutes. Confirm with: confirm ${r.job.id}`);
      return;
    }
    case "confirm": {
      const r = await call<{ job: { status: string } }>("POST", `/api/jobs/${sub}/confirm`);
      console.log(`Confirmed (demo mode, simulated charge): ${r.job.status}`);
      return;
    }
    case "status": {
      const r = await call<{ job: { status: string; progress: Record<string, number>; refunded: boolean; netChargedPaise: number } }>("GET", `/api/jobs/${sub}`);
      const p = r.job.progress;
      console.log(`${r.job.status}: ${p.fragmentsDone}/${p.fragmentsTotal} pieces, ${p.nodesWorking} PCs working; paid ${rupees(r.job.netChargedPaise)}${r.job.refunded ? " (refunded: deadline missed)" : ""}`);
      return;
    }
    case "results": {
      const [out] = rest;
      if (!sub || !out) die("usage: results <jobId> <out.json>");
      const res = await fetch(`${API}/api/jobs/${sub}/results`, { headers: { cookie: `${cookieName}=${SESSION}` } });
      if (!res.ok) die(`${res.status}: ${(await res.text()).slice(0, 300)}`);
      const target = path.resolve(out);
      if (path.extname(target) !== ".json") die("results are saved as a .json file");
      const parsed = (await res.json()) as { items?: unknown };
      if (!Array.isArray(parsed.items)) die("unexpected results format");
      // Re-serialised from the parsed result, never the raw response bytes.
      // "wx" creates the file atomically and fails if it already exists.
      try {
        writeFileSync(target, JSON.stringify({ items: parsed.items }), { flag: "wx" });
      } catch (e) {
        die((e as NodeJS.ErrnoException).code === "EEXIST" ? `${target} already exists; pick a new file name` : String(e));
      }
      console.log(`Saved ${parsed.items.length} results to ${target}`);
      return;
    }
    case "earnings": {
      const r = await call<{ earnings: Record<string, number> }>("GET", "/api/earnings");
      const e = r.earnings;
      console.log(`Compute ${rupees(e.computePayPaise!)} + electricity ${rupees(e.powerReimbursementPaise!)} = ${rupees(e.balancePaise!)} (demo mode)`);
      return;
    }
    default:
      die("commands: node add|list|window|pause|resume, quote, confirm, status, results, earnings (see the top of scripts/nightshift.ts)");
  }
}

main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
