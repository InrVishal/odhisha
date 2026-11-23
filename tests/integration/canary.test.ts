import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as H from "@/lib/api/handlers";
import { auditLog, benchmarkSamples, fragments, jobs, nodes } from "@/lib/db/schema";
import { freshDb } from "../helpers/db";
import { beat, body, complete, harness, jsonReq, lease, makeUser, registerNode, type Harness, type Leased } from "../helpers/coordinator";

/**
 * Known-answer canaries, and the test that they can't be told apart from
 * real work: a classifier is trained on everything an agent sees (the signed
 * task and its input) for real pieces and for canaries, and scored on pieces
 * it hasn't seen. Chance is 50%.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

/** Seeded PRNG (mulberry32), so the job texts are the same every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = "order refund delivery late screen battery charger invoice account password login train ticket hostel exam fee lab project report meeting tomorrow today please help thanks payment failed twice app crash phone laptop fan noise warranty".split(" ");
function buyerTexts(r: () => number): string[] {
  const n = 5 + Math.floor(r() * 75);
  return Array.from({ length: n }, () => {
    const len = 3 + Math.floor(r() * 14);
    const s = Array.from({ length: len }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
    return r() < 0.5 ? s.charAt(0).toUpperCase() + s.slice(1) + (r() < 0.5 ? "." : "?") : s;
  });
}

const textsOf = (l: Leased) => (JSON.parse(Buffer.from(l.input, "base64").toString()) as { texts: string[] }).texts;
function vec(text: string, salt = 0): number[] {
  const d = createHash("sha256").update(`${salt}:${text}`).digest();
  return Array.from({ length: 384 }, (_, j) => d[j % 32]! / 255 - 0.5 + j / 10_000);
}
const honest = (l: Leased) => Buffer.from(JSON.stringify({ items: textsOf(l).map((t) => vec(t)) }));
const madeUp = (l: Leased) => Buffer.from(JSON.stringify({ items: textsOf(l).map((t) => vec(t, 99)) }));

/** Everything the agent can see, as numbers. */
function features(l: Leased): number[] {
  const t = JSON.parse(l.task.task) as Record<string, unknown> & { iat: number; exp: number; itemCount: number; attempt: number; params: unknown; workload: string; image: string };
  const texts = textsOf(l);
  const lens = texts.map((s) => s.length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
  const all = texts.join(" ");
  const ratio = (re: RegExp) => (all.match(re)?.length ?? 0) / Math.max(1, all.length);
  return [
    t.itemCount,
    t.attempt,
    t.exp - t.iat,
    JSON.stringify(t.params).length,
    t.workload.length + t.image.length,
    Object.keys(t).length,
    texts.length,
    mean,
    sd,
    new Set(texts).size / texts.length,
    texts.filter((s) => /^[A-Z]/.test(s)).length / texts.length,
    ratio(/[A-Z]/g),
    ratio(/[0-9]/g),
    ratio(/[.,?!]/g),
    Buffer.from(l.input, "base64").length,
  ];
}

/** Logistic regression on z-scored features, k-fold: the share of held-out pieces it labels right. */
function heldOutAccuracy(xs: number[][], ys: number[], k = 5): number {
  const idx = xs.map((_, i) => i);
  const r = prng(7);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  let right = 0;
  for (let fold = 0; fold < k; fold++) {
    const test = idx.filter((_, i) => i % k === fold);
    const train = idx.filter((_, i) => i % k !== fold);
    const d = xs[0]!.length;
    const mu = Array.from({ length: d }, (_, j) => train.reduce((s, i) => s + xs[i]![j]!, 0) / train.length);
    const sg = Array.from({ length: d }, (_, j) => Math.sqrt(train.reduce((s, i) => s + (xs[i]![j]! - mu[j]!) ** 2, 0) / train.length) || 1);
    const z = (x: number[]) => x.map((v, j) => (v - mu[j]!) / sg[j]!);
    const w = Array(d + 1).fill(0) as number[];
    for (let epoch = 0; epoch < 400; epoch++) {
      for (const i of train) {
        const x = z(xs[i]!);
        const p = 1 / (1 + Math.exp(-(w[d]! + x.reduce((s, v, j) => s + v * w[j]!, 0))));
        const g = p - ys[i]!;
        for (let j = 0; j < d; j++) w[j] = w[j]! - 0.05 * (g * x[j]! + 0.001 * w[j]!);
        w[d] = w[d]! - 0.05 * g;
      }
    }
    for (const i of test) {
      const x = z(xs[i]!);
      const p = 1 / (1 + Math.exp(-(w[d]! + x.reduce((s, v, j) => s + v * w[j]!, 0))));
      if ((p >= 0.5 ? 1 : 0) === ys[i]) right += 1;
    }
  }
  return right / xs.length;
}

async function setup(): Promise<Harness> {
  const { db, cleanup } = await freshDb();
  cleanups.push(cleanup);
  return harness(db);
}

async function job(h: Harness, buyer: Awaited<ReturnType<typeof makeUser>>, texts: string[]) {
  const q = await body<{ job: { id: string } }>(await H.quoteHandler(jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass: "rtx4070", params: {}, texts }), h.as(buyer)));
  await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.job.id}/confirm`), h.as(buyer), q.job.id);
  return q.job.id;
}

/** Makes the next lease of this PC a canary (as on its first lease), or real work. */
async function nextLeaseIsCanary(h: Harness, nodeId: string, canary: boolean) {
  await h.db.update(nodes).set({ benchmarkScore: canary ? null : 1000, lastCanaryAt: canary ? null : h.clock.now() }).where(eq(nodes.id, nodeId));
}

describe("known-answer canaries", () => {
  it("are real pieces two other owners agreed on; an honest answer passes and is timed, a made-up one is caught through a tie-break", async () => {
    const h = await setup();
    const [ra, rb, rc, rd] = await Promise.all(["ran", "checked", "tested", "tiebreak"].map((n) => makeUser(h.db, `${n}@example.in`)));
    const buyer = await makeUser(h.db, "buyer@example.in");
    const A = await registerNode(h, ra!, { name: "A" });
    const B = await registerNode(h, rb!, { name: "B" });
    const C = await registerNode(h, rc!, { name: "C" });
    const D = await registerNode(h, rd!, { name: "D" });
    for (const n of [A, B, C, D]) await beat(h, n.token);
    const r = prng(1);
    for (let i = 0; i < 2; i++) {
      await job(h, buyer, buyerTexts(r));
      const la = (await lease(h, A.token))!;
      await complete(h, A.token, la, honest(la));
      const lb = (await lease(h, B.token))!;
      await complete(h, B.token, lb, honest(lb));
    }
    h.deps.challenges = true;

    // Honest: passes, is paid, and is timed on the coordinator's clock.
    await nextLeaseIsCanary(h, C.nodeId, true);
    const l1 = (await lease(h, C.token))!;
    const f1 = (await h.db.select().from(fragments).where(eq(fragments.id, l1.parsed.taskId)))[0]!;
    expect(f1).toMatchObject({ kind: "verification", canary: true });
    const original = (await h.db.select().from(fragments).where(eq(fragments.id, f1.parentFragmentId!)))[0]!;
    expect(l1.parsed.inputSha256).toBe(original.inputSha256);
    h.clock.advance(5);
    expect((await body<{ paidPaise: number }>(await complete(h, C.token, l1, honest(l1)))).paidPaise).toBeGreaterThan(0);
    expect((await h.db.select().from(fragments).where(eq(fragments.id, f1.id)))[0]!.verdict).toBe("match");
    expect(await h.db.select().from(benchmarkSamples).where(eq(benchmarkSamples.nodeId, C.nodeId))).toHaveLength(1);

    // Made up: disagrees → a tie-break on a fourth PC sides with the known answer → C fails.
    await nextLeaseIsCanary(h, C.nodeId, true);
    const l2 = (await lease(h, C.token))!;
    expect((await h.db.select().from(fragments).where(eq(fragments.id, l2.parsed.taskId)))[0]!.canary).toBe(true);
    const before = (await h.db.select().from(nodes).where(eq(nodes.id, C.nodeId)))[0]!.trustScore;
    await complete(h, C.token, l2, madeUp(l2));
    await nextLeaseIsCanary(h, D.nodeId, false);
    const tie = (await lease(h, D.token))!;
    expect((await h.db.select().from(fragments).where(eq(fragments.id, tie.parsed.taskId)))[0]).toMatchObject({ kind: "verification", canary: false });
    await complete(h, D.token, tie, honest(tie));
    expect((await h.db.select().from(nodes).where(eq(nodes.id, C.nodeId)))[0]!.trustScore).toBe(before - 250);
    const canaryAudits = await h.db.select().from(auditLog).where(eq(auditLog.action, "node.canary_failed"));
    expect(canaryAudits.map((a) => a.targetId)).toEqual([C.nodeId]);
    // The buyer's results weren't touched.
    expect((await h.db.select().from(fragments).where(eq(fragments.id, original.id)))[0]!.outputDigest).toBe(original.outputDigest);
  });

  it("are never sent to a PC on the same account as a PC that ran or checked the piece", async () => {
    const h = await setup();
    const [ra, rb] = await Promise.all(["ran", "checked"].map((n) => makeUser(h.db, `${n}@example.in`)));
    const buyer = await makeUser(h.db, "buyer@example.in");
    const A = await registerNode(h, ra!, { name: "A" });
    const B = await registerNode(h, rb!, { name: "B" });
    const A2 = await registerNode(h, ra!, { name: "A's second PC" });
    for (const n of [A, B, A2]) await beat(h, n.token);
    await job(h, buyer, buyerTexts(prng(2)));
    const la = (await lease(h, A.token))!;
    await complete(h, A.token, la, honest(la));
    const lb = (await lease(h, B.token))!;
    await complete(h, B.token, lb, honest(lb));
    h.deps.challenges = true;
    await nextLeaseIsCanary(h, A2.nodeId, true);
    const l = (await lease(h, A2.token))!;
    // No eligible verified piece → the made-up challenge instead.
    expect((await h.db.select().from(fragments).where(eq(fragments.id, l.parsed.taskId)))[0]!.canary).toBe(false);
    expect((await h.db.select({ c: jobs.challenge }).from(jobs).where(eq(jobs.id, l.parsed.jobId)))[0]!.c).not.toBeNull();
  });
});

describe("can a cheater tell canaries from real work?", () => {
  it(
    "known-answer canaries: a classifier on everything the agent sees does no better than chance; the made-up fallback is easy to spot",
    { timeout: 600_000 },
    async () => {
      const N = 40;
      const h = await setup();
      const [ra, rb, rc] = await Promise.all(["ran", "checked", "tested"].map((n) => makeUser(h.db, `${n}@example.in`)));
      const buyer = await makeUser(h.db, "buyer@example.in");
      const A = await registerNode(h, ra!, { name: "A" });
      const B = await registerNode(h, rb!, { name: "B" });
      const C = await registerNode(h, rc!, { name: "C" });
      for (const n of [A, B, C]) await beat(h, n.token);
      const r = prng(42);
      // A pool of verified pieces: A ran each, B's check matched.
      for (let i = 0; i < N + 30; i++) {
        await job(h, buyer, buyerTexts(r));
        const la = (await lease(h, A.token))!;
        await complete(h, A.token, la, honest(la));
        const lb = (await lease(h, B.token))!;
        await complete(h, B.token, lb, honest(lb));
      }
      h.deps.challenges = true;
      const xs: number[][] = [];
      const ys: number[] = [];
      for (let i = 0; i < 2 * N; i++) {
        const canary = i % 2 === 1;
        await nextLeaseIsCanary(h, C.nodeId, canary);
        if (!canary) await job(h, buyer, buyerTexts(r));
        const l = (await lease(h, C.token))!;
        const f = (await h.db.select().from(fragments).where(eq(fragments.id, l.parsed.taskId)))[0]!;
        expect(f.canary).toBe(canary);
        xs.push(features(l));
        ys.push(canary ? 1 : 0);
        await complete(h, C.token, l, honest(l));
        h.clock.advance(60);
      }
      const knownAnswer = heldOutAccuracy(xs, ys);

      // Control: the same classifier against the made-up fallback challenges (no verified pieces in this database).
      const h2 = await setup();
      const rx = await makeUser(h2.db, "x@example.in");
      const buyer2 = await makeUser(h2.db, "buyer2@example.in");
      const X = await registerNode(h2, rx, { name: "X" });
      await beat(h2, X.token);
      h2.deps.challenges = true;
      const xs2: number[][] = [];
      const ys2: number[] = [];
      const r2 = prng(43);
      for (let i = 0; i < 2 * N; i++) {
        const canary = i % 2 === 1;
        await nextLeaseIsCanary(h2, X.nodeId, canary);
        if (!canary) await job(h2, buyer2, buyerTexts(r2));
        const l = (await lease(h2, X.token))!;
        xs2.push(features(l));
        ys2.push(canary ? 1 : 0);
        if (!canary) await complete(h2, X.token, l, honest(l));
        else await h2.db.update(fragments).set({ status: "cancelled" }).where(eq(fragments.id, l.parsed.taskId));
        h2.clock.advance(60);
      }
      const madeUpFallback = heldOutAccuracy(xs2, ys2);

      console.log(`[canary classifier] held-out accuracy (chance 0.50, n=${2 * N} each): known-answer canaries ${knownAnswer.toFixed(2)}, made-up fallback ${madeUpFallback.toFixed(2)}`);
      // n = 80: chance ± 3.2 standard errors.
      expect(knownAnswer).toBeLessThanOrEqual(0.68);
      // The test has teeth: it does spot the made-up ones (a 250-sentence piece among small real jobs).
      expect(madeUpFallback).toBeGreaterThanOrEqual(0.9);
    },
  );
});
