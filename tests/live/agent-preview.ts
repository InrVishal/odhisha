/**
 * Live integration test: the real Python agent completes a real
 * batch-embedding fragment on this PR's preview deployment, and the buyer
 * downloads the verified result.
 *
 * Runs in CI inside the preview job (it needs that run's preview database to
 * create the test owner's and buyer's sessions):
 *   PREVIEW_URL, PREVIEW_DATABASE_URL, VERCEL_AUTOMATION_BYPASS_SECRET
 * and the agent installed (`nightshift-agent` on PATH) with Docker running.
 *
 * Nothing is mocked: real Postgres (Neon branch), real Vercel deployment,
 * real Ed25519 task signature checked against the key pinned in the agent,
 * real pinned container image, real sandbox flags.
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";

const run = promisify(execFile);
const BASE = (process.env.PREVIEW_URL ?? "").replace(/\/$/, "");
const DB = process.env.PREVIEW_DATABASE_URL ?? "";
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
const log = (m: string) => console.log(`[live] ${m}`);

function fail(msg: string): never {
  console.error(`[live] FAIL: ${msg}`);
  process.exit(1);
}

const sessionTokens: Record<string, string> = {};

async function session(client: pg.Client, email: string): Promise<string> {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await client.query(`insert into "user" (id, email, "emailVerified") values ($1, $2, now())`, [id, email]);
  await client.query(`insert into "session" ("sessionToken", "userId", expires) values ($1, $2, now() + interval '1 hour')`, [token, id]);
  sessionTokens[email.split("-")[0]!] = token;
  return `__Secure-authjs.session-token=${token}`;
}

/** The preview's ADMIN_EMAILS (set by the CI deploy step): the second key for admin. */
const CI_ADMIN_EMAIL = "admin@ci.nightshift.test";

/**
 * The CI admin, made the way production makes one: role set by the database
 * owner role (this connection), the email on ADMIN_EMAILS, and a fresh login.
 * Its authenticator is reset every run, so the browser test sets one up.
 */
async function adminSession(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `insert into "user" (id, email, "emailVerified", role) values ($1, $2, now(), 'admin')
     on conflict (email) do update set "emailVerified" = now() returning id`,
    [randomUUID(), CI_ADMIN_EMAIL],
  );
  const id = rows[0]!.id;
  await client.query("delete from admin_totp where user_id = $1", [id]);
  const token = randomBytes(32).toString("base64url");
  await client.query(`insert into "session" ("sessionToken", "userId", expires) values ($1, $2, now() + interval '1 hour')`, [token, id]);
  sessionTokens.admin = token;
}

/**
 * Runs `nightshift-agent start --once` (one piece per run) until `done()`.
 * A new PC's first piece is a coordinator challenge, so real work comes after.
 */
async function runAgentUntil(label: string, env: NodeJS.ProcessEnv, done: () => Promise<boolean>, maxRuns = 3): Promise<void> {
  for (let i = 0; i < maxRuns; i++) {
    const out = await run("nightshift-agent", ["start", "--once", "--no-gpu", "--cpu-watts", "65"], { env, timeout: 15 * 60_000 });
    for (const line of out.stdout.trim().split("\n").concat(out.stderr.trim().split("\n"))) if (line) log(`${label}: ${line}`);
    if (await done()) return;
  }
  fail(`${label} didn't finish its work in ${maxRuns} pieces`);
}

async function api<T = Record<string, unknown>>(cookie: string, method: string, p: string, json?: unknown): Promise<T> {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      cookie,
      origin: BASE,
      "x-vercel-protection-bypass": BYPASS,
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  if (!BASE.startsWith("https://") || !DB) fail("PREVIEW_URL and PREVIEW_DATABASE_URL are required");
  const trust = readFileSync(path.resolve("agent/src/nightshift_agent/trust.py"), "utf8");
  if (!/"text_embeddings":\s*WorkloadPin\(\s*image="[^"]+@sha256:[0-9a-f]{64}"/.test(trust)) {
    // Only on the bootstrap commit, before the first image build is pinned.
    console.log("::warning::Live agent test skipped: the text_embeddings image isn't pinned in trust.py yet");
    return;
  }

  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const suffix = randomBytes(4).toString("hex");
  const owner = await session(client, `owner-${suffix}@ci.nightshift.test`);
  const buyer = await session(client, `buyer-${suffix}@ci.nightshift.test`);
  // A second owner for the checking PC: a check by the same owner's PC earns no trust.
  const owner2 = await session(client, `checker-${suffix}@ci.nightshift.test`);
  await client.end();
  log("owner and buyer sessions created in the preview database");

  const reg = await api<{ node: { id: string }; token: string }>(owner, "POST", "/api/nodes", { name: "CI runner", gpuClass: "cpu" });
  // Time-Bank: this PC earns credits (not compute pay) for the buyer's piece.
  await api(owner, "PATCH", `/api/nodes/${reg.node.id}`, { nightWindowStartMin: 0, nightWindowEndMin: 0, earnsCredits: true });
  log(`node ${reg.node.id.slice(0, 8)} registered (cpu class, all-day window, earns Time-Bank credits)`);

  const state = mkdtempSync(path.join(tmpdir(), "ns-agent-"));
  const env = { ...process.env, NIGHTSHIFT_STATE_DIR: state, NIGHTSHIFT_NO_KEYRING: "1", NIGHTSHIFT_VERCEL_BYPASS: BYPASS };
  // A second agent (its own state, token and node) for the verification check.
  const state2 = mkdtempSync(path.join(tmpdir(), "ns-agent-"));
  const env2 = { ...env, NIGHTSHIFT_STATE_DIR: state2 };
  try {
    const login = run("nightshift-agent", ["login", "-", "--api", BASE], { env });
    login.child.stdin!.end(`${reg.token}\n`);
    log((await login).stdout.trim());

    const texts = Array.from({ length: 20 }, (_, i) => `NightShift CI sentence ${i}: idle GPUs, pooled overnight.`);
    const quoted = await api<{ job: { id: string; pricePaise: number; deadlineAt: string } }>(buyer, "POST", "/api/jobs/quote", {
      workloadType: "text_embeddings",
      gpuClass: "cpu",
      params: {},
      texts,
    });
    const jobId = quoted.job.id;
    await api(buyer, "POST", `/api/jobs/${jobId}/confirm`);
    log(`job ${jobId.slice(0, 8)} quoted at ${quoted.job.pricePaise} paise, done by ${quoted.job.deadlineAt}; confirmed`);

    // A new PC's first piece is a coordinator challenge; the job's piece comes next.
    await runAgentUntil("agent", env, async () => (await api<{ job: { status: string } }>(buyer, "GET", `/api/jobs/${jobId}`)).job.status === "completed");

    const job = await api<{ job: { status: string; progress: { fragmentsDone: number; fragmentsTotal: number } } }>(buyer, "GET", `/api/jobs/${jobId}`);
    log(`job status ${job.job.status}, ${job.job.progress.fragmentsDone}/${job.job.progress.fragmentsTotal} pieces`);
    if (job.job.status !== "completed") fail(`job is ${job.job.status}, expected completed`);

    const res = await fetch(`${BASE}/api/jobs/${jobId}/results`, { headers: { cookie: buyer, "x-vercel-protection-bypass": BYPASS } });
    if (!res.ok) fail(`results → ${res.status}`);
    if (!/^attachment;/.test(res.headers.get("content-disposition") ?? "")) fail("results aren't served as an attachment");
    const { items } = (await res.json()) as { items: number[][] };
    if (items.length !== texts.length) fail(`got ${items.length} embeddings, expected ${texts.length}`);
    for (const v of items) {
      if (v.length !== 384 || !v.every(Number.isFinite)) fail("an embedding isn't 384 finite numbers");
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      if (Math.abs(norm - 1) > 1e-3) fail(`embedding not normalised (|v| = ${norm})`);
    }
    // Different sentences must give different vectors (not a constant stub).
    if (items[0]!.every((x, i) => x === items[1]![i])) fail("two different sentences gave the same embedding");

    const nodes = await api<{ nodes: Array<{ measuredWatts: number | null; wattsEstimated: boolean }> }>(owner, "GET", "/api/nodes");
    const earnings = await api<{ earnings: { computePayPaise: number; powerReimbursementPaise: number } }>(owner, "GET", "/api/earnings");
    log(`owner: watts ${nodes.nodes[0]?.measuredWatts} (estimated=${nodes.nodes[0]?.wattsEstimated}), paid ${earnings.earnings.computePayPaise} + ${earnings.earnings.powerReimbursementPaise} paise electricity`);
    if (!nodes.nodes[0]?.wattsEstimated) fail("CPU mode watts should be marked estimated");
    log(`PASS: ${items.length} embeddings × 384 dims downloaded by the buyer, all normalised`);

    // Verification: a one-piece job always has its piece checked. A second PC
    // (another real agent, another real container) re-runs it, and the
    // coordinator compares the two results.
    const reg2 = await api<{ node: { id: string }; token: string }>(owner2, "POST", "/api/nodes", { name: "CI checker", gpuClass: "cpu" });
    await api(owner2, "PATCH", `/api/nodes/${reg2.node.id}`, { nightWindowStartMin: 0, nightWindowEndMin: 0 });
    const login2 = run("nightshift-agent", ["login", "-", "--api", BASE], { env: env2 });
    login2.child.stdin!.end(`${reg2.token}\n`);
    await login2;
    log(`second node ${reg2.node.id.slice(0, 8)} registered to check the first one's work`);
    await runAgentUntil("checker", env2, async () => (await api<{ job: { checks: { matched: number } } }>(buyer, "GET", `/api/jobs/${jobId}`)).job.checks.matched === 1);
    const checked = await api<{ job: { status: string; checks: { planned: number; matched: number; corrected: number; inconclusive: number; waiting: number } } }>(buyer, "GET", `/api/jobs/${jobId}`);
    log(`job checks: ${JSON.stringify(checked.job.checks)}`);
    if (checked.job.checks.planned !== 1 || checked.job.checks.matched !== 1) fail("the piece should have been re-run on the second PC and matched");
    type TrustRow = { id: string; trustScore: number; checksPassed: number; checksFailed: number };
    const trust = [
      ...(await api<{ nodes: TrustRow[] }>(owner, "GET", "/api/nodes")).nodes,
      ...(await api<{ nodes: TrustRow[] }>(owner2, "GET", "/api/nodes")).nodes,
    ];
    for (const n of trust) {
      log(`node ${n.id.slice(0, 8)}: trust ${n.trustScore}, checks passed ${n.checksPassed}, failed ${n.checksFailed}`);
      // At least the cross-check; a known-answer canary (sent at random, as in
      // production) is one more pass. Each pass is +20 from 500, nothing failed.
      if (n.checksPassed < 1 || n.checksFailed !== 0 || n.trustScore !== 500 + 20 * n.checksPassed) fail("both PCs should have passed every check (trust 500 + 20 per pass)");
    }
    log("PASS: the piece was re-run on a second PC, the results matched, and both PCs' trust went up");

    // Time-Bank: the first PC's piece earned credits, pending until that check matched.
    const credits = await api<{ wallet: { availableSec: number; pendingSec: number; earnedSec: number }; cashable: boolean; weighting: string }>(owner, "GET", "/api/credits");
    log(`owner credits: ${JSON.stringify(credits.wallet)} (weighting ${credits.weighting}, cashable=${credits.cashable})`);
    if (credits.wallet.earnedSec <= 0 || credits.wallet.availableSec !== credits.wallet.earnedSec || credits.wallet.pendingSec !== 0 || credits.cashable) {
      fail("the checked piece should have earned credits that are now verified and available, and not cashable");
    }
    log("PASS: the piece earned Time-Bank credits, released once its check matched");

    // Each PC's first piece was a coordinator challenge: a known-answer
    // canary, timed on the coordinator's clock. A real model must pass it.
    const db2 = new pg.Client({ connectionString: DB });
    await db2.connect();
    try {
      const ids = [reg.node.id, reg2.node.id];
      const samples = await db2.query<{ node_id: string; items: number; millis: number }>(
        "select node_id, items, millis from benchmark_sample where node_id = any($1) order by created_at",
        [ids],
      );
      const canaryFails = await db2.query("select 1 from audit_log where action = 'node.canary_failed' and target_id = any($1)", [ids]);
      for (const r of samples.rows) {
        log(`challenge passed by node ${r.node_id.slice(0, 8)}: ${r.items} sentences in ${(r.millis / 1000).toFixed(1)} s (coordinator's clock)`);
      }
      if (samples.rows.length < 2 || canaryFails.rows.length > 0) fail("each real agent should have passed one challenge (canary) and been timed");
      log("PASS: both real agents passed their coordinator challenge (canary) and were timed by the coordinator");

      // Sybil: both agents run on this one CI machine, under two accounts.
      // The coordinator must notice the shared device and network.
      const owners = await db2.query<{ id: string }>("select owner_id as id from node where id = any($1)", [ids]);
      const [o1, o2] = owners.rows.map((r) => r.id);
      const flags = await db2.query<{ kind: string }>(
        "select meta->>'kind' as kind from audit_log where action = 'sybil.flagged' and meta->>'accounts' like $1 and meta->>'accounts' like $2",
        [`%${o1}%`, `%${o2}%`],
      );
      const kinds = [...new Set(flags.rows.map((r) => r.kind))].sort();
      log(`sybil flags for the two CI accounts: ${JSON.stringify(kinds)}`);
      if (!kinds.includes("device") || !kinds.includes("subnet")) fail("two accounts on one machine should be flagged for the shared device and network");

      // C: the deployment talks to the database as app_runtime, never as the owner.
      await fetch(`${BASE}/api/health`, { headers: { "x-vercel-protection-bypass": BYPASS } });
      const who = await db2.query<{ usename: string }>(
        "select distinct usename from pg_stat_activity where datname = current_database() and usename is not null and pid <> pg_backend_pid() and backend_type = 'client backend'",
      );
      const roles = who.rows.map((r) => r.usename).sort();
      log(`database roles connected to the preview database (besides this test): ${JSON.stringify(roles)}`);
      if (!roles.includes("app_runtime")) fail("the deployment should connect as app_runtime");
      const runtimeLog = await db2.query("select 1 from audit_log where action = 'admin.role_change_refused'");
      log(`role changes refused so far on this branch: ${runtimeLog.rows.length}`);
      log("PASS: the app's own connections are app_runtime (least privilege)");
      log("PASS: two accounts on one machine were flagged (same device, same network); the check still ran because previews only report (SYBIL_CHECKER_RULES=report)");
    } finally {
      await db2.end();
    }

    // Hand the sessions and the finished job to the dashboard browser tests.
    // A private temp file, never printed: the tokens are live for an hour.
    const authFile = process.env.E2E_AUTH_FILE;
    if (authFile) {
      // The admin logs in last: admin pages need a login from the last 15 minutes.
      const c3 = new pg.Client({ connectionString: DB });
      await c3.connect();
      await adminSession(c3);
      await c3.end();
      writeFileSync(authFile, JSON.stringify({ ...sessionTokens, jobId, nodeId: reg.node.id }), { mode: 0o600 });
      log("sessions handed to the dashboard browser tests");
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(state2, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
