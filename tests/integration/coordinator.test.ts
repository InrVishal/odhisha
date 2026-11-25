import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as H from "@/lib/api/handlers";
import { CLASS_SPECS } from "@/lib/coordinator/classes";
import { fragmentPay } from "@/lib/coordinator/schedule";
import { toNodeView } from "@/lib/coordinator/nodes";
import { maybeTick, runTick } from "@/lib/coordinator/tick";
import type { Db } from "@/lib/db/client";
import { blobs, buyerLedger, fragments, jobs, nodes, ownerLedger } from "@/lib/db/schema";
import { ownerEarnings } from "@/lib/ledger";
import { powerCostPerHourPaise } from "@/lib/pricing";
import { sha256Hex, verifySignedTask } from "@/lib/security/signing";
import { freshDb } from "../helpers/db";
import {
  beat,
  body,
  complete,
  embeddingsFor,
  harness,
  ist,
  jsonReq,
  lease,
  makeUser,
  quoteTexts,
  registerNode,
  type Harness,
} from "../helpers/coordinator";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

async function setup(): Promise<Harness & { db: Db }> {
  const { db, cleanup } = await freshDb();
  cleanups.push(cleanup);
  return harness(db);
}

let h: Harness;
beforeEach(async () => {
  h = await setup();
});

type JobJson = {
  id: string;
  status: string;
  pricePaise: number;
  deadlineAt: string;
  quoteExpiresAt: string;
  refunded: boolean;
  netChargedPaise: number;
  progress: { fragmentsDone: number; fragmentsTotal: number; nodesWorking: number };
  resultsAvailable: boolean;
  breakdown: { ownerReceivesPaise: number; electricityPaise: number; totalPaise: number; reference: { watts: number; tariffPaisePerKwh: number; ownerRatePaisePerHr: number }; fragments: number };
};

async function quoteAndConfirm(buyer: Awaited<ReturnType<typeof makeUser>>, n: number): Promise<JobJson> {
  const q = await quoteTexts(h, buyer, n);
  expect(q.status).toBe(201);
  const { job } = await body<{ job: JobJson }>(q);
  const c = await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${job.id}/confirm`), h.as(buyer), job.id);
  expect(c.status).toBe(200);
  return (await body<{ job: JobJson }>(c)).job;
}

describe("job lifecycle: quote → confirm → agents run it → results", () => {
  it("runs a 600-text embedding job across two PCs end to end", async () => {
    const owner = await makeUser(h.db, "owner@example.in");
    const buyer = await makeUser(h.db, "buyer@example.in");
    const a = await registerNode(h, owner, { name: "PC A" });
    const b = await registerNode(h, owner, { name: "PC B" });
    // PC A reports real watts; the quote must price with them.
    expect((await beat(h, a.token, { watts: 410, gpuModel: "NVIDIA GeForce RTX 4070" })).status).toBe(200);
    expect((await beat(h, b.token)).status).toBe(200);

    // Quote: price and finish time before anything is charged.
    const q = await quoteTexts(h, buyer, 600);
    expect(q.status).toBe(201);
    const quoted = (await body<{ job: JobJson }>(q)).job;
    expect(quoted.status).toBe("quoted");
    expect(quoted.breakdown.fragments).toBe(3); // 250 + 250 + 100
    expect(quoted.breakdown.reference.watts).toBe(410); // measured, not the 350 W default
    expect(quoted.pricePaise % 100).toBe(0);
    expect(new Date(quoted.deadlineAt) > h.clock.now()).toBe(true);
    expect(new Date(quoted.deadlineAt).getUTCMinutes() % 15).toBe(0);
    expect(quoted.netChargedPaise).toBe(0);
    expect(await h.db.select().from(buyerLedger)).toHaveLength(0);

    // Nothing is handed out before the buyer confirms.
    expect(await lease(h, a.token)).toBeNull();

    const c = await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${quoted.id}/confirm`), h.as(buyer), quoted.id);
    const job = (await body<{ job: JobJson }>(c)).job;
    expect(job.status).toBe("queued");
    expect(job.netChargedPaise).toBe(quoted.pricePaise);

    // Agents pull work, one piece at a time each. Every task verifies against the published key.
    const seen = new Set<string>();
    const take = async (token: string) => {
      const l = await lease(h, token);
      expect(l).not.toBeNull();
      const nodeId = token === a.token ? a.nodeId : b.nodeId;
      const task = verifySignedTask(l!.task, h.keys.publicKey, { nodeId, now: h.clock.now().getTime(), seenNonces: seen });
      expect(sha256Hex(Buffer.from(l!.input, "base64"))).toBe(task.inputSha256);
      expect(task.workload).toBe("text_embeddings");
      return l!;
    };
    const finish = async (token: string, l: NonNullable<Awaited<ReturnType<typeof lease>>>) => {
      const r = await complete(h, token, l);
      expect(r.status).toBe(200);
      expect((await body<{ accepted: boolean }>(r)).accepted).toBe(true);
    };
    const first = await take(a.token);
    const second = await take(b.token);
    // A PC holding a piece gets nothing more until it hands that one in.
    expect(await lease(h, a.token)).toBeNull();

    const mid = (await body<{ job: JobJson }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${job.id}`), h.as(buyer), job.id))).job;
    expect(mid.status).toBe("running");
    expect(mid.progress).toEqual({ fragmentsDone: 0, fragmentsTotal: 3, nodesWorking: 2 });

    h.clock.advance(60);
    await finish(a.token, first);
    const third = await take(a.token);
    await finish(b.token, second);
    await finish(a.token, third);

    const done = (await body<{ job: JobJson }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${job.id}`), h.as(buyer), job.id))).job;
    expect(done.status).toBe("completed");
    expect(done.progress.fragmentsDone).toBe(3);
    expect(done.refunded).toBe(false);
    expect(done.resultsAvailable).toBe(true);

    // Results: one embedding per input, in input order, as a download.
    const res = await H.resultsHandler(jsonReq("GET", `/api/jobs/${job.id}/results`), h.as(buyer), job.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="nightshift-.*\.json"$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const out = (await res.json()) as { items: number[][] };
    expect(out.items).toHaveLength(600);
    expect(out.items.map((v) => v[0])).toEqual(Array.from({ length: 600 }, (_, i) => i));

    // Owners: paid per piece with electricity as its own line, never more
    // in total than the quote's owner share.
    const ea = await ownerEarnings(h.db, owner.id, a.nodeId);
    const eb = await ownerEarnings(h.db, owner.id, b.nodeId);
    expect(ea.powerReimbursementPaise).toBeGreaterThan(0);
    expect(eb.powerReimbursementPaise).toBeGreaterThan(0);
    const totalPaid = ea.balancePaise + eb.balancePaise;
    expect(totalPaid).toBeLessThanOrEqual(quoted.breakdown.ownerReceivesPaise);
    const rows = await h.db.select().from(ownerLedger);
    expect(rows).toHaveLength(6); // power + compute for each of 3 pieces
    const [nodeA] = await h.db.select().from(nodes).where(eq(nodes.id, a.nodeId));
    const frag = await h.db.select().from(fragments).where(and(eq(fragments.jobId, job.id), eq(fragments.completedByNodeId, a.nodeId)));
    const expectA = frag.map((f) => fragmentPay(toNodeView(nodeA!), f.estGpuSeconds)).reduce((s, p) => s + p.electricityPaise + p.ownerPayPaise, 0);
    expect(ea.balancePaise).toBe(expectA);

    // Owner API shows the same, with power separate.
    const e = await body<{ earnings: { powerReimbursementPaise: number; computePayPaise: number } }>(await H.earningsHandler(jsonReq("GET", "/api/earnings"), h.as(owner)));
    expect(e.earnings.powerReimbursementPaise).toBe(ea.powerReimbursementPaise + eb.powerReimbursementPaise);
  });

  it("uses the owner's own tariff and rate once set", async () => {
    const owner = await makeUser(h.db, "o2@example.in");
    const buyer = await makeUser(h.db, "b2@example.in");
    const n = await registerNode(h, owner, { patch: { tariffPaisePerKwh: 1200, ownerRatePaisePerHr: 4000 } });
    await beat(h, n.token);
    const q = (await body<{ job: JobJson }>(await quoteTexts(h, buyer, 10))).job;
    expect(q.breakdown.reference).toEqual({ watts: CLASS_SPECS.rtx4070.defaultWatts, tariffPaisePerKwh: 1200, ownerRatePaisePerHr: 4000 });
    expect(powerCostPerHourPaise(350, 1200)).toBe(420);
  });

  it("refuses a quote when no PC of that class can take it", async () => {
    const buyer = await makeUser(h.db, "b3@example.in");
    const r = await quoteTexts(h, buyer, 10);
    expect(r.status).toBe(503);
    expect((await body(r)).error).toBe("no_capacity");

    const owner = await makeUser(h.db, "o3@example.in");
    const n = await registerNode(h, owner, { patch: { paused: true } });
    await beat(h, n.token);
    expect((await quoteTexts(h, buyer, 10)).status).toBe(503);
    expect((await quoteTexts(h, buyer, 10, "rtx4090")).status).toBe(503);
  });

  it("only quotes during the owners' night window", async () => {
    h.clock.set(ist(12, 0));
    const owner = await makeUser(h.db, "o4@example.in");
    const buyer = await makeUser(h.db, "b4@example.in");
    const n = await registerNode(h, owner);
    const hb = await body<{ canWork: boolean; reason: string }>(await beat(h, n.token));
    expect(hb).toMatchObject({ canWork: false, reason: "outside_window" });
    expect((await quoteTexts(h, buyer, 10)).status).toBe(503);
    expect(await lease(h, n.token)).toBeNull();
  });

  it("a PC that costs more than the quote assumed doesn't get that job", async () => {
    const owner = await makeUser(h.db, "o5@example.in");
    const buyer = await makeUser(h.db, "b5@example.in");
    const cheap = await registerNode(h, owner, { name: "Cheap" });
    await beat(h, cheap.token);
    const job = await quoteAndConfirm(buyer, 10);
    const pricey = await registerNode(h, owner, { name: "Pricey", patch: { ownerRatePaisePerHr: 9000 } });
    await beat(h, pricey.token);
    expect(await lease(h, pricey.token)).toBeNull();
    expect((await lease(h, cheap.token))?.parsed.jobId).toBe(job.id);
  });

  it("limits open quotes per buyer", async () => {
    const owner = await makeUser(h.db, "o6@example.in");
    const buyer = await makeUser(h.db, "b6@example.in");
    await beat(h, (await registerNode(h, owner)).token);
    for (let i = 0; i < 5; i++) expect((await quoteTexts(h, buyer, 5)).status).toBe(201);
    const r = await quoteTexts(h, buyer, 5);
    expect(r.status).toBe(409);
    expect((await body(r)).error).toBe("too_many_quotes");
  });
});

describe("timeouts, retries and offline PCs", () => {
  it("re-assigns a piece whose lease ran out; the late result is refused", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner, { name: "A" });
    const b = await registerNode(h, owner, { name: "B" });
    await beat(h, a.token);
    await beat(h, b.token);
    await quoteAndConfirm(buyer, 10);

    const first = (await lease(h, a.token))!;
    expect(first.parsed.attempt).toBe(1);
    h.clock.set(new Date(new Date(first.leaseExpiresAt).getTime() + 1000));
    await beat(h, b.token);
    const report = await runTick(h.db, h.clock.now(), h.deps.ipSecret);
    expect(report.leasesExpired).toBe(1);

    const second = (await lease(h, b.token))!;
    expect(second.parsed.taskId).toBe(first.parsed.taskId);
    expect(second.parsed.attempt).toBe(2);

    const late = await complete(h, a.token, first);
    expect(late.status).toBe(409);
    expect((await body(late)).error).toBe("lease_lost");
    expect((await complete(h, b.token, second)).status).toBe(200);
  });

  it("an agent can hand a piece back, and a piece out of attempts fails the job with a full refund", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner);
    await beat(h, a.token);
    const job = await quoteAndConfirm(buyer, 10);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const l = (await lease(h, a.token))!;
      expect(l.parsed.attempt).toBe(attempt);
      const r = await H.failHandler(
        jsonReq("POST", `/api/agent/fragments/${l.parsed.taskId}/fail`, { attempt, reason: "crashed" }, { authorization: `Bearer ${a.token}` }),
        h.deps,
        l.parsed.taskId,
      );
      expect(r.status).toBe(200);
      expect((await body(r)).requeued).toBe(attempt < 3);
    }
    expect(await lease(h, a.token)).toBeNull();
    const after = (await body<{ job: JobJson }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${job.id}`), h.as(buyer), job.id))).job;
    expect(after.status).toBe("failed");
    expect(after.refunded).toBe(true);
    expect(after.netChargedPaise).toBe(0);
  });

  it("marks silent PCs offline and frees their work straight away", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner, { name: "A" });
    const b = await registerNode(h, owner, { name: "B" });
    await beat(h, a.token);
    await quoteAndConfirm(buyer, 10);
    const l = (await lease(h, a.token))!;

    h.clock.advance(120); // A goes quiet; lease (5+ min) hasn't run out yet
    await beat(h, b.token);
    const report = await runTick(h.db, h.clock.now(), h.deps.ipSecret);
    expect(report.nodesOffline).toBe(1);
    expect(report.leasesExpired).toBe(1);
    const [nodeA] = await h.db.select().from(nodes).where(eq(nodes.id, a.nodeId));
    expect(nodeA!.status).toBe("offline");
    expect((await lease(h, b.token))!.parsed.taskId).toBe(l.parsed.taskId);
  });

  it("revoking a token locks the agent out and frees its work", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner);
    await beat(h, a.token);
    await quoteAndConfirm(buyer, 10);
    const l = (await lease(h, a.token))!;

    const r = await H.revokeNodeHandler(jsonReq("DELETE", `/api/nodes/${a.nodeId}/token`), h.as(owner), a.nodeId);
    expect(r.status).toBe(200);
    expect((await beat(h, a.token)).status).toBe(401);
    expect((await complete(h, a.token, l)).status).toBe(401);
    const [f] = await h.db.select().from(fragments).where(eq(fragments.id, l.parsed.taskId));
    expect(f!.status).toBe("pending");

    // A new token brings it back.
    const rot = await H.rotateTokenHandler(jsonReq("POST", `/api/nodes/${a.nodeId}/token`), h.as(owner), a.nodeId);
    const { token } = await body<{ token: string }>(rot);
    expect((await beat(h, token)).status).toBe(200);
    expect((await lease(h, token))!.parsed.taskId).toBe(l.parsed.taskId);
  });
});

describe("backup copies near the deadline", () => {
  it("starts a backup of a slow piece on another PC; the first to finish wins; both owners are paid", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner, { name: "A" });
    const b = await registerNode(h, owner, { name: "B" });
    await beat(h, a.token);
    await beat(h, b.token);
    const job = await quoteAndConfirm(buyer, 10);
    const slow = (await lease(h, a.token))!;

    // Near the deadline, with the piece well past its expected time.
    const deadline = new Date(job.deadlineAt).getTime();
    h.clock.set(new Date(deadline - 5 * 60_000));
    await h.db.update(fragments).set({ leaseExpiresAt: new Date(deadline + 3600_000) }).where(eq(fragments.id, slow.parsed.taskId));
    await beat(h, a.token);
    await beat(h, b.token);
    const report = await runTick(h.db, h.clock.now(), h.deps.ipSecret);
    expect(report.backupsStarted).toBe(1);
    expect((await runTick(h.db, h.clock.now(), h.deps.ipSecret)).backupsStarted).toBe(0); // only one

    expect(await lease(h, a.token)).toBeNull(); // never a backup of your own piece
    const backup = (await lease(h, b.token))!;
    expect(backup.parsed.taskId).not.toBe(slow.parsed.taskId);
    expect(backup.input).toBe(slow.input);

    expect((await body(await complete(h, b.token, backup))).accepted).toBe(true);
    const j = (await body<{ job: JobJson }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${job.id}`), h.as(buyer), job.id))).job;
    expect(j.status).toBe("completed");

    // The slow copy still finishes inside its lease: not used, but paid.
    const late = await body<{ accepted: boolean; paidPaise: number }>(await complete(h, a.token, slow));
    expect(late.accepted).toBe(false);
    expect(late.paidPaise).toBeGreaterThan(0);
    expect((await ownerEarnings(h.db, owner.id, a.nodeId)).balancePaise).toBe(late.paidPaise);
    expect((await complete(h, a.token, slow)).status).toBe(409); // and only once
  });
});

describe("deadline guarantee", () => {
  it("a late job costs ₹0, refunded automatically, and owners keep what they earned", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner);
    await beat(h, a.token);
    const job = await quoteAndConfirm(buyer, 300); // 2 pieces
    const p1 = (await lease(h, a.token))!;
    expect((await complete(h, a.token, p1)).status).toBe(200);
    const p2 = (await lease(h, a.token))!;

    h.clock.set(new Date(new Date(job.deadlineAt).getTime() + 1000));
    await h.db.update(fragments).set({ leaseExpiresAt: new Date(h.clock.now().getTime() + 600_000) }).where(eq(fragments.id, p2.parsed.taskId));
    await beat(h, a.token); // still working, still sending heartbeats
    const report = await runTick(h.db, h.clock.now(), h.deps.ipSecret);
    expect(report.deadlinesMissed).toBe(1);
    expect(report.leasesExpired).toBe(0);

    let j = (await body<{ job: JobJson }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${job.id}`), h.as(buyer), job.id))).job;
    expect(j.status).toBe("deadline_missed");
    expect(j.refunded).toBe(true);
    expect(j.netChargedPaise).toBe(0);

    // The PC finishes anyway: the buyer still gets results, the owner is paid.
    await beat(h, a.token);
    expect((await complete(h, a.token, p2)).status).toBe(200);
    j = (await body<{ job: JobJson }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${job.id}`), h.as(buyer), job.id))).job;
    expect(j.status).toBe("deadline_missed");
    expect(j.resultsAvailable).toBe(true);
    expect(j.netChargedPaise).toBe(0);
    expect((await ownerEarnings(h.db, owner.id)).balancePaise).toBeGreaterThan(0);

    // Exactly one refund row, however many times the tick runs.
    await runTick(h.db, h.clock.now(), h.deps.ipSecret);
    const refunds = await h.db.select().from(buyerLedger).where(eq(buyerLedger.entryType, "refund"));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountPaise).toBe(-job.pricePaise);
  });

  it("a job that finishes after its deadline but before any tick is still refunded", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner);
    await beat(h, a.token);
    const job = await quoteAndConfirm(buyer, 10);
    const l = (await lease(h, a.token))!;
    h.clock.set(new Date(new Date(job.deadlineAt).getTime() + 1000));
    await h.db.update(fragments).set({ leaseExpiresAt: new Date(h.clock.now().getTime() + 600_000) }).where(eq(fragments.id, l.parsed.taskId));
    await beat(h, a.token);
    expect((await complete(h, a.token, l)).status).toBe(200);
    const j = (await body<{ job: JobJson }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${job.id}`), h.as(buyer), job.id))).job;
    expect(j).toMatchObject({ status: "deadline_missed", refunded: true, netChargedPaise: 0 });
  });
});

describe("data at rest and retention", () => {
  it("stores job data encrypted, with a different key per piece", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    await beat(h, (await registerNode(h, owner)).token);
    const job = await quoteAndConfirm(buyer, 300);
    const stored = await h.db.select().from(blobs).where(eq(blobs.jobId, job.id));
    expect(stored).toHaveLength(2);
    for (const s of stored) expect(s.data.includes(Buffer.from("sentence number"))).toBe(false);
    const frags = await h.db.select().from(fragments).where(eq(fragments.jobId, job.id));
    expect(new Set(frags.map((f) => f.wrappedKey)).size).toBe(2);
  });

  it("deletes an unconfirmed quote's data when the quote expires", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    await beat(h, (await registerNode(h, owner)).token);
    const q = (await body<{ job: JobJson }>(await quoteTexts(h, buyer, 10))).job;
    h.clock.set(new Date(new Date(q.quoteExpiresAt).getTime() + 1000));
    const late = await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.id}/confirm`), h.as(buyer), q.id);
    expect(late.status).toBe(409);
    expect((await body(late)).error).toBe("quote_expired");
    expect((await runTick(h.db, h.clock.now(), h.deps.ipSecret)).quotesExpired).toBe(1);
    expect(await h.db.select().from(blobs).where(eq(blobs.jobId, q.id))).toHaveLength(0);
  });

  it("cancelling a quote deletes its data now", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    await beat(h, (await registerNode(h, owner)).token);
    const q = (await body<{ job: JobJson }>(await quoteTexts(h, buyer, 10))).job;
    expect((await H.cancelJobHandler(jsonReq("POST", `/api/jobs/${q.id}/cancel`), h.as(buyer), q.id)).status).toBe(200);
    expect(await h.db.select().from(blobs).where(eq(blobs.jobId, q.id))).toHaveLength(0);
    expect((await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.id}/confirm`), h.as(buyer), q.id)).status).toBe(409);
  });

  it("deletes inputs and results 7 days after a job ends", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner);
    await beat(h, a.token);
    const job = await quoteAndConfirm(buyer, 10);
    await complete(h, a.token, (await lease(h, a.token))!);
    const [row] = await h.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.purgeAfter!.getTime() - row!.completedAt!.getTime()).toBe(7 * 24 * 3600 * 1000);

    h.clock.set(new Date(row!.completedAt!.getTime() + 7 * 24 * 3600 * 1000 - 1000));
    expect((await runTick(h.db, h.clock.now(), h.deps.ipSecret)).jobsPurged).toBe(0);
    h.clock.advance(2);
    expect((await runTick(h.db, h.clock.now(), h.deps.ipSecret)).jobsPurged).toBe(1);
    expect(await h.db.select().from(blobs).where(eq(blobs.jobId, job.id))).toHaveLength(0);
    const r = await H.resultsHandler(jsonReq("GET", `/api/jobs/${job.id}/results`), h.as(buyer), job.id);
    expect(r.status).toBe(410);
    // Money records outlive the data.
    expect((await h.db.select().from(ownerLedger)).length).toBe(2);
  });
});

describe("scheduler tick", () => {
  it("runs at most once per 15 seconds across callers, and the cron route needs the secret", async () => {
    const now = h.clock.now();
    expect((await maybeTick(h.db, now, "s")).ran).toBe(true);
    expect((await maybeTick(h.db, new Date(now.getTime() + 5000), "s")).ran).toBe(false);
    expect((await maybeTick(h.db, new Date(now.getTime() + 16_000), "s")).ran).toBe(true);

    expect((await H.cronTickHandler(new Request("https://x/api/cron/tick"), h.deps)).status).toBe(401);
    expect((await H.cronTickHandler(new Request("https://x/api/cron/tick", { headers: { authorization: "Bearer wrong" } }), h.deps)).status).toBe(401);
    const ok = await H.cronTickHandler(new Request("https://x/api/cron/tick", { headers: { authorization: `Bearer ${h.deps.cronSecret}` } }), h.deps);
    expect(ok.status).toBe(200);
    expect((await body<{ report: { ran: boolean } }>(ok)).report.ran).toBe(true);
  });

  it("is idempotent", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner);
    await beat(h, a.token);
    await quoteAndConfirm(buyer, 10);
    await lease(h, a.token);
    h.clock.advance(3600);
    const first = await runTick(h.db, h.clock.now(), "s");
    const second = await runTick(h.db, h.clock.now(), "s");
    expect(first.leasesExpired + first.nodesOffline).toBeGreaterThan(0);
    expect(second).toMatchObject({ leasesExpired: 0, nodesOffline: 0, backupsStarted: 0, deadlinesMissed: 0, quotesExpired: 0, jobsPurged: 0 });
  });
});

describe("agent telemetry (phase 4 contract)", () => {
  it("the heartbeat returns the node's own id, and CPU-mode watts are flagged as estimated", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const n = await registerNode(h, owner, { gpuClass: "cpu" });
    const hb = await body<{ nodeId: string }>(await beat(h, n.token, { watts: 65, wattsSource: "estimated" }));
    expect(hb.nodeId).toBe(n.nodeId);
    const [row] = await h.db.select().from(nodes).where(eq(nodes.id, n.nodeId));
    expect(row!.measuredWatts).toBe(65);
    expect(row!.wattsEstimated).toBe(true);
  });

  it("a power reading sent with a result updates the node's watts before the owner is paid", async () => {
    const owner = await makeUser(h.db, "o@example.in");
    const buyer = await makeUser(h.db, "b@example.in");
    const a = await registerNode(h, owner);
    await beat(h, a.token, { watts: 300, wattsSource: "nvidia-smi" });
    await quoteAndConfirm(buyer, 10);
    const l = (await lease(h, a.token))!;
    const out = embeddingsFor(l);
    const res = await H.completeHandler(
      new Request(`https://nightshift.test/api/agent/fragments/${l.parsed.taskId}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.token}`,
          "content-type": "application/json",
          "x-lease-attempt": String(l.parsed.attempt),
          "x-output-sha256": createHash("sha256").update(out).digest("hex"),
          "x-power-watts": "400",
          "x-power-source": "nvidia-smi",
        },
        body: new Uint8Array(out),
      }),
      h.deps,
      l.parsed.taskId,
    );
    expect(res.status).toBe(200);
    const [row] = await h.db.select().from(nodes).where(eq(nodes.id, a.nodeId));
    expect(row!.measuredWatts).toBe(320); // 300 × 0.8 + 400 × 0.2
    expect(row!.wattsEstimated).toBe(false);
  });
});

describe("load-path behaviour (Phase 8 load fixes)", () => {
  it("PCs asking for work at the same moment each get a different piece (SKIP LOCKED), with no errors", async () => {
    const owner = await makeUser(h.db, "owner@example.in");
    const buyer = await makeUser(h.db, "buyer@example.in");
    const pcs = [];
    for (let i = 0; i < 6; i++) pcs.push(await registerNode(h, owner, { name: `PC ${i}` }));
    for (const pc of pcs) expect((await beat(h, pc.token)).status).toBe(200);
    await quoteAndConfirm(buyer, 1500);
    const pieces = await h.db.select({ id: fragments.id, deadlineAt: fragments.deadlineAt }).from(fragments).where(eq(fragments.kind, "primary"));
    // Each piece carries its job's deadline, so the queue index can order it.
    const [job] = await h.db.select({ deadlineAt: jobs.deadlineAt }).from(jobs);
    for (const p of pieces) expect(p.deadlineAt?.getTime()).toBe(job!.deadlineAt.getTime());

    const leases = await Promise.all(pcs.map((pc) => lease(h, pc.token)));
    const got = leases.filter((l): l is NonNullable<typeof l> => l !== null).map((l) => l.parsed.taskId);
    expect(got).toHaveLength(Math.min(pcs.length, pieces.length));
    expect(new Set(got).size).toBe(got.length);
  });

  it("writes a token's 'last used' time at most every 5 minutes, not on every agent request", async () => {
    const { nodeTokens } = await import("@/lib/db/schema");
    const owner = await makeUser(h.db, "owner@example.in");
    const pc = await registerNode(h, owner);
    const lastUsed = async () => (await h.db.select({ t: nodeTokens.lastUsedAt }).from(nodeTokens).where(eq(nodeTokens.nodeId, pc.nodeId)))[0]!.t;
    await beat(h, pc.token);
    const first = await lastUsed();
    expect(first?.getTime()).toBe(h.clock.now().getTime());
    h.clock.advance(60);
    await beat(h, pc.token);
    expect((await lastUsed())?.getTime()).toBe(first!.getTime());
    h.clock.advance(5 * 60);
    await beat(h, pc.token);
    expect((await lastUsed())?.getTime()).toBe(h.clock.now().getTime());
  });
});
