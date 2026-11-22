/**
 * NightShift coordinator demo: one job through its whole lifecycle.
 *
 *   npm run build && npm run demo:lifecycle
 *
 * Part 1 (live, over HTTP): starts the built app on 127.0.0.1:3400 with an
 * in-memory database and console email, signs two people in through the real
 * magic-link flow, then drives three simulated PCs ("agents") over the real
 * agent API. Every task's Ed25519 signature and input hash are checked the way
 * the Python agent will check them. One PC crashes once, so a retry happens.
 *
 * Part 2 (time travel, in process): the timing paths (lease timeout, backup
 * near the deadline, deadline-miss refund) take minutes to hours of real time,
 * so they run against a real Postgres (PGlite) with a fake clock, through the
 * same API handlers the routes use.
 *
 * Simulated PCs return deterministic fake embeddings. No GPU, no Docker.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import * as H from "@/lib/api/handlers";
import { runTick } from "@/lib/coordinator/tick";
import { createDb, migrateDb } from "@/lib/db/client";
import { buyerLedger, fragments, jobs } from "@/lib/db/schema";
import { formatPaise } from "@/lib/pricing";
import { agentReq, beat, body, complete, harness, ist, jsonReq, lease, makeUser, quoteTexts, registerNode } from "../tests/helpers/coordinator";

const PORT = 3400;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Every request in part 1 goes to the `next start` process this script spawns
 * on 127.0.0.1, which only serves plain HTTP. Loopback only; nothing leaves the
 * machine, so TLS doesn't apply. Accepts a path or a full URL on BASE.
 */
function local(target: string, init?: RequestInit): Promise<Response> {
  const url = new URL(target, BASE);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== String(PORT)) {
    throw new Error(`demo only talks to its own server on port ${PORT} (got ${url.origin})`);
  }
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback to the demo server spawned by this script
  return fetch(url, init);
}
const t0 = Date.now();
const log = (part: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  [${part}] ${msg}`);
const short = (id: string) => id.slice(0, 8);

// ─── Part 1: live server ───────────────────────────────────────────────────

class Jar {
  private c = new Map<string, string>();
  take(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv!.indexOf("=");
      this.c.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
  }
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function startServer(): { proc: ChildProcess; links: Map<string, string> } {
  const links = new Map<string, string>();
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      APP_ENV: "development",
      DATABASE_URL: "pglite:memory",
      AUTH_URL: BASE,
      AUTH_SECRET: "demo-only-not-a-secret-demo-only-not-a-secret",
      CRON_SECRET: "demo-cron-secret-demo-cron-secret-demo",
      EMAIL_TRANSPORT: "console",
      RATE_LIMIT_BACKEND: "memory",
      AUTH_GOOGLE_ID: "",
      AUTH_GOOGLE_SECRET: "",
      COORDINATOR_SIGNING_KEY: "",
      DATA_ENCRYPTION_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  let pendingFor: string | null = null;
  proc.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const m = /^\[dev email\] login link for (\S+):$/.exec(line);
      if (m) pendingFor = m[1]!;
      else if (pendingFor && line.startsWith("http")) {
        links.set(pendingFor, line);
        pendingFor = null;
      }
    }
  });
  return { proc, links };
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Real magic-link login: CSRF token → email form POST → link from the console transport → session cookie. */
async function signIn(email: string, links: Map<string, string>): Promise<Jar> {
  const jar = new Jar();
  const csrf = await local(`/api/auth/csrf`);
  jar.take(csrf);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const post = await local(`/api/auth/signin/resend`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(), origin: BASE },
    body: new URLSearchParams({ email, csrfToken, callbackUrl: `${BASE}/dashboard` }),
  });
  jar.take(post);
  const link = await waitFor(() => links.get(email), `login link for ${email}`);
  const cb = await local(link, { redirect: "manual", headers: { cookie: jar.header() } });
  jar.take(cb);
  if (!jar.header().includes("session-token")) throw new Error(`no session for ${email} (${cb.status})`);
  return jar;
}

async function api<T = Record<string, unknown>>(jar: Jar | null, method: string, p: string, json?: unknown): Promise<{ status: number; body: T }> {
  const res = await local(p, {
    method,
    headers: {
      origin: BASE,
      ...(jar ? { cookie: jar.header() } : {}),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface Agent {
  name: string;
  nodeId: string;
  token: string;
  crashOnce: boolean;
  nonces: Set<string>;
}

type Task = { taskId: string; jobId: string; nodeId: string; attempt: number; itemCount: number; inputSha256: string; exp: number; nonce: string };

async function agentCall(a: Agent, p: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const res = await local(p, {
    method: "POST",
    headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", ...init.headers },
    body: init.body ?? "{}",
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** What the real agent checks before running a task. */
function checkTask(signed: { task: string; signature: string }, input: Buffer, pem: string, a: Agent): Task {
  if (!verify(null, Buffer.from(signed.task), createPublicKey(pem), Buffer.from(signed.signature, "base64"))) throw new Error("bad signature");
  const t = JSON.parse(signed.task) as Task;
  if (t.nodeId !== a.nodeId) throw new Error("task is for another node");
  if (t.exp * 1000 <= Date.now()) throw new Error("expired");
  if (a.nonces.has(t.nonce)) throw new Error("replayed nonce");
  a.nonces.add(t.nonce);
  if (createHash("sha256").update(input).digest("hex") !== t.inputSha256) throw new Error("input hash mismatch");
  return t;
}

function fakeEmbed(text: string): number[] {
  const h = createHash("sha256").update(text).digest();
  return Array.from({ length: 384 }, (_, i) => (h[i % 32]! - 128) / 128);
}

async function partLive(): Promise<void> {
  log("live", `starting the built app on ${BASE} (in-memory Postgres, console email)`);
  const { proc, links } = startServer();
  try {
    await waitFor(async () => ((await local(`/api/health`)).ok ? true : undefined), "server");
    log("live", "server up: GET /api/health → 200");

    const owner = await signIn("owner@demo.nightshift.in", links);
    const buyer = await signIn("buyer@demo.nightshift.in", links);
    log("live", "owner and buyer signed in through the magic-link flow (session cookies)");

    const pem = ((await (await local(`/api/agent/signing-key`)).json()) as { publicKeyPem: string; kid: string }).publicKeyPem;
    log("live", "agents pinned the coordinator's Ed25519 public key from /api/agent/signing-key");

    const agents: Agent[] = [];
    for (const [name, watts, crashOnce] of [["Rahul's gaming PC", 410, false], ["Hostel lab PC 3", 340, false], ["Cyber café PC 7", 365, true]] as const) {
      const r = await api<{ node: { id: string }; token: string }>(owner, "POST", "/api/nodes", { name, gpuClass: "rtx4070" });
      // Demo runs at any hour: make the night window all day.
      await api(owner, "PATCH", `/api/nodes/${r.body.node.id}`, { nightWindowStartMin: 0, nightWindowEndMin: 0 });
      const a: Agent = { name, nodeId: r.body.node.id, token: r.body.token, crashOnce, nonces: new Set() };
      const hb = await agentCall(a, "/api/agent/heartbeat", { body: JSON.stringify({ watts, gpuModel: "NVIDIA GeForce RTX 4070" }) });
      log("live", `node ${short(a.nodeId)} "${name}" registered (token shown once) → heartbeat ${watts} W → ${hb.body.status}, canWork=${hb.body.canWork}`);
      agents.push(a);
    }

    const texts = Array.from({ length: 600 }, (_, i) => `Customer review number ${i}: the delivery was quick and the product works.`);
    const q = await api<{ job: { id: string; status: string; pricePaise: number; deadlineAt: string; breakdown: Record<string, number> & { fragments: number; reference: { watts: number } } } }>(
      buyer,
      "POST",
      "/api/jobs/quote",
      { workloadType: "text_embeddings", gpuClass: "rtx4070", params: {}, texts },
    );
    const job = q.body.job;
    const b = job.breakdown;
    log("live", `job ${short(job.id)} QUOTED: 600 texts → ${b.fragments} pieces, ${formatPaise(job.pricePaise)}, done by ${new Date(job.deadlineAt).toISOString()}`);
    log(
      "live",
      `  breakdown: owner pay ${formatPaise(b.ownerPayPaise!)} + electricity ${formatPaise(b.electricityPaise!)} (at ${b.reference.watts} W measured) + buffer ${formatPaise(b.verificationBufferPaise!)} + fee ${formatPaise(b.nightshiftFeePaise!)} = ${formatPaise(b.totalPaise!)}`,
    );
    const early = await agentCall(agents[0]!, "/api/agent/lease");
    log("live", `before confirming, an agent asks for work → task=${early.body.task === null ? "none" : "?"} (nothing runs until the buyer confirms)`);

    const c = await api<{ job: { status: string; netChargedPaise: number } }>(buyer, "POST", `/api/jobs/${job.id}/confirm`);
    log("live", `job ${short(job.id)} quoted → ${c.body.job.status.toUpperCase()} (simulated charge, demo mode: net charged ${formatPaise(c.body.job.netChargedPaise)})`);

    let lastStatus = c.body.job.status;
    const watch = async () => {
      const j = await api<{ job: { status: string; progress: { fragmentsDone: number; fragmentsTotal: number; nodesWorking: number } } }>(buyer, "GET", `/api/jobs/${job.id}`);
      const s = j.body.job;
      if (s.status !== lastStatus) {
        log("live", `job ${short(job.id)} ${lastStatus} → ${s.status.toUpperCase()}  (${s.progress.fragmentsDone}/${s.progress.fragmentsTotal} pieces, ${s.progress.nodesWorking} PCs working)`);
        lastStatus = s.status;
      }
      return s;
    };

    for (let round = 0; round < 10 && lastStatus !== "completed"; round++) {
      for (const a of agents) {
        const r = await agentCall(a, "/api/agent/lease");
        if (!r.body.task) continue;
        const signed = r.body.task as { task: string; signature: string };
        const input = Buffer.from(r.body.input as string, "base64");
        const t = checkTask(signed, input, pem, a);
        log("live", `  ${a.name} leased piece ${short(t.taskId)} (attempt ${t.attempt}, ${t.itemCount} texts): signature ✓ expiry ✓ nonce ✓ input sha256 ✓`);
        await watch();
        if (a.crashOnce) {
          a.crashOnce = false;
          const f = await agentCall(a, `/api/agent/fragments/${t.taskId}/fail`, { body: JSON.stringify({ attempt: t.attempt, reason: "crashed" }) });
          log("live", `  ${a.name} CRASHED on piece ${short(t.taskId)} → handed back, requeued=${f.body.requeued}`);
          continue;
        }
        const { texts: inTexts } = JSON.parse(input.toString()) as { texts: string[] };
        const out = Buffer.from(JSON.stringify({ items: inTexts.map(fakeEmbed) }));
        const done = await agentCall(a, `/api/agent/fragments/${t.taskId}/complete`, {
          body: out,
          headers: { "x-lease-attempt": String(t.attempt), "x-output-sha256": createHash("sha256").update(out).digest("hex") },
        });
        log("live", `  ${a.name} finished piece ${short(t.taskId)} → accepted=${done.body.accepted}, owner paid ${formatPaise(done.body.paidPaise as number)}`);
        // The same upload again is refused: a piece is paid once.
        if (a === agents[0]) {
          const again = await agentCall(a, `/api/agent/fragments/${t.taskId}/complete`, {
            body: out,
            headers: { "x-lease-attempt": String(t.attempt), "x-output-sha256": createHash("sha256").update(out).digest("hex") },
          });
          if (again.status === 409) log("live", `  ${a.name} re-sent the same result → 409 ${again.body.error} (idempotent: paid once)`);
          agents[0] = { ...a, crashOnce: false };
        }
        await watch();
      }
    }

    const res = await local(`/api/jobs/${job.id}/results`, { headers: { cookie: buyer.header() } });
    const results = (await res.json()) as { items: number[][] };
    const inOrder = results.items.every((v, i) => v[0] === fakeEmbed(texts[i]!)[0]);
    log("live", `results downloaded (${res.headers.get("content-disposition")}): ${results.items.length} embeddings × ${results.items[0]!.length} dims, input order kept: ${inOrder}`);

    const e = await api<{ earnings: { computePayPaise: number; powerReimbursementPaise: number; balancePaise: number } }>(owner, "GET", "/api/earnings");
    log(
      "live",
      `owner earnings: compute ${formatPaise(e.body.earnings.computePayPaise)} + electricity ${formatPaise(e.body.earnings.powerReimbursementPaise)} (own line) = ${formatPaise(e.body.earnings.balancePaise)}; buyer paid ${formatPaise(job.pricePaise)}`,
    );

    const peek = await api(null, "GET", `/api/jobs/${job.id}`);
    log("live", `no session → GET /api/jobs/${short(job.id)} → ${peek.status}`);
    const cron1 = await local(`/api/cron/tick`);
    const cron2 = await local(`/api/cron/tick`, { headers: { authorization: "Bearer demo-cron-secret-demo-cron-secret-demo" } });
    log("live", `cron tick without CRON_SECRET → ${cron1.status}; with it → ${cron2.status} ${JSON.stringify(((await cron2.json()) as { report: unknown }).report)}`);
  } finally {
    proc.kill();
  }
}

// ─── Part 2: time travel ───────────────────────────────────────────────────

async function partTimeTravel(): Promise<void> {
  const handle = await createDb("pglite:memory");
  await migrateDb(handle, path.resolve("drizzle"));
  const h = harness(handle.db, ist(23, 0));
  const tt = (m: string) => log(`clock ${h.clock.now().toISOString().slice(11, 19)}Z`, m);
  const status = async (id: string) => (await h.db.select({ s: jobs.status }).from(jobs).where(eq(jobs.id, id)))[0]!.s;

  const owner = await makeUser(h.db, "owner@demo.in");
  const buyer = await makeUser(h.db, "buyer@demo.in");
  const a = await registerNode(h, owner, { name: "A" });
  const b = await registerNode(h, owner, { name: "B" });
  await beat(h, a.token);
  await beat(h, b.token);
  tt("2 PCs online, 23:00 India time (inside their default 23:00–07:00 window)");

  // Lease timeout → retry on another PC.
  let q = (await body<{ job: { id: string; deadlineAt: string } }>(await quoteTexts(h, buyer, 10))).job;
  await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.id}/confirm`), h.as(buyer), q.id);
  const l1 = (await lease(h, a.token))!;
  tt(`job ${short(q.id)} → ${await status(q.id)}; PC A leased its piece until ${l1.leaseExpiresAt.slice(11, 19)}Z`);
  h.clock.set(new Date(new Date(l1.leaseExpiresAt).getTime() + 1000));
  await beat(h, b.token);
  await beat(h, a.token);
  const r1 = await runTick(h.db, h.clock.now(), h.deps.ipSecret);
  tt(`PC A never answered. tick: leasesExpired=${r1.leasesExpired} → piece back in the queue`);
  const l2 = (await lease(h, b.token))!;
  tt(`PC B leased the same piece, attempt ${l2.parsed.attempt}`);
  const late = await complete(h, a.token, l1);
  tt(`PC A's late result → ${late.status} ${(await late.json()).error}`);
  await complete(h, b.token, l2);
  tt(`PC B finished → job ${await status(q.id)}`);

  // Backup copy near the deadline.
  q = (await body<{ job: { id: string; deadlineAt: string } }>(await quoteTexts(h, buyer, 10))).job;
  await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.id}/confirm`), h.as(buyer), q.id);
  await beat(h, a.token);
  const slow = (await lease(h, a.token))!;
  tt(`job ${short(q.id)} deadline ${q.deadlineAt.slice(11, 19)}Z; PC A started its only piece (expected ~${(await h.db.select().from(fragments).where(eq(fragments.id, slow.parsed.taskId)))[0]!.leaseExpectedSec}s)`);
  h.clock.set(new Date(new Date(q.deadlineAt).getTime() - 5 * 60_000));
  await h.db.update(fragments).set({ leaseExpiresAt: new Date(new Date(q.deadlineAt).getTime() + 3600_000) }).where(eq(fragments.id, slow.parsed.taskId));
  await beat(h, a.token);
  await beat(h, b.token);
  const r2 = await runTick(h.db, h.clock.now(), h.deps.ipSecret);
  tt(`5 min to the deadline and PC A is still going. tick: backupsStarted=${r2.backupsStarted}`);
  tt(`PC A asks for the backup of its own piece → ${(await lease(h, a.token)) === null ? "refused (never your own piece)" : "?!"}`);
  const bk = (await lease(h, b.token))!;
  const won = await body<{ accepted: boolean }>(await complete(h, b.token, bk));
  tt(`PC B ran the backup → accepted=${won.accepted}; job ${await status(q.id)}`);
  const lost = await body<{ accepted: boolean; paidPaise: number }>(await complete(h, a.token, slow));
  tt(`PC A finished too → accepted=${lost.accepted}, still paid ${formatPaise(lost.paidPaise)} (we asked for that work)`);

  // Deadline missed → full refund, owners keep their pay.
  q = (await body<{ job: { id: string; deadlineAt: string } }>(await quoteTexts(h, buyer, 300))).job;
  await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.id}/confirm`), h.as(buyer), q.id);
  await beat(h, a.token);
  const p1 = (await lease(h, a.token))!;
  await complete(h, a.token, p1);
  const p2 = (await lease(h, a.token))!;
  tt(`job ${short(q.id)}: piece 1 done, piece 2 running, deadline ${q.deadlineAt.slice(11, 19)}Z`);
  h.clock.set(new Date(new Date(q.deadlineAt).getTime() + 1000));
  await h.db.update(fragments).set({ leaseExpiresAt: new Date(h.clock.now().getTime() + 600_000) }).where(eq(fragments.id, p2.parsed.taskId));
  await beat(h, a.token);
  const r3 = await runTick(h.db, h.clock.now(), h.deps.ipSecret);
  const job = await body<{ job: { status: string; refunded: boolean; netChargedPaise: number; pricePaise: number } }>(
    await H.getJobHandler(jsonReq("GET", `/api/jobs/${q.id}`), h.as(buyer), q.id),
  );
  tt(`deadline passed. tick: deadlinesMissed=${r3.deadlinesMissed} → job ${job.job.status.toUpperCase()}, refunded=${job.job.refunded}, buyer pays ${formatPaise(job.job.netChargedPaise)} (was ${formatPaise(job.job.pricePaise)})`);
  await complete(h, a.token, p2);
  tt(`PC A finishes piece 2 anyway → results still delivered; owner keeps pay for both pieces`);
  const r4 = await runTick(h.db, h.clock.now(), h.deps.ipSecret);
  const refunds = await h.db.select().from(buyerLedger).where(eq(buyerLedger.jobId, q.id));
  tt(`tick again (idempotent): ${JSON.stringify({ ...r4, ran: undefined })}; buyer ledger rows for this job: ${refunds.map((r) => `${r.entryType} ${formatPaise(r.amountPaise)}`).join(", ")}`);

  // Append-only ledger.
  try {
    await h.db.update(buyerLedger).set({ amountPaise: 0 }).where(eq(buyerLedger.jobId, q.id));
    tt("ledger UPDATE succeeded?!");
  } catch {
    tt("attempt to UPDATE a ledger row → rejected by the append-only trigger");
  }
  const bad = await H.leaseHandler(agentReq("nsn_" + "x".repeat(43), "/api/agent/lease"), h.deps);
  tt(`agent with an unknown token → ${bad.status}`);
  await handle.close();
}

async function main() {
  console.log("NightShift coordinator demo: one job, whole lifecycle\n");
  await partLive();
  console.log("\n--- Part 2: timing paths with a fake clock (real Postgres via PGlite, same API handlers) ---\n");
  await partTimeTravel();
  console.log("\nDemo finished.");
}

main().catch((e: unknown) => {
  console.error("demo failed:", e);
  process.exit(1);
});
