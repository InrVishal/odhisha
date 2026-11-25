import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as H from "@/lib/api/handlers";
import { runTick } from "@/lib/coordinator/tick";
import { creditWallet, grants, SETTLE_AFTER_SEC } from "@/lib/credits";
import { creditLedger, fragments, jobs, nodes, ownerLedger, users } from "@/lib/db/schema";
import { ownerEarnings } from "@/lib/ledger";
import { freshDb } from "../helpers/db";
import { beat, body, complete, harness, jsonReq, lease, makeUser, registerNode, type Harness, type Leased } from "../helpers/coordinator";

/**
 * Time-Bank on the append-only credit ledger: earning (pending until
 * verified), clawbacks, spending on a job, refunds, expiry, and that credits
 * never become money.
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
});

type User = Awaited<ReturnType<typeof makeUser>>;
let seq = 0;
async function pc(name: string, opts: { credits?: boolean; owner?: User } = {}) {
  const o = opts.owner ?? (await makeUser(h.db, `${name.replace(/\W/g, "").toLowerCase()}${seq++}@example.in`));
  const r = await registerNode(h, o, { name, patch: opts.credits ? { earnsCredits: true } : undefined });
  await beat(h, r.token);
  return { owner: o, ...r };
}

/** A one-piece job (always picked for a check) with its own texts. */
async function job(buyer?: User, n = 20, payWith?: "credits") {
  const b = buyer ?? (await makeUser(h.db, `buyer${seq++}@example.in`));
  const texts = Array.from({ length: n }, (_, i) => `job ${seq} line ${i}`);
  seq++;
  const q = await body<{ job: { id: string; creditCost: number } }>(
    await H.quoteHandler(jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass: "rtx4070", params: {}, texts }), h.as(b)),
  );
  const res = await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.job.id}/confirm`, payWith ? { payWith } : undefined), h.as(b), q.job.id);
  return { buyer: b, id: q.job.id, creditCost: q.job.creditCost, res };
}

const wallet = (u: User) => creditWallet(h.db, u.id, h.clock.now());
const piece = async (jobId: string) => (await h.db.select().from(fragments).where(and(eq(fragments.jobId, jobId), eq(fragments.kind, "primary"))))[0]!;

const textsOf = (l: Leased) => (JSON.parse(Buffer.from(l.input, "base64").toString()) as { texts: string[] }).texts;
/** What an honest PC returns: a vector that depends on the text (so two jobs never share an output). */
function vec(text: string, salt = 0): number[] {
  const d = createHash("sha256").update(`${salt}:${text}`).digest();
  return Array.from({ length: 384 }, (_, j) => d[j % 32]! / 255 - 0.5 + j / 10_000);
}
const honest = (l: Leased) => Buffer.from(JSON.stringify({ items: textsOf(l).map((t) => vec(t)) }));
const wrong = (l: Leased, salt: number) => Buffer.from(JSON.stringify({ items: textsOf(l).map((t) => vec(t, salt)) }));
const run = async (token: string) => {
  const l = (await lease(h, token))!;
  return complete(h, token, l, honest(l));
};

describe("earning credits", () => {
  it("a Time-Bank PC earns credits instead of compute pay; electricity is still paid in rupees", async () => {
    const student = await pc("Hostel PC", { credits: true });
    const checker = await pc("Checker");
    const j = await job();
    const r = await body<{ paidPaise: number; creditSeconds: number }>(await run(student.token));
    const f = await piece(j.id);
    expect(r.creditSeconds).toBe(f.estGpuSeconds);
    const money = await ownerEarnings(h.db, student.owner.id);
    expect(money.computePayPaise).toBe(0);
    expect(money.powerReimbursementPaise).toBeGreaterThan(0);
    expect(r.paidPaise).toBe(money.powerReimbursementPaise);
    // Pending until verified.
    expect(await wallet(student.owner)).toMatchObject({ availableSec: 0, pendingSec: f.estGpuSeconds });
    // Its check matches → available.
    await run(checker.token);
    expect(await wallet(student.owner)).toMatchObject({ availableSec: f.estGpuSeconds, pendingSec: 0, earnedSec: f.estGpuSeconds });
    // Expires 6 months after it was earned (2026-11-22 → 2027-05-22).
    const [g] = await grants(h.db, student.owner.id, h.clock.now());
    expect(g!.expiresAt.toISOString().slice(0, 10)).toBe("2027-05-22");
  });

  it("a piece not picked for a check becomes spendable a day later, if the PC is in good standing", async () => {
    const student = await pc("Hostel PC", { credits: true });
    const j = await job();
    // Not picked: unflag it before the PC hands it in (as if it were one of the ~90%).
    await h.db.update(fragments).set({ verify: false }).where(eq(fragments.jobId, j.id));
    h.deps.checkRand = () => 0.99;
    await run(student.token);
    expect((await wallet(student.owner)).pendingSec).toBeGreaterThan(0);
    h.clock.advance(SETTLE_AFTER_SEC - 60);
    expect((await wallet(student.owner)).availableSec).toBe(0);
    h.clock.advance(120);
    expect((await wallet(student.owner)).availableSec).toBe((await piece(j.id)).estGpuSeconds);
  });

  it("weighting is 1.0×: a fast PC and a slow one earn the same for the same GPU-seconds", async () => {
    const fast = await pc("Fast", { credits: true });
    const slow = await pc("Slow", { credits: true });
    await h.db.update(nodes).set({ benchmarkScore: 4000 }).where(eq(nodes.id, fast.nodeId));
    await h.db.update(nodes).set({ benchmarkScore: 250 }).where(eq(nodes.id, slow.nodeId));
    const a = await job();
    const r1 = await body<{ creditSeconds: number }>(await run(fast.token));
    await job();
    const r2 = await body<{ creditSeconds: number }>(await run(slow.token));
    expect(r1.creditSeconds).toBe((await piece(a.id)).estGpuSeconds);
    expect(r1.creditSeconds).toBe(r2.creditSeconds);
  });
});

describe("clawbacks", () => {
  it("wrong work: corrected by two other PCs → the credits are clawed back in full", async () => {
    const cheat = await pc("Cheat", { credits: true });
    const h1 = await pc("Honest 1");
    const h2 = await pc("Honest 2");
    await job();
    const l = (await lease(h, cheat.token))!;
    await complete(h, cheat.token, l, wrong(l, 1));
    expect((await wallet(cheat.owner)).pendingSec).toBeGreaterThan(0);
    await run(h1.token);
    await run(h2.token);
    const w = await wallet(cheat.owner);
    expect(w).toMatchObject({ availableSec: 0, pendingSec: 0 });
    expect(w.clawedBackSec).toBe(w.earnedSec);
    expect(w.balanceSec).toBe(0);
  });

  it("an inconclusive check (three different answers) → clawed back", async () => {
    const a = await pc("A", { credits: true });
    const b = await pc("B");
    const c = await pc("C");
    await job();
    const la = (await lease(h, a.token))!;
    await complete(h, a.token, la, wrong(la, 1));
    const lb = (await lease(h, b.token))!;
    await complete(h, b.token, lb, wrong(lb, 2));
    const lc = (await lease(h, c.token))!;
    await complete(h, c.token, lc, wrong(lc, 3));
    const w = await wallet(a.owner);
    expect(w.clawedBackSec).toBe(w.earnedSec);
    expect(w.availableSec + w.pendingSec).toBe(0);
  });

  it("quarantine: credits not yet verified are clawed back; verified ones stay", async () => {
    const p = await pc("PC", { credits: true });
    const checker = await pc("Checker");
    await job();
    await run(p.token);
    await run(checker.token);
    const verified = (await wallet(p.owner)).availableSec;
    expect(verified).toBeGreaterThan(0);
    await job();
    await run(p.token);
    expect((await wallet(p.owner)).pendingSec).toBeGreaterThan(0);
    // Two failed checks elsewhere drop it below the line.
    await h.db.update(nodes).set({ trustScore: 210 }).where(eq(nodes.id, p.nodeId));
    const { applyCheck } = await import("@/lib/coordinator/verification");
    await applyCheck(h.db, p.nodeId, "fail", h.clock.now(), "test-ip-secret");
    expect((await h.db.select().from(nodes).where(eq(nodes.id, p.nodeId)))[0]!.status).toBe("quarantined");
    expect(await wallet(p.owner)).toMatchObject({ availableSec: verified, pendingSec: 0 });
  });

  it("a check that never ran before the job's data was deleted → clawed back at the purge", async () => {
    const p = await pc("PC", { credits: true });
    await job();
    await run(p.token);
    expect((await wallet(p.owner)).pendingSec).toBeGreaterThan(0);
    h.clock.advance(9 * 24 * 3600);
    const report = await runTick(h.db, h.clock.now(), "test-ip-secret");
    expect(report.jobsPurged).toBeGreaterThan(0);
    const w = await wallet(p.owner);
    expect(w.pendingSec).toBe(0);
    expect(w.clawedBackSec).toBe(w.earnedSec);
  });
});

describe("spending credits on a job", () => {
  async function verifiedCredits(times: number) {
    const student = await pc("Student", { credits: true });
    const checker = await pc("Checker");
    for (let i = 0; i < times; i++) {
      await job(undefined, 250);
      await run(student.token);
      await run(checker.token);
    }
    return { student, checker };
  }

  it("needs enough verified credits: pending ones don't count, and a refused confirm leaves the quote as it was", async () => {
    const student = await pc("Student", { credits: true });
    await job(undefined, 250);
    await run(student.token);
    const j = await job(student.owner, 20, "credits");
    expect(j.res.status).toBe(409);
    expect((await body(j.res)).error).toBe("not_enough_credits");
    expect((await h.db.select().from(jobs).where(eq(jobs.id, j.id)))[0]).toMatchObject({ status: "quoted", creditsSpent: null });
  });

  it("pays for the job in credits, oldest-expiring first; no money is charged and owners who run it are paid as usual", async () => {
    const { student, checker } = await verifiedCredits(2);
    const before = await wallet(student.owner);
    const j = await job(student.owner, 20, "credits");
    expect(j.res.status).toBe(200);
    const confirmed = (await body<{ job: { status: string; creditsSpent: number; netChargedPaise: number } }>(j.res)).job;
    expect(confirmed).toMatchObject({ status: "queued", creditsSpent: j.creditCost, netChargedPaise: 0 });
    expect((await wallet(student.owner)).availableSec).toBe(before.availableSec - j.creditCost);
    // The oldest grant is used up first, then the next.
    const gs = await grants(h.db, student.owner.id, h.clock.now());
    expect(j.creditCost).toBeGreaterThan(gs[0]!.amount);
    expect(gs[0]!.remaining).toBe(0);
    expect(gs[1]!.remaining).toBe(gs[1]!.amount - (j.creditCost - gs[0]!.amount));
    // Another owner's PC runs it and is paid in rupees.
    const paid = await body<{ paidPaise: number }>(await run(checker.token));
    expect(paid.paidPaise).toBeGreaterThan(0);
  });

  it("two confirms racing for the same credits: only one gets them", async () => {
    const { student } = await verifiedCredits(2);
    const have = (await wallet(student.owner)).availableSec;
    const b = student.owner;
    const quote = async () =>
      (
        await body<{ job: { id: string; creditCost: number } }>(
          await H.quoteHandler(
            jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass: "rtx4070", params: {}, texts: Array.from({ length: 200 }, (_, i) => `race ${seq++} ${i}`) }),
            h.as(b),
          ),
        )
      ).job;
    const [q1, q2] = [await quote(), await quote()];
    expect(q1.creditCost).toBeLessThanOrEqual(have);
    expect(q1.creditCost + q2.creditCost).toBeGreaterThan(have);
    const [r1, r2] = await Promise.all([
      H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q1.id}/confirm`, { payWith: "credits" }), h.as(b), q1.id),
      H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q2.id}/confirm`, { payWith: "credits" }), h.as(b), q2.id),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await wallet(student.owner)).availableSec).toBeGreaterThanOrEqual(0);
  });

  it("a credit-paid job that misses its deadline gives the credits back", async () => {
    const { student } = await verifiedCredits(2);
    const before = (await wallet(student.owner)).availableSec;
    const j = await job(student.owner, 20, "credits");
    expect((await wallet(student.owner)).availableSec).toBe(before - j.creditCost);
    // Nobody runs it; the deadline passes.
    await h.db.update(nodes).set({ status: "offline" });
    h.clock.advance(3 * 24 * 3600);
    await runTick(h.db, h.clock.now(), "test-ip-secret");
    expect((await h.db.select().from(jobs).where(eq(jobs.id, j.id)))[0]).toMatchObject({ status: "deadline_missed" });
    expect((await wallet(student.owner)).availableSec).toBe(before);
    // Refunded once, however often the tick runs.
    await runTick(h.db, h.clock.now(), "test-ip-secret");
    expect((await wallet(student.owner)).availableSec).toBe(before);
  });
});

describe("expiry and the rules", () => {
  it("credits expire 6 months after they were earned and can't be spent after that", async () => {
    const student = await pc("Student", { credits: true });
    const checker = await pc("Checker");
    await job(undefined, 250);
    await run(student.token);
    await run(checker.token);
    const earned = (await wallet(student.owner)).availableSec;
    expect(earned).toBeGreaterThan(0);
    h.clock.set(new Date("2027-05-21T00:00:00Z"));
    expect((await wallet(student.owner)).expiringSoonSec).toBe(earned);
    h.clock.set(new Date("2027-05-23T00:00:00Z"));
    expect((await wallet(student.owner)).availableSec).toBe(0);
    const report = await runTick(h.db, h.clock.now(), "test-ip-secret");
    expect(report.creditsExpired).toBe(earned);
    const w = await wallet(student.owner);
    expect(w).toMatchObject({ availableSec: 0, expiredSec: earned, balanceSec: 0 });
    // Once only.
    expect((await runTick(h.db, h.clock.now(), "test-ip-secret")).creditsExpired).toBe(0);
  });

  it("credits never turn into money: payouts and earnings ignore them, and there is no way to cash out or transfer", async () => {
    const student = await pc("Student", { credits: true });
    const checker = await pc("Checker");
    await job(undefined, 250);
    await run(student.token);
    await run(checker.token);
    expect((await wallet(student.owner)).availableSec).toBeGreaterThan(0);
    const money = await body<{ earnings: { computePayPaise: number; balancePaise: number } }>(await H.earningsHandler(jsonReq("GET", "/api/earnings"), h.as(student.owner)));
    expect(money.earnings.computePayPaise).toBe(0);
    expect(money.earnings.balancePaise).toBe((await ownerEarnings(h.db, student.owner.id)).powerReimbursementPaise);
    const credits = await body<{ cashable: boolean; weighting: string }>(await H.creditsHandler(jsonReq("GET", "/api/credits"), h.as(student.owner)));
    expect(credits).toMatchObject({ cashable: false, weighting: "1.0x (frozen)" });
    // No owner-ledger row is ever written from a credit row.
    const rows = await h.db.select().from(ownerLedger).where(eq(ownerLedger.ownerId, student.owner.id));
    expect(rows.every((r) => r.entryType === "power_reimbursement")).toBe(true);
    // The enum has no cash-out or transfer type.
    const types = await h.db.execute(sql`select unnest(enum_range(null::credit_entry_type))::text as t`);
    const list = ((types as { rows?: Array<{ t: string }> }).rows ?? (types as unknown as Array<{ t: string }>)).map((r) => r.t);
    expect(list.sort()).toEqual(["clawback", "earned", "expired", "refund", "reversal", "spent"]);
  });

  it("the credit ledger is append-only", async () => {
    const student = await pc("Student", { credits: true });
    await job();
    await run(student.token);
    await expect(h.db.update(creditLedger).set({ amountGpuSeconds: 999_999 })).rejects.toThrow();
    await expect(h.db.delete(creditLedger)).rejects.toThrow();
    expect((await h.db.select().from(users)).length).toBeGreaterThan(0);
  });
});
