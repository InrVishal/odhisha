import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as H from "@/lib/api/handlers";
import type { ChallengeSpec } from "@/lib/coordinator/challenge";
import { CLASS_SPECS } from "@/lib/coordinator/classes";
import { MAX_NODES_PER_OWNER } from "@/lib/coordinator/nodes";
import { runTick } from "@/lib/coordinator/tick";
import { heldEarnings } from "@/lib/coordinator/verification";
import { auditLog, fragments, jobs, nodes, ownerLedger, users, canaryCovers } from "@/lib/db/schema";
import { ownerEarnings } from "@/lib/ledger";
import { freshDb } from "../helpers/db";
import { agentReq, beat, body, complete, embeddingsFor, harness, jsonReq, lease, makeUser, quoteTexts, registerNode, type Harness, type Leased, honestChallengeOutput } from "../helpers/coordinator";

/**
 * The attack table. One test per way a PC owner might try to cheat, each
 * asserting: is it detected, how fast, and what it costs the cheater.
 * Pass/fail of this file is the "attack-test table" in TESTING.md.
 */

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
const node = async (id: string) => (await h.db.select().from(nodes).where(eq(nodes.id, id)))[0]!;
const audits = async (action: string) => (await h.db.select().from(auditLog).where(eq(auditLog.action, action))).map((a) => a.targetId);

async function pc(name: string, owner?: User, gpuClass = "rtx4070") {
  const o = owner ?? (await makeUser(h.db, `${name.replace(/\W/g, "")}@example.in`));
  const r = await registerNode(h, o, { name, gpuClass });
  await beat(h, r.token);
  return { owner: o, ...r };
}

async function job(n = 20, gpuClass = "rtx4070", prefix?: string) {
  const buyer = await makeUser(h.db, `buyer${Math.random().toString(36).slice(2, 8)}@example.in`);
  const texts = prefix ? Array.from({ length: n }, (_, i) => `${prefix} ${i}`) : null;
  const res = texts
    ? await H.quoteHandler(jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass, params: {}, texts }), h.as(buyer))
    : await quoteTexts(h, buyer, n, gpuClass);
  const { job: j } = await body<{ job: { id: string } }>(res);
  await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${j.id}/confirm`), h.as(buyer), j.id);
  return { buyer, id: j.id };
}

/** Made-up vectors of the right shape: what a lazy PC returns. */
function madeUp(l: Leased, salt = 1): Buffer {
  const texts = (JSON.parse(Buffer.from(l.input, "base64").toString()) as { texts: string[] }).texts;
  return Buffer.from(JSON.stringify({ items: texts.map((_, i) => Array.from({ length: 384 }, (_, j) => Math.sin((i + 1) * (j + 1) * salt * 7.7))) }));
}

/** An honest answer nudged off course: what a "slightly wrong" PC returns. */
function slightlyWrong(l: Leased): Buffer {
  const honest = JSON.parse(embeddingsFor(l).toString()) as { items: number[][] };
  return Buffer.from(JSON.stringify({ items: honest.items.map((v, i) => v.map((x, j) => x + ((i + j) % 3 === 0 ? 0.3 * (x || 1) : 0))) }));
}

const isChallenge = async (l: Leased) => Boolean((await h.db.select({ c: jobs.challenge }).from(jobs).where(eq(jobs.id, l.parsed.jobId)))[0]?.c);

describe("attack table", () => {
  it("random or lazy outputs on a real job: caught by the re-run on a second PC; trust 500→250, compute pay reversed, buyer's piece corrected", async () => {
    const cheat = await pc("Cheat");
    const honest1 = await pc("Honest 1");
    const honest2 = await pc("Honest 2");
    const j = await job();
    const l = (await lease(h, cheat.token))!;
    await complete(h, cheat.token, l, madeUp(l));
    // Held, not paid out, while the check is open.
    expect(await heldEarnings(h.db, cheat.owner.id)).toBeGreaterThan(0);
    await complete(h, honest1.token, (await lease(h, honest1.token))!);
    await complete(h, honest2.token, (await lease(h, honest2.token))!);
    expect(await node(cheat.nodeId)).toMatchObject({ trustScore: 250, checksFailed: 1 });
    expect((await ownerEarnings(h.db, cheat.owner.id)).computePayPaise).toBe(0);
    expect(await audits("job.piece_corrected")).toEqual([j.id]);
  });

  it("slightly wrong outputs (beyond float noise): caught by the re-run; same consequence as made-up outputs", async () => {
    const cheat = await pc("Cheat");
    const honest1 = await pc("Honest 1");
    const honest2 = await pc("Honest 2");
    await job();
    const l = (await lease(h, cheat.token))!;
    await complete(h, cheat.token, l, slightlyWrong(l));
    await complete(h, honest1.token, (await lease(h, honest1.token))!);
    await complete(h, honest2.token, (await lease(h, honest2.token))!);
    expect(await node(cheat.nodeId)).toMatchObject({ trustScore: 250, checksFailed: 1 });
    expect(await node(honest1.nodeId)).toMatchObject({ trustScore: 520 });
  });

  it("replayed result (one piece's output handed in for another): refused on hand-in (422), piece requeued, trust 500→250", async () => {
    const cheat = await pc("Cheat");
    await job();
    const first = (await lease(h, cheat.token))!;
    const out = embeddingsFor(first);
    await complete(h, cheat.token, first, out);
    await job(20, "rtx4070", "a completely different sentence"); // different texts, so a different piece
    const second = (await lease(h, cheat.token))!;
    const res = await complete(h, cheat.token, second, out);
    expect(res.status).toBe(422);
    expect((await body(res)).error).toBe("replayed_output");
    expect((await h.db.select().from(fragments).where(eq(fragments.id, second.parsed.taskId)))[0]!.status).toBe("pending");
    expect(await node(cheat.nodeId)).toMatchObject({ trustScore: 250, checksFailed: 1 });
    expect(await audits("node.replay_rejected")).toEqual([cheat.nodeId]);
  });

  it("replayed result (the same hand-in sent twice): the second is refused (409) and paid once", async () => {
    const p = await pc("PC");
    await job();
    const l = (await lease(h, p.token))!;
    expect((await complete(h, p.token, l)).status).toBe(200);
    expect((await complete(h, p.token, l)).status).toBe(409);
    expect(await h.db.select().from(ownerLedger).where(eq(ownerLedger.fragmentId, l.parsed.taskId))).toHaveLength(2); // power + compute, once
  });

  it("inflated benchmark: the PC's own number is stored for display and ignored; the score comes from the coordinator's clock", async () => {
    h.deps.challenges = true;
    const liar = await pc("Liar");
    await beat(h, liar.token, { benchmarkScore: 10_000 });
    expect(await node(liar.nodeId)).toMatchObject({ reportedBenchmark: 10_000, benchmarkScore: null });
    // Three challenge runs that really take 10 s each: 250 items / 10 s = 25/s = 500 on the RTX 3060 = 1000 scale.
    for (let i = 0; i < 3; i++) {
      const l = (await lease(h, liar.token))!;
      expect(await isChallenge(l)).toBe(true);
      h.clock.advance(10);
      expect((await complete(h, liar.token, l, honestChallengeOutput(l))).status).toBe(200);
      h.clock.advance(11 * 60);
      await beat(h, liar.token);
    }
    expect(await node(liar.nodeId)).toMatchObject({ reportedBenchmark: 10_000, benchmarkScore: 500 });
  });

  it("inflated watts: clamped to the class ceiling (and audited), so electricity pay can't be inflated", async () => {
    const liar = await pc("Liar", undefined, "cpu");
    await beat(h, liar.token, { watts: 5000, wattsSource: "nvidia-smi" });
    expect((await node(liar.nodeId)).measuredWatts).toBeLessThanOrEqual(CLASS_SPECS.cpu.maxWatts);
    await job(20, "cpu");
    const l = (await lease(h, liar.token))!;
    const res = await H.completeHandler(
      new Request(`https://nightshift.test/api/agent/fragments/${l.parsed.taskId}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${liar.token}`,
          "content-type": "application/json",
          "x-lease-attempt": String(l.parsed.attempt),
          "x-output-sha256": createHash("sha256").update(embeddingsFor(l)).digest("hex"),
          "x-power-watts": "5000",
          "x-power-source": "nvidia-smi",
        },
        body: new Uint8Array(embeddingsFor(l)),
      }),
      h.deps,
      l.parsed.taskId,
    );
    expect(res.status).toBe(200);
    expect((await node(liar.nodeId)).measuredWatts).toBeLessThanOrEqual(CLASS_SPECS.cpu.maxWatts);
    expect((await audits("node.watts_clamped")).length).toBeGreaterThanOrEqual(1);
  });

  it("lease hoarding: a second piece is refused while one is held; letting leases lapse costs 25 trust each and ends in quarantine", async () => {
    const hoarder = await pc("Hoarder");
    await job();
    await job();
    expect(await lease(h, hoarder.token)).not.toBeNull();
    const again = await body<{ task: unknown; reason: string }>(await H.leaseHandler(agentReq(hoarder.token, "/api/agent/lease"), h.deps));
    expect(again).toMatchObject({ task: null, reason: "busy" });
    // It sits on the piece until the lease runs out: the piece goes back, trust drops.
    h.clock.advance(3 * 3600);
    await runTick(h.db, h.clock.now(), "test-ip-secret");
    expect((await node(hoarder.nodeId)).trustScore).toBe(475);
    // Keep doing it and the PC is quarantined.
    await h.db.update(nodes).set({ trustScore: 210, status: "online", lastSeenAt: h.clock.now() }).where(eq(nodes.id, hoarder.nodeId));
    expect(await lease(h, hoarder.token)).not.toBeNull();
    h.clock.advance(3 * 3600);
    await runTick(h.db, h.clock.now(), "test-ip-secret");
    expect(await node(hoarder.nodeId)).toMatchObject({ trustScore: 185, status: "quarantined" });
  });

  it("many fake nodes on one account: capped at 20 PCs, and they never check each other, however long the check waits", async () => {
    const farmer = await makeUser(h.db, "farmer@example.in");
    const a = await pc("Fake A", farmer);
    const b = await pc("Fake B", farmer);
    const outsider = await pc("Outsider");
    await job();
    await complete(h, a.token, (await lease(h, a.token))!);
    // The check of A's piece isn't given to B (same owner) while another owner could take it...
    expect(await lease(h, b.token)).toBeNull();
    // ...the other owner's PC gets it.
    const check = (await lease(h, outsider.token))!;
    expect((await h.db.select().from(fragments).where(eq(fragments.id, check.parsed.taskId)))[0]!.kind).toBe("verification");
    await complete(h, outsider.token, check);

    // With the other owner away, B never gets the check. While the other
    // owner was seen in the last day, the check waits for them...
    await h.db.update(nodes).set({ status: "offline" }).where(eq(nodes.id, outsider.nodeId));
    await job();
    await complete(h, a.token, (await lease(h, a.token))!);
    h.clock.advance(31 * 60);
    await beat(h, b.token);
    expect(await lease(h, b.token)).toBeNull();
    expect(await h.db.select().from(canaryCovers)).toEqual([]);
    // ...after that, it goes canary-only: still never to B, and A's pay waits for a canary.
    h.clock.advance(24 * 3600);
    await beat(h, b.token);
    expect(await lease(h, b.token)).toBeNull();
    expect((await h.db.select().from(canaryCovers)).map((c) => [c.nodeId, c.status])).toEqual([[a.nodeId, "waiting"]]);

    // And no more than 20 PCs per account.
    for (let i = 2; i < MAX_NODES_PER_OWNER; i++) await registerNode(h, farmer, { name: `Fake ${i}` });
    const extra = await H.registerNodeHandler(jsonReq("POST", "/api/nodes", { name: "One too many", gpuClass: "rtx4070" }), h.as(farmer));
    expect(extra.status).toBe(409);
    expect((await body(extra)).error).toBe("too_many_nodes");
  });

  it("canary failed: a made-up answer to a coordinator challenge is caught on hand-in; no pay, trust 500→250; a second failure quarantines", async () => {
    h.deps.challenges = true;
    const cheat = await pc("Cheat");
    const l = (await lease(h, cheat.token))!;
    expect(await isChallenge(l)).toBe(true);
    h.clock.advance(5);
    expect(await body(await complete(h, cheat.token, l, madeUp(l)))).toEqual({ accepted: true, paidPaise: 0 });
    expect(await node(cheat.nodeId)).toMatchObject({ trustScore: 250, checksFailed: 1, status: "online" });
    expect(await audits("node.canary_failed")).toEqual([cheat.nodeId]);
    expect(await h.db.select().from(ownerLedger).where(eq(ownerLedger.ownerId, cheat.owner.id))).toEqual([]);

    h.clock.advance(11 * 60);
    await beat(h, cheat.token);
    const l2 = (await lease(h, cheat.token))!;
    expect(await isChallenge(l2)).toBe(true);
    // The same vector for every text (a "lazy" constant answer) fails too.
    const texts = (JSON.parse(Buffer.from(l2.input, "base64").toString()) as { texts: string[] }).texts;
    const v = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    await complete(h, cheat.token, l2, Buffer.from(JSON.stringify({ items: texts.map(() => v) })));
    expect(await node(cheat.nodeId)).toMatchObject({ trustScore: 0, status: "quarantined" });
    expect((await beat(h, cheat.token)).status).toBe(403);
  });

  it("canary passed: an honest answer is paid, timed, and doesn't touch trust", async () => {
    h.deps.challenges = true;
    const p = await pc("Honest");
    const l = (await lease(h, p.token))!;
    h.clock.advance(4);
    const r = await body<{ accepted: boolean; paidPaise: number }>(await complete(h, p.token, l, honestChallengeOutput(l)));
    expect(r.paidPaise).toBeGreaterThan(0);
    expect(await node(p.nodeId)).toMatchObject({ trustScore: 500, checksFailed: 0 });
    const spec = (await h.db.select({ c: jobs.challenge }).from(jobs).where(isNotNull(jobs.challenge)).orderBy(desc(jobs.createdAt)))[0]!.c as ChallengeSpec;
    expect(spec.items).toBe(250);
    // Real work comes next, not another challenge.
    await job();
    const next = (await lease(h, p.token))!;
    expect(await isChallenge(next)).toBe(false);
  });

  it("payout held: earnings of a piece wait for its check, and everything a quarantined PC earned is held", async () => {
    const a = await pc("A");
    const b = await pc("B");
    await job();
    await complete(h, a.token, (await lease(h, a.token))!);
    const held = await heldEarnings(h.db, a.owner.id);
    expect(held).toBe((await ownerEarnings(h.db, a.owner.id)).balancePaise);
    await complete(h, b.token, (await lease(h, b.token))!);
    expect(await heldEarnings(h.db, a.owner.id)).toBe(0);
    const api = await body<{ earnings: { heldPaise: number; availablePaise: number; balancePaise: number } }>(await H.earningsHandler(jsonReq("GET", "/api/earnings"), h.as(a.owner)));
    expect(api.earnings).toMatchObject({ heldPaise: 0, availablePaise: api.earnings.balancePaise });

    await h.db.update(nodes).set({ status: "quarantined" }).where(and(eq(nodes.id, a.nodeId)));
    expect(await heldEarnings(h.db, a.owner.id)).toBe((await ownerEarnings(h.db, a.owner.id)).balancePaise);
  });

  // ─── Phase 7 ─────────────────────────────────────────────────────────────

  /** Runs every piece of a 10-piece job on one PC and returns how many got a check. */
  async function checkedPieces(token: string): Promise<number> {
    const j = await job(2500);
    for (let i = 0; i < 10; i++) {
      const l = (await lease(h, token))!;
      expect(l.parsed.jobId).toBe(j.id);
      await complete(h, token, l);
    }
    const rows = await h.db.select().from(fragments).where(and(eq(fragments.jobId, j.id), eq(fragments.kind, "primary")));
    return rows.filter((r) => r.verify).length;
  }

  it("cheating while new: half of a new PC's first 20 pieces are re-run (not 1 in 10); the rate falls with trust and goes back up if trust drops", async () => {
    const p = await pc("New PC");
    // Alternating draws: half of the pieces not picked at confirm time get an extra check.
    let k = 0;
    h.deps.checkRand = () => (k++ % 2 === 0 ? 0.1 : 0.9);
    expect(await checkedPieces(p.token)).toBe(6); // 1 picked + 5 of the other 9
    // Trusted (100 pieces, trust 900): only the 10% picked at confirm time, even with the luckiest draw.
    await h.db.update(nodes).set({ piecesDone: 100, trustScore: 900 }).where(eq(nodes.id, p.nodeId));
    h.deps.checkRand = () => 0;
    expect(await checkedPieces(p.token)).toBe(1);
    // Trust falls back to 480: every piece is a candidate for a check again.
    await h.db.update(nodes).set({ trustScore: 480 }).where(eq(nodes.id, p.nodeId));
    expect(await checkedPieces(p.token)).toBe(10);
  });

  it("fake accounts, payout anchor: one UPI ID can belong to one account; a second account trying it is refused and both are flagged", async () => {
    const a = await makeUser(h.db, "a@example.in");
    const b = await makeUser(h.db, "b@example.in");
    const link = (u: User, upiId: string) => H.linkUpiHandler(jsonReq("POST", "/api/account/upi", { upiId }), h.as(u));
    const ok = await link(a, "Ravi.K@OkAxis");
    expect(ok.status).toBe(200);
    expect(await body(ok)).toMatchObject({ upiMasked: "ra•••@okaxis", demo: true });
    const taken = await link(b, "ravi.k@okaxis");
    expect(taken.status).toBe(409);
    expect((await body(taken)).error).toBe("upi_in_use");
    const flags = await h.db.select().from(auditLog).where(eq(auditLog.action, "sybil.flagged"));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.meta).toMatchObject({ kind: "upi", accounts: `${b.id},${a.id}` });
    // The stored value is a keyed hash: the UPI ID itself isn't in the database.
    const row = (await h.db.select().from(users).where(eq(users.id, a.id)))[0]!;
    expect(row.upiHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("ravi.k@okaxis");
    expect((await link(b, "not a upi")).status).toBe(400);
  });

  it("fake PCs on one machine: the same device on two accounts is flagged, and one can't check the other", async () => {
    const a = await pc("A");
    const b = await pc("B");
    const device = "d".repeat(64);
    await beat(h, a.token, { deviceId: device });
    await beat(h, b.token, { deviceId: device });
    const flags = await h.db.select().from(auditLog).where(eq(auditLog.action, "sybil.flagged"));
    expect(flags.map((f) => (f.meta as { kind: string }).kind)).toEqual(["device"]);
    await job();
    await complete(h, a.token, (await lease(h, a.token))!);
    expect(await lease(h, b.token)).toBeNull();
    // Preview deployments only report it (all CI agents share one machine).
    h.deps.sybil = "report";
    expect(await lease(h, b.token)).not.toBeNull();
  });

  it("fake accounts on one network: PCs of different accounts on one /24 are flagged and never check each other; a PC elsewhere does", async () => {
    const leaseFrom = async (token: string, ip: string) => {
      const res = await H.leaseHandler(agentReq(token, "/api/agent/lease", undefined, { "x-real-ip": ip }), h.deps);
      const b = await body<Leased & { task: Leased["task"] | null }>(res);
      return b.task ? { ...b, parsed: JSON.parse(b.task.task) as Leased["parsed"] } : null;
    };
    const a = await pc("A");
    const b = await pc("B");
    const c = await pc("C");
    await H.heartbeatHandler(agentReq(a.token, "/api/agent/heartbeat", {}, { "x-real-ip": "203.0.113.5" }), h.deps);
    await H.heartbeatHandler(agentReq(b.token, "/api/agent/heartbeat", {}, { "x-real-ip": "203.0.113.77" }), h.deps);
    await H.heartbeatHandler(agentReq(c.token, "/api/agent/heartbeat", {}, { "x-real-ip": "198.51.100.9" }), h.deps);
    const flags = await h.db.select().from(auditLog).where(eq(auditLog.action, "sybil.flagged"));
    expect(flags.map((f) => (f.meta as { kind: string }).kind)).toEqual(["subnet"]);
    await job();
    const l = (await leaseFrom(a.token, "203.0.113.5"))!;
    await complete(h, a.token, l);
    expect(await leaseFrom(b.token, "203.0.113.77")).toBeNull();
    const check = (await leaseFrom(c.token, "198.51.100.9"))!;
    expect((await h.db.select().from(fragments).where(eq(fragments.id, check.parsed.taskId)))[0]!.kind).toBe("verification");
    // No IP is stored, only a keyed hash of the network.
    const stored = (await node(a.nodeId)).subnetHash!;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await h.db.select().from(nodes))).not.toContain("203.0.113");
  });
});
