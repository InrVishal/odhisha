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

async function session(client: pg.Client, email: string, role: "user" | "admin" = "user"): Promise<string> {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await client.query(`insert into "user" (id, email, "emailVerified", role) values ($1, $2, now(), $3)`, [id, email, role]);
  await client.query(`insert into "session" ("sessionToken", "userId", expires) values ($1, $2, now() + interval '1 hour')`, [token, id]);
  sessionTokens[email.split("-")[0]!] = token;
  return `__Secure-authjs.session-token=${token}`;
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
  // For the signed-in dashboard browser tests that run next (tests/e2e/dashboard.spec.ts).
  await session(client, `admin-${suffix}@ci.nightshift.test`, "admin");
  await client.end();
  log("owner, buyer and admin sessions created in the preview database");

  const reg = await api<{ node: { id: string }; token: string }>(owner, "POST", "/api/nodes", { name: "CI runner", gpuClass: "cpu" });
  await api(owner, "PATCH", `/api/nodes/${reg.node.id}`, { nightWindowStartMin: 0, nightWindowEndMin: 0 });
  log(`node ${reg.node.id.slice(0, 8)} registered (cpu class, all-day window)`);

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

    const agent = await run("nightshift-agent", ["start", "--once", "--no-gpu", "--cpu-watts", "65"], { env, timeout: 15 * 60_000 });
    for (const line of agent.stdout.trim().split("\n").concat(agent.stderr.trim().split("\n"))) if (line) log(`agent: ${line}`);

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
    const reg2 = await api<{ node: { id: string }; token: string }>(owner, "POST", "/api/nodes", { name: "CI checker", gpuClass: "cpu" });
    await api(owner, "PATCH", `/api/nodes/${reg2.node.id}`, { nightWindowStartMin: 0, nightWindowEndMin: 0 });
    const login2 = run("nightshift-agent", ["login", "-", "--api", BASE], { env: env2 });
    login2.child.stdin!.end(`${reg2.token}\n`);
    await login2;
    log(`second node ${reg2.node.id.slice(0, 8)} registered to check the first one's work`);
    const checker = await run("nightshift-agent", ["start", "--once", "--no-gpu", "--cpu-watts", "65"], { env: env2, timeout: 15 * 60_000 });
    for (const line of checker.stdout.trim().split("\n").concat(checker.stderr.trim().split("\n"))) if (line) log(`checker: ${line}`);
    const checked = await api<{ job: { status: string; checks: { planned: number; matched: number; corrected: number; inconclusive: number; waiting: number } } }>(buyer, "GET", `/api/jobs/${jobId}`);
    log(`job checks: ${JSON.stringify(checked.job.checks)}`);
    if (checked.job.checks.planned !== 1 || checked.job.checks.matched !== 1) fail("the piece should have been re-run on the second PC and matched");
    const trust = await api<{ nodes: Array<{ id: string; trustScore: number; checksPassed: number; checksFailed: number }> }>(owner, "GET", "/api/nodes");
    for (const n of trust.nodes) {
      log(`node ${n.id.slice(0, 8)}: trust ${n.trustScore}, checks passed ${n.checksPassed}, failed ${n.checksFailed}`);
      if (n.trustScore !== 520 || n.checksPassed !== 1 || n.checksFailed !== 0) fail("both PCs should have passed the check (trust 500 → 520)");
    }
    log("PASS: the piece was re-run on a second PC, the results matched, and both PCs' trust went up");

    // Hand the sessions and the finished job to the dashboard browser tests.
    // A private temp file, never printed: the tokens are live for an hour.
    const authFile = process.env.E2E_AUTH_FILE;
    if (authFile) {
      writeFileSync(authFile, JSON.stringify({ ...sessionTokens, jobId, nodeId: reg.node.id }), { mode: 0o600 });
      log("sessions handed to the dashboard browser tests");
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(state2, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
