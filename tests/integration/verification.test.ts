import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as H from "@/lib/api/handlers";
import { runTick } from "@/lib/coordinator/tick";
import { TRUST_AFTER_RELEASE } from "@/lib/coordinator/verify";
import { auditLog, fragments, nodes, ownerLedger, users } from "@/lib/db/schema";
import { ownerEarnings } from "@/lib/ledger";
import { freshDb } from "../helpers/db";
import { beat, body, complete, embeddingsFor, harness, jsonReq, lease, makeUser, quoteTexts, registerNode, type Harness, type Leased } from "../helpers/coordinator";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

let h: Harness;
beforeEach(async () => {
  const { db, cleanup } = await freshDb();
  cleanups.push(cleanup);
  h = harness(db);
});

type User = Awaited<ReturnType<typeof makeUser>>;
type Job = { id: string; status: string; checks: { planned: number; matched: number; corrected: number; inconclusive: number; waiting: number } };

/** A different, made-up answer for the same piece (wrong direction, same shape). */
function wrongFor(l: Leased, salt = 1): Buffer {
  const input = JSON.parse(Buffer.from(l.input, "base64").toString()) as { texts: string[] };
  return Buffer.from(JSON.stringify({ items: input.texts.map((_, i) => Array.from({ length: 384 }, (_, j) => Math.sin((i + 1) * (j + 1) * salt * 7.7))) }));
}

async function confirmed(buyer: User, n = 20): Promise<Job> {
  const { job } = await body<{ job: Job }>(await quoteTexts(h, buyer, n));
  const c = await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${job.id}/confirm`), h.as(buyer), job.id);
  expect(c.status).toBe(200);
  return (await body<{ job: Job }>(c)).job;
}

const getJob = async (buyer: User, id: string) => (await body<{ job: Job }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${id}`), h.as(buyer), id))).job;
const node = async (id: string) => (await h.db.select().from(nodes).where(eq(nodes.id, id)))[0]!;

/** Owners and PCs: one owner per PC, so pay and trust are easy to follow. */
async function pcs(count: number) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const owner = await makeUser(h.db, `owner${i}@example.in`);
    const pc = await registerNode(h, owner, { name: `PC ${i}` });
    await beat(h, pc.token);
    out.push({ owner, ...pc });
  }
  return out;
}

describe("picking pieces to check", () => {
  it("flags about 1 in 10 pieces (at least one) when the buyer confirms, not before", async () => {
    await pcs(1);
    const buyer = await makeUser(h.db, "buyer@example.in");
    const { job: quoted } = await body<{ job: Job }>(await quoteTexts(h, buyer, 600));
    const flagged = async (id: string) => (await h.db.select().from(fragments).where(and(eq(fragments.jobId, id), eq(fragments.verify, true)))).length;
    expect(await flagged(quoted.id)).toBe(0);
    await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${quoted.id}/confirm`), h.as(buyer), quoted.id);
    expect(await flagged(quoted.id)).toBe(1);
    expect((await getJob(buyer, quoted.id)).checks).toEqual({ planned: 1, matched: 0, corrected: 0, inconclusive: 0, waiting: 1 });
  });
});

describe("a check that matches", () => {
  it("runs on a different PC after the job finishes, pays the checker, and raises both PCs' trust", async () => {
    const [a, b] = await pcs(2);
    const buyer = await makeUser(h.db, "buyer@example.in");
    const job = await confirmed(buyer);

    const first = (await lease(h, a!.token))!;
    expect((await complete(h, a!.token, first)).status).toBe(200);
    // The job is finished for the buyer straight away; the check doesn't hold it up.
    expect((await getJob(buyer, job.id)).status).toBe("completed");

    // The PC that did the piece never gets its check.
    expect(await lease(h, a!.token)).toBeNull();
    const check = (await lease(h, b!.token))!;
    expect(check.parsed.jobId).toBe(job.id);
    expect(check.parsed.inputSha256).toBe(first.parsed.inputSha256);
    expect(check.parsed.taskId).not.toBe(first.parsed.taskId);
    const res = await complete(h, b!.token, check, embeddingsFor(check));
    expect(res.status).toBe(200);
    expect((await body<{ accepted: boolean; paidPaise: number }>(res)).paidPaise).toBeGreaterThan(0);

    expect(await node(a!.nodeId)).toMatchObject({ trustScore: 520, checksPassed: 1, checksFailed: 0 });
    expect(await node(b!.nodeId)).toMatchObject({ trustScore: 520, checksPassed: 1, checksFailed: 0 });
    expect((await getJob(buyer, job.id)).checks).toMatchObject({ planned: 1, matched: 1, waiting: 0 });
    const memo = (await h.db.select().from(ownerLedger).where(eq(ownerLedger.ownerId, b!.owner.id))).map((r) => r.memo);
    expect(memo.some((m) => m?.startsWith("Compute for check of text_embeddings piece 1/1"))).toBe(true);
    // Nothing left to run.
    expect(await lease(h, b!.token)).toBeNull();
  });

  it("waits (without failing anything) when there's no second PC, until the data is purged", async () => {
    const [a] = await pcs(1);
    const buyer = await makeUser(h.db, "buyer@example.in");
    const job = await confirmed(buyer);
    await complete(h, a!.token, (await lease(h, a!.token))!);
    expect(await lease(h, a!.token)).toBeNull();
    expect((await getJob(buyer, job.id)).checks.waiting).toBe(1);

    h.clock.advance(8 * 24 * 3600);
    await runTick(h.db, h.clock.now(), "test-ip-secret");
    const checks = await h.db.select().from(fragments).where(and(eq(fragments.jobId, job.id), eq(fragments.kind, "verification")));
    expect(checks.map((c) => c.status)).toEqual(["cancelled"]);
    expect(await node(a!.nodeId)).toMatchObject({ trustScore: 500, checksPassed: 0, checksFailed: 0 });
  });
});

describe("a check that doesn't match", () => {
  it("brings in a third PC; when it sides with the checker, the first PC is blamed, unpaid, and the buyer's piece is corrected", async () => {
    const [a, b, c] = await pcs(3);
    const buyer = await makeUser(h.db, "buyer@example.in");
    const job = await confirmed(buyer);

    const first = (await lease(h, a!.token))!;
    await complete(h, a!.token, first, wrongFor(first));
    const paidBefore = await ownerEarnings(h.db, a!.owner.id);
    expect(paidBefore.computePayPaise).toBeGreaterThan(0);

    const check = (await lease(h, b!.token))!;
    await complete(h, b!.token, check, embeddingsFor(check));
    // A disagreement alone blames nobody: either PC could be the wrong one.
    expect((await node(a!.nodeId)).trustScore).toBe(500);
    expect((await node(b!.nodeId)).trustScore).toBe(500);
    expect((await getJob(buyer, job.id)).checks.waiting).toBe(1);

    // Neither PC that already ran the piece may settle it.
    expect(await lease(h, a!.token)).toBeNull();
    expect(await lease(h, b!.token)).toBeNull();
    const tiebreak = (await lease(h, c!.token))!;
    await complete(h, c!.token, tiebreak, embeddingsFor(tiebreak));

    expect(await node(a!.nodeId)).toMatchObject({ trustScore: 250, checksFailed: 1, status: "online" });
    expect(await node(b!.nodeId)).toMatchObject({ trustScore: 520, checksPassed: 1 });
    expect(await node(c!.nodeId)).toMatchObject({ trustScore: 520, checksPassed: 1 });
    expect((await getJob(buyer, job.id)).checks).toMatchObject({ corrected: 1, waiting: 0 });

    // The wrong PC's compute pay is reversed; its electricity line stays.
    const after = await ownerEarnings(h.db, a!.owner.id);
    expect(after.computePayPaise).toBe(0);
    expect(after.powerReimbursementPaise).toBe(paidBefore.powerReimbursementPaise);

    // The buyer now downloads the agreed (correct) answer for the piece.
    const res = await H.resultsHandler(jsonReq("GET", `/api/jobs/${job.id}/results`), h.as(buyer), job.id);
    const { items } = JSON.parse(await new Response(res.body).text()) as { items: number[][] };
    expect(items).toEqual((JSON.parse(embeddingsFor(tiebreak).toString()) as { items: number[][] }).items);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "job.piece_corrected"))).length).toBe(1);
  });

  it("blames the checker when the third PC sides with the first", async () => {
    const [a, b, c] = await pcs(3);
    const buyer = await makeUser(h.db, "buyer@example.in");
    await confirmed(buyer);
    const first = (await lease(h, a!.token))!;
    await complete(h, a!.token, first);
    const check = (await lease(h, b!.token))!;
    await complete(h, b!.token, check, wrongFor(check));
    const tiebreak = (await lease(h, c!.token))!;
    await complete(h, c!.token, tiebreak);
    expect(await node(a!.nodeId)).toMatchObject({ trustScore: 520, checksPassed: 1 });
    expect(await node(b!.nodeId)).toMatchObject({ trustScore: 250, checksFailed: 1 });
    expect(await node(c!.nodeId)).toMatchObject({ trustScore: 520, checksPassed: 1 });
  });

  it("costs everyone a little when all three disagree", async () => {
    const [a, b, c] = await pcs(3);
    const buyer = await makeUser(h.db, "buyer@example.in");
    const job = await confirmed(buyer);
    const first = (await lease(h, a!.token))!;
    await complete(h, a!.token, first);
    const check = (await lease(h, b!.token))!;
    await complete(h, b!.token, check, wrongFor(check, 1));
    const tiebreak = (await lease(h, c!.token))!;
    await complete(h, c!.token, tiebreak, wrongFor(tiebreak, 2));
    for (const pc of [a, b, c]) expect(await node(pc!.nodeId)).toMatchObject({ trustScore: 450, checksPassed: 0, checksFailed: 0 });
    expect((await getJob(buyer, job.id)).checks.inconclusive).toBe(1);
  });
});

describe("quarantine", () => {
  it("pauses a PC whose trust falls below 200, locks its agent out and frees its work; only an admin can release it", async () => {
    const [a, b, c] = await pcs(3);
    await h.db.update(nodes).set({ trustScore: 300 }).where(eq(nodes.id, a!.nodeId));
    const buyer = await makeUser(h.db, "buyer@example.in");
    const job1 = await confirmed(buyer);
    const first = (await lease(h, a!.token))!;
    await complete(h, a!.token, first, wrongFor(first));
    const check = (await lease(h, b!.token))!;
    expect(check.parsed.jobId).toBe(job1.id);
    await complete(h, b!.token, check);
    // A second job: PC A is holding its piece when it gets caught out.
    const job2 = await confirmed(buyer);
    const held = (await lease(h, a!.token))!;
    expect(held.parsed.jobId).toBe(job2.id);
    // C settles job 1's disagreement against A.
    const tiebreak = (await lease(h, c!.token))!;
    expect(tiebreak.parsed.jobId).toBe(job1.id);
    await complete(h, c!.token, tiebreak);

    expect(await node(a!.nodeId)).toMatchObject({ status: "quarantined", trustScore: 50, checksFailed: 1 });
    expect((await node(a!.nodeId)).quarantinedAt).not.toBeNull();
    // Its agent is turned away, and the piece it held went back in the queue.
    expect((await beat(h, a!.token)).status).toBe(403);
    const heldNow = (await h.db.select().from(fragments).where(eq(fragments.id, held.parsed.taskId)))[0]!;
    expect(heldNow.status).toBe("pending");
    // ...and another PC can take it.
    expect((await lease(h, c!.token))!.parsed.taskId).toBe(held.parsed.taskId);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "node.quarantined"))).map((r) => r.targetId)).toEqual([a!.nodeId]);

    // Release: owners can't, a non-admin gets a 404, an admin can (once).
    const release = (u: User) => H.releaseNodeHandler(jsonReq("POST", `/api/admin/nodes/${a!.nodeId}/release`), h.as(u), a!.nodeId);
    expect((await release(a!.owner)).status).toBe(404);
    const admin = await makeUser(h.db, "admin@example.in");
    expect((await release(admin)).status).toBe(404);
    await h.db.update(users).set({ role: "admin" }).where(eq(users.id, admin.id));
    expect((await release(admin)).status).toBe(200);
    expect(await node(a!.nodeId)).toMatchObject({ status: "offline", trustScore: TRUST_AFTER_RELEASE, quarantinedAt: null });
    expect((await release(admin)).status).toBe(409);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "node.released")))[0]).toMatchObject({ actorId: admin.id, actorType: "admin" });
    // Back to work after its next heartbeat.
    expect((await beat(h, a!.token)).status).toBe(200);
    // A bad id and a cross-site request are refused too.
    expect((await H.releaseNodeHandler(jsonReq("POST", "/api/admin/nodes/x/release"), h.as(admin), "x")).status).toBe(404);
    expect((await H.releaseNodeHandler(jsonReq("POST", `/api/admin/nodes/${a!.nodeId}/release`, undefined, { origin: "https://evil.example" }), h.as(admin), a!.nodeId)).status).toBe(403);
  });
});
