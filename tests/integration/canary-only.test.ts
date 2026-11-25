import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as H from "@/lib/api/handlers";
import { CANARY_ONLY_RATE } from "@/lib/coordinator/canary-only";
import { runTick } from "@/lib/coordinator/tick";
import { heldEarnings } from "@/lib/coordinator/verification";
import { creditWallet } from "@/lib/credits";
import { auditLog, canaryCovers, fragments, jobs, nodes, ownerLedger } from "@/lib/db/schema";
import { ownerEarnings } from "@/lib/ledger";
import {
  beat,
  body,
  complete,
  harness,
  honestChallengeOutput,
  jsonReq,
  lease,
  makeUser,
  quoteTexts,
  registerNode,
  type Harness,
  type Leased,
} from "../helpers/coordinator";
import { freshDb } from "../helpers/db";

/**
 * E1: canary-only verification, for when no independent PC exists (a college
 * lab, or the three-laptop demo: one account, one Wi-Fi). Checks can't go to
 * another of the same person's PCs, so they never run. The pieces' pay is
 * held until a canary passes; 30% of the PC's leases are canaries meanwhile;
 * a pass releases the pay and gives no trust; a fail reverses it. No bypass.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

let h: Harness;
beforeEach(async () => {
  const { db, cleanup } = await freshDb();
  cleanups.push(cleanup);
  h = harness(db);
  h.deps.challenges = true;
});

const node = async (id: string) => (await h.db.select().from(nodes).where(eq(nodes.id, id)))[0]!;
const isChallenge = async (l: Leased) => Boolean((await h.db.select({ c: jobs.challenge }).from(jobs).where(eq(jobs.id, l.parsed.jobId)))[0]?.c);
const madeUp = (l: Leased, salt = 1) => {
  const texts = (JSON.parse(Buffer.from(l.input, "base64").toString()) as { texts: string[] }).texts;
  return Buffer.from(JSON.stringify({ items: texts.map((_, i) => Array.from({ length: 384 }, (_, j) => Math.sin((i + 1) * (j + 1) * 7.7 * salt))) }));
};

/** Three laptops, one account, one network (the brief's demo). Each has passed its first-lease speed check. */
async function demoLaptops() {
  const me = await makeUser(h.db, "student@example.in");
  const laptops = [];
  for (const name of ["Laptop 1", "Laptop 2", "Laptop 3"]) {
    const r = await registerNode(h, me, { name });
    await beat(h, r.token, { deviceId: name.endsWith("1") ? "a".repeat(64) : name.endsWith("2") ? "b".repeat(64) : "c".repeat(64) });
    // Measured already, and its last canary was just now: no background canaries in the way.
    await h.db.update(nodes).set({ benchmarkScore: 1000, lastCanaryAt: h.clock.now() }).where(eq(nodes.id, r.nodeId));
    laptops.push(r);
  }
  return { me, laptops };
}

/** A buyer's job, run by the first laptop that takes it. */
async function runJob(laptop: { token: string }) {
  const buyer = await makeUser(h.db, `buyer${Math.random().toString(36).slice(2, 8)}@example.in`);
  const { job } = await body<{ job: { id: string } }>(await quoteTexts(h, buyer, 20));
  await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${job.id}/confirm`), h.as(buyer), job.id);
  h.deps.checkRand = () => 0.99; // the real piece, not a canary
  const l = (await lease(h, laptop.token))!;
  expect(await isChallenge(l)).toBe(false);
  await complete(h, laptop.token, l);
  return { buyer, jobId: job.id, fragmentId: l.parsed.taskId };
}

describe("canary-only verification (no independent PC exists)", () => {
  it("three laptops on one account: the check never runs on a sibling; the piece is covered and its pay held", async () => {
    const { me, laptops } = await demoLaptops();
    const [l1, l2, l3] = laptops;
    const { buyer, jobId, fragmentId } = await runJob(l1!);
    // Laptops 2 and 3 never get the check of laptop 1's piece.
    expect(await lease(h, l2!.token)).toBeNull();
    expect(await lease(h, l3!.token)).toBeNull();
    // The tick switches it to canary-only.
    h.clock.advance(20);
    expect((await runTick(h.db, h.clock.now(), "s")).canaryOnly).toBe(1);
    const covers = await h.db.select().from(canaryCovers);
    expect(covers.map((c) => [c.fragmentId, c.nodeId, c.status])).toEqual([[fragmentId, l1!.nodeId, "waiting"]]);
    const check = await h.db.select().from(fragments).where(and(eq(fragments.jobId, jobId), eq(fragments.kind, "verification")));
    expect(check.map((f) => f.status)).toEqual(["cancelled"]);
    // The pay for it is held.
    const earned = (await ownerEarnings(h.db, me.id)).balancePaise;
    expect(earned).toBeGreaterThan(0);
    expect(await heldEarnings(h.db, me.id)).toBe(earned);
    // The buyer's job page says how it's being verified.
    const j = (await body<{ job: { canaryOnly: { waiting: number } } }>(await H.getJobHandler(jsonReq("GET", `/api/jobs/${jobId}`), h.as(buyer), jobId))).job;
    expect(j.canaryOnly).toEqual({ waiting: 1, passed: 0, failed: 0 });
  });

  it(`${CANARY_ONLY_RATE * 100}% of leases are canaries while pay is waiting (and one anyway when there's no other work)`, async () => {
    const { laptops } = await demoLaptops();
    const [l1] = laptops;
    await runJob(l1!);
    await runTick(h.db, h.clock.now(), "s");
    // Real work is waiting: below 0.3 → canary, at or above → the real piece.
    const buyer = await makeUser(h.db, "b2@example.in");
    const { job } = await body<{ job: { id: string } }>(await quoteTexts(h, buyer, 20));
    await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${job.id}/confirm`), h.as(buyer), job.id);
    h.deps.checkRand = () => 0.3;
    const real = (await lease(h, l1!.token))!;
    expect(await isChallenge(real)).toBe(false);
    await complete(h, l1!.token, real);
    // That piece is the job's only one, picked for a check, and covered too.
    await runTick(h.db, h.clock.now(), "s");
    expect(await h.db.select().from(canaryCovers)).toHaveLength(2);
    // No other work now: a canary anyway.
    h.deps.checkRand = () => 0.99;
    const idle = (await lease(h, l1!.token))!;
    expect(await isChallenge(idle)).toBe(true);
    await h.db.update(fragments).set({ status: "cancelled" }).where(eq(fragments.id, idle.parsed.taskId));
    // With work waiting and a draw under 0.3: a canary.
    const { job: j3 } = await body<{ job: { id: string } }>(await quoteTexts(h, buyer, 20));
    await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${j3.id}/confirm`), h.as(buyer), j3.id);
    h.deps.checkRand = () => 0.29;
    expect(await isChallenge((await lease(h, l1!.token))!)).toBe(true);
  });

  it("a canary that passes releases the held pay and the Time-Bank credits, and gives NO trust", async () => {
    const { me, laptops } = await demoLaptops();
    const [l1] = laptops;
    await H.updateNodeHandler(jsonReq("PATCH", `/api/nodes/${l1!.nodeId}`, { earnsCredits: true }), h.as(me), l1!.nodeId);
    await runJob(l1!);
    await runTick(h.db, h.clock.now(), "s");
    const before = await node(l1!.nodeId);
    expect((await creditWallet(h.db, me.id, h.clock.now())).pendingSec).toBeGreaterThan(0);
    expect(await heldEarnings(h.db, me.id)).toBeGreaterThan(0);

    h.deps.checkRand = () => 0.99;
    const canary = (await lease(h, l1!.token))!;
    expect(await isChallenge(canary)).toBe(true);
    h.clock.advance(10);
    await complete(h, l1!.token, canary, honestChallengeOutput(canary));

    expect((await h.db.select().from(canaryCovers))[0]!.status).toBe("passed");
    expect(await heldEarnings(h.db, me.id)).toBe(0);
    const wallet = await creditWallet(h.db, me.id, h.clock.now());
    expect(wallet.pendingSec).toBe(0);
    expect(wallet.availableSec).toBeGreaterThan(0);
    const after = await node(l1!.nodeId);
    expect(after.trustScore).toBe(before.trustScore);
    expect(after.checksPassed).toBe(before.checksPassed);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "canary.cover_passed"))).map((a) => a.targetId)).toEqual([l1!.nodeId]);
  });

  it("a canary that fails reverses the pay of every covered piece (or claws back its credits); trust −250", async () => {
    const { me, laptops } = await demoLaptops();
    const [l1, l2] = laptops;
    // Laptop 1 is paid in rupees, laptop 2 earns Time-Bank credits.
    await H.updateNodeHandler(jsonReq("PATCH", `/api/nodes/${l2!.nodeId}`, { earnsCredits: true }), h.as(me), l2!.nodeId);
    const { fragmentId } = await runJob(l1!);
    await runJob(l2!);
    await runTick(h.db, h.clock.now(), "s");
    expect(await h.db.select().from(canaryCovers)).toHaveLength(2);
    const paidBefore = (await ownerEarnings(h.db, me.id)).balancePaise;

    h.deps.checkRand = () => 0.99;
    for (const [i, l] of [l1!, l2!].entries()) {
      const canary = (await lease(h, l.token))!;
      expect(await isChallenge(canary)).toBe(true);
      h.clock.advance(10);
      expect((await complete(h, l.token, canary, madeUp(canary, i + 1))).status).toBe(200);
      expect((await node(l.nodeId)).trustScore).toBe(250);
    }

    expect((await h.db.select().from(canaryCovers)).map((c) => c.status)).toEqual(["failed", "failed"]);
    const reversal = await h.db.select().from(ownerLedger).where(and(eq(ownerLedger.fragmentId, fragmentId), eq(ownerLedger.entryType, "reversal")));
    expect(reversal).toHaveLength(1);
    expect((await ownerEarnings(h.db, me.id)).balancePaise).toBeLessThan(paidBefore);
    expect(await heldEarnings(h.db, me.id)).toBe(0);
    const wallet = await creditWallet(h.db, me.id, h.clock.now());
    expect(wallet.clawedBackSec).toBeGreaterThan(0);
    expect(wallet.availableSec + wallet.pendingSec).toBe(0);
  });

  it("handing in another piece's output (a replay) is caught cheating: the PC's covered pieces fail too", async () => {
    const { laptops } = await demoLaptops();
    const [l1, l2] = laptops;
    await runJob(l1!);
    await runJob(l2!);
    await runTick(h.db, h.clock.now(), "s");
    h.deps.checkRand = () => 0.99;
    const c1 = (await lease(h, l1!.token))!;
    await complete(h, l1!.token, c1, madeUp(c1));
    // Laptop 2 hands in laptop 1's exact output for a different piece.
    const c2 = (await lease(h, l2!.token))!;
    const res = await complete(h, l2!.token, c2, madeUp(c1));
    expect((await res.json()).error).toBe("replayed_output");
    expect((await h.db.select().from(canaryCovers)).map((c) => c.status)).toEqual(["failed", "failed"]);
  });

  it("only a canary issued after the cover counts", async () => {
    const { laptops } = await demoLaptops();
    const [l1] = laptops;
    h.deps.checkRand = () => 0.99;
    // A canary handed out before the piece was even done...
    await h.db.update(nodes).set({ lastCanaryAt: null, benchmarkScore: null }).where(eq(nodes.id, l1!.nodeId));
    const early = (await lease(h, l1!.token))!;
    expect(await isChallenge(early)).toBe(true);
    await h.db.update(nodes).set({ benchmarkScore: 1000, lastCanaryAt: h.clock.now() }).where(eq(nodes.id, l1!.nodeId));
    h.clock.advance(5);
    await h.db.update(fragments).set({ status: "cancelled" }).where(eq(fragments.id, early.parsed.taskId));
    await runJob(l1!);
    h.clock.advance(5);
    await runTick(h.db, h.clock.now(), "s");
    // ...settles nothing: the cover is still waiting.
    expect((await h.db.select().from(canaryCovers))[0]!.status).toBe("waiting");
  });

  it("no demo bypass: with previews' relaxed network rule, three laptops on ONE account are still canary-only", async () => {
    h.deps.sybil = "report";
    const { me, laptops } = await demoLaptops();
    await runJob(laptops[0]!);
    expect(await lease(h, laptops[1]!.token)).toBeNull();
    await runTick(h.db, h.clock.now(), "s", { sybil: "report" });
    expect((await h.db.select().from(canaryCovers))).toHaveLength(1);
    expect(await heldEarnings(h.db, me.id)).toBeGreaterThan(0);
  });

  it("an independent PC seen in the last day is waited for instead", async () => {
    const { laptops } = await demoLaptops();
    const other = await makeUser(h.db, "friend@example.in");
    const friend = await registerNode(h, other, { name: "Friend's PC" });
    await beat(h, friend.token);
    await h.db.update(nodes).set({ status: "offline" }).where(eq(nodes.id, friend.nodeId));
    await runJob(laptops[0]!);
    await runTick(h.db, h.clock.now(), "s");
    expect(await h.db.select().from(canaryCovers)).toEqual([]);
    h.clock.advance(25 * 3600);
    await runTick(h.db, h.clock.now(), "s");
    expect(await h.db.select().from(canaryCovers)).toHaveLength(1);
  });
});

describe("E3: a buyer can opt out of canary reuse", () => {
  it("a job quoted with canaryReuse: false never has its pieces re-run as known-answer canaries", async () => {
    const [ra, rb, rc] = await Promise.all(["ran", "checked", "tested"].map((n) => makeUser(h.db, `${n}@example.in`)));
    const A = await registerNode(h, ra!, { name: "A" });
    const B = await registerNode(h, rb!, { name: "B" });
    const C = await registerNode(h, rc!, { name: "C" });
    for (const n of [A, B, C]) {
      await beat(h, n.token);
      await h.db.update(nodes).set({ benchmarkScore: 1000, lastCanaryAt: h.clock.now() }).where(eq(nodes.id, n.nodeId));
    }
    const buyer = await makeUser(h.db, "private@example.in");
    const q = await body<{ job: { id: string; canaryReuse: boolean } }>(
      await H.quoteHandler(jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass: "rtx4070", params: {}, texts: ["private 1", "private 2"], canaryReuse: false }), h.as(buyer)),
    );
    expect(q.job.canaryReuse).toBe(false);
    await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.job.id}/confirm`), h.as(buyer), q.job.id);
    h.deps.checkRand = () => 0.99;
    const la = (await lease(h, A.token))!;
    await complete(h, A.token, la);
    const lb = (await lease(h, B.token))!;
    await complete(h, B.token, lb);
    expect((await h.db.select().from(fragments).where(and(eq(fragments.jobId, q.job.id), eq(fragments.kind, "verification"))))[0]!.verdict).toBe("match");
    // C's next canary can't be a copy of it: the made-up challenge instead.
    await h.db.update(nodes).set({ lastCanaryAt: null, benchmarkScore: null }).where(eq(nodes.id, C.nodeId));
    const l = (await lease(h, C.token))!;
    expect(l.parsed.jobId).not.toBe(q.job.id);
    expect(await isChallenge(l)).toBe(true);
  });
});
