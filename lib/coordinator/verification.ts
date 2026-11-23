import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { ownerLedger } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { fragments, nodes } from "@/lib/db/schema";
import { clawBack, clawBackPending } from "@/lib/credits";
import { bookOwnerReversal, ledgerKeys } from "@/lib/ledger";
import { recordSample } from "./samples";
import { requeueLeased, type Q } from "./lifecycle";
import { fragmentDataKey, getBlob } from "./store";
import { extraCheckChance, nextTrust, outputsAgree, pickPiecesToVerify, shouldQuarantine, TRUST_AFTER_RELEASE, type CheckResult } from "./verify";

/** A check between two PCs of the same owner can blame but never reward (fake-node farms). */
async function sameOwner(q: Q, a: string, b: string): Promise<boolean> {
  const rows = await q.select({ ownerId: nodes.ownerId }).from(nodes).where(inArray(nodes.id, [a, b]));
  return rows.length === 2 && rows[0]!.ownerId === rows[1]!.ownerId;
}
import type { WorkloadType } from "./workloads";

/**
 * Verification, database side (the maths is in verify.ts).
 *
 * 1. Confirm: pick ~10% of the job's pieces (at least one) and flag them.
 * 2. A flagged piece finishes: queue a verification copy. Leasing never gives
 *    it to a PC that ran or holds another copy of the same piece.
 * 3. The check finishes: compare with the checked copy.
 *    - agree → both PCs pass.
 *    - disagree → queue a tie-break copy on a third PC. Nobody is blamed yet.
 * 4. The tie-break finishes:
 *    - sides with the checked copy → the first checker fails, the others pass;
 *    - sides with the first checker → the checked copy was wrong: that PC
 *      fails, its pay for the piece is reversed, and the buyer's result for
 *      the piece is replaced with the agreed output;
 *    - agrees with nobody → everyone involved loses a little trust.
 * A PC whose trust falls below the line is quarantined.
 *
 * Checks never hold up a job: the buyer's deadline is about the work, and a
 * check can wait for a second PC to come online (until the 7-day purge).
 */

/** Flags the pieces to check. Called once, when the buyer confirms. */
export async function planVerification(q: Q, jobId: string, pieces: number, rand?: (max: number) => number): Promise<number[]> {
  const seqs = pickPiecesToVerify(pieces, rand);
  if (seqs.length) {
    await q
      .update(fragments)
      .set({ verify: true })
      .where(and(eq(fragments.jobId, jobId), eq(fragments.kind, "primary"), inArray(fragments.seq, seqs)));
  }
  return seqs;
}

type FragmentRow = typeof fragments.$inferSelect;

async function insertCheck(q: Q, of: FragmentRow): Promise<void> {
  await q.insert(fragments).values({
    jobId: of.jobId,
    seq: of.seq,
    kind: "verification",
    parentFragmentId: of.id,
    status: "pending",
    estGpuSeconds: of.estGpuSeconds,
    itemCount: of.itemCount,
    inputKey: of.inputKey,
    inputSha256: of.inputSha256,
    wrappedKey: of.wrappedKey,
  });
}

/**
 * After a piece is done: queue its check if the piece was picked at confirm
 * time, or, on top of that, with the chance that brings the PC that did it
 * up to its own check rate (50% for a new or low-trust PC, see checkRate).
 */
export async function queueCheckIfPicked(q: Q, done: FragmentRow, opts: { rate?: number; rand?: () => number } = {}): Promise<boolean> {
  if (done.kind === "verification") return false;
  const [primary] = await q
    .select({ id: fragments.id, verify: fragments.verify })
    .from(fragments)
    .where(and(eq(fragments.jobId, done.jobId), eq(fragments.seq, done.seq), eq(fragments.kind, "primary")))
    .limit(1);
  if (!primary) return false;
  if (!primary.verify) {
    const extra = extraCheckChance(opts.rate ?? 0);
    if (extra <= 0 || (opts.rand ?? Math.random)() >= extra) return false;
    await q.update(fragments).set({ verify: true }).where(eq(fragments.id, primary.id));
  }
  const existing = await q
    .select({ id: fragments.id })
    .from(fragments)
    .where(and(eq(fragments.jobId, done.jobId), eq(fragments.seq, done.seq), eq(fragments.kind, "verification")))
    .limit(1);
  if (existing.length) return false;
  await insertCheck(q, done);
  return true;
}

export interface CheckOutcome {
  verdict: "match" | "mismatch" | "corrected" | "inconclusive";
  results: Array<{ nodeId: string; result: CheckResult }>;
  quarantined: string[];
}

/**
 * Settles a verification copy that has just been stored as done. `output`
 * is its (already schema-checked) output.
 */
export async function resolveCheck(
  q: Q,
  check: FragmentRow,
  ctx: { workload: WorkloadType; output: Uint8Array; dataKey: Buffer; now: Date; ipSecret: string },
): Promise<CheckOutcome | null> {
  if (check.kind !== "verification" || !check.parentFragmentId || !check.completedByNodeId) return null;
  const [parent] = await q.select().from(fragments).where(eq(fragments.id, check.parentFragmentId)).limit(1);
  if (!parent?.outputKey || !parent.completedByNodeId) return null;
  const key = fragmentDataKey(ctx.dataKey, parent);
  const parentOut = await getBlob(q, { dataKey: key, jobId: parent.jobId, key: parent.outputKey });
  if (!parentOut) return null;

  const agreesWithParent = outputsAgree(ctx.workload, parentOut, ctx.output);
  // Earlier checks of the same piece that came back "mismatch" make this a tie-break.
  const [first] = await q
    .select()
    .from(fragments)
    .where(
      and(
        eq(fragments.parentFragmentId, parent.id),
        eq(fragments.kind, "verification"),
        eq(fragments.verdict, "mismatch"),
        ne(fragments.id, check.id),
        isNotNull(fragments.completedByNodeId),
      ),
    )
    .orderBy(asc(fragments.completedAt))
    .limit(1);

  const checked = parent.completedByNodeId;
  const me = check.completedByNodeId;
  let verdict: CheckOutcome["verdict"];
  let results: CheckOutcome["results"];

  if (!first) {
    if (agreesWithParent) {
      verdict = "match";
      results = [
        { nodeId: checked, result: "pass" },
        { nodeId: me, result: "pass" },
      ];
    } else {
      verdict = "mismatch";
      results = [];
      await insertCheck(q, parent);
    }
  } else {
    const firstChecker = first.completedByNodeId!;
    if (agreesWithParent) {
      verdict = "match";
      results = [
        { nodeId: checked, result: "pass" },
        { nodeId: firstChecker, result: "fail" },
        { nodeId: me, result: "pass" },
      ];
      if (first.canary) {
        await audit(
          q as Db,
          { actorId: null, actorType: "system", action: "node.canary_failed", targetType: "node", targetId: firstChecker, meta: { kind: "known_answer", fragmentId: first.id } },
          ctx.ipSecret,
        );
      }
    } else {
      const firstOut = first.outputKey ? await getBlob(q, { dataKey: key, jobId: parent.jobId, key: first.outputKey }) : null;
      if (firstOut && outputsAgree(ctx.workload, firstOut, ctx.output)) {
        verdict = "corrected";
        results = [
          { nodeId: checked, result: "fail" },
          { nodeId: firstChecker, result: "pass" },
          { nodeId: me, result: "pass" },
        ];
        await correctPiece(q, parent, check, ctx);
      } else {
        verdict = "inconclusive";
        results = [checked, firstChecker, me].map((nodeId) => ({ nodeId, result: "inconclusive" as const }));
        await clawBack(q, parent.id, "its check was inconclusive", ctx.now, ctx.ipSecret);
      }
    }
  }

  await q.update(fragments).set({ verdict }).where(eq(fragments.id, check.id));
  // A known-answer canary that agreed is also a timing run on the coordinator's clock.
  if (check.canary && verdict === "match" && check.startedAt && check.completedAt) {
    await recordSample(q, me, check.itemCount, check.completedAt.getTime() - check.startedAt.getTime());
  }
  // PCs of one owner agreeing with each other proves nothing: no trust for it.
  if (verdict === "match" && !first && (await sameOwner(q, checked, me))) results = [];
  const quarantined: string[] = [];
  for (const r of results) if (await applyCheck(q, r.nodeId, r.result, ctx.now, ctx.ipSecret)) quarantined.push(r.nodeId);
  return { verdict, results, quarantined };
}

/**
 * The checked copy was wrong: the buyer gets the agreed output for this piece
 * instead, and the PC that produced the wrong one doesn't keep its pay.
 */
async function correctPiece(q: Q, wrong: FragmentRow, right: FragmentRow, ctx: { now: Date; ipSecret: string }): Promise<void> {
  await q
    .update(fragments)
    .set({ outputKey: right.outputKey, outputDigest: right.outputDigest })
    .where(eq(fragments.id, wrong.id));
  const [node] = await q.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, wrong.completedByNodeId!)).limit(1);
  if (node) {
    await bookOwnerReversal(q, {
      ownerId: node.ownerId,
      nodeId: wrong.completedByNodeId!,
      jobId: wrong.jobId,
      fragmentId: wrong.id,
      idempotencyKey: ledgerKeys.reversal(wrong.id),
      memo: "Pay reversed: this piece failed its check on two other PCs",
    });
  }
  await clawBack(q, wrong.id, "this piece failed its check on two other PCs", ctx.now, ctx.ipSecret);
  await audit(
    q as Db,
    { actorId: null, actorType: "system", action: "job.piece_corrected", targetType: "job", targetId: wrong.jobId, meta: { seq: wrong.seq, wrongNode: wrong.completedByNodeId } },
    ctx.ipSecret,
  );
}

/** Records one check result on a PC. Returns true if it was quarantined by it. */
export async function applyCheck(q: Q, nodeId: string, result: CheckResult, now: Date, ipSecret: string): Promise<boolean> {
  return adjustTrust(q, nodeId, (t) => nextTrust(t, result), result, now, ipSecret);
}

/** Takes `points` off a PC's trust (no check counted), quarantining it if it falls below the line. */
export async function penalize(q: Q, nodeId: string, points: number, now: Date, ipSecret: string): Promise<boolean> {
  return adjustTrust(q, nodeId, (t) => Math.max(0, t - points), null, now, ipSecret);
}

async function adjustTrust(q: Q, nodeId: string, next: (t: number) => number, result: CheckResult | null, now: Date, ipSecret: string): Promise<boolean> {
  const [n] = await q.select({ trustScore: nodes.trustScore, status: nodes.status }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!n) return false;
  const trust = next(n.trustScore);
  await q
    .update(nodes)
    .set({
      trustScore: trust,
      checksPassed: result === "pass" ? sql`${nodes.checksPassed} + 1` : nodes.checksPassed,
      checksFailed: result === "fail" ? sql`${nodes.checksFailed} + 1` : nodes.checksFailed,
    })
    .where(eq(nodes.id, nodeId));
  if (!shouldQuarantine(trust) || n.status === "quarantined" || n.status === "revoked") return false;
  return quarantine(q, nodeId, trust, now, ipSecret);
}

export async function quarantine(q: Q, nodeId: string, trust: number, now: Date, ipSecret: string): Promise<boolean> {
  const [done] = await q
    .update(nodes)
    .set({ status: "quarantined", quarantinedAt: now })
    .where(and(eq(nodes.id, nodeId), inArray(nodes.status, ["pending", "online", "offline"])))
    .returning({ id: nodes.id });
  if (!done) return false;
  // Anything it holds goes to another PC now.
  await requeueLeased(q, eq(fragments.leaseNodeId, nodeId), now, ipSecret);
  // Credits for work of this PC that isn't verified yet are taken back.
  const [owner] = await q.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (owner) await clawBackPending(q, { id: nodeId, ownerId: owner.ownerId }, "the PC was quarantined before this work was verified", now, ipSecret);
  await audit(q as Db, { actorId: null, actorType: "system", action: "node.quarantined", targetType: "node", targetId: nodeId, meta: { trustScore: trust } }, ipSecret);
  return true;
}

/** Admin only (the caller checks): lets a quarantined PC work again, just above the line. */
export async function releaseFromQuarantine(q: Q, nodeId: string, adminId: string, ipSecret: string, ip?: string): Promise<boolean> {
  const [done] = await q
    .update(nodes)
    .set({ status: "offline", quarantinedAt: null, trustScore: TRUST_AFTER_RELEASE })
    .where(and(eq(nodes.id, nodeId), eq(nodes.status, "quarantined")))
    .returning({ id: nodes.id });
  if (!done) return false;
  await audit(
    q as Db,
    { actorId: adminId, actorType: "admin", action: "node.released", targetType: "node", targetId: nodeId, ip, meta: { trustScore: TRUST_AFTER_RELEASE } },
    ipSecret,
  );
  return true;
}

export interface JobChecks {
  /** Pieces picked for a check. */
  planned: number;
  matched: number;
  corrected: number;
  inconclusive: number;
  /** Picked, but still waiting for a second (or third) PC. */
  waiting: number;
}

/** How the checks of one job stand, for the buyer's job page. */
export async function jobChecks(q: Q, jobId: string): Promise<JobChecks> {
  const rows = await q
    .select({ seq: fragments.seq, kind: fragments.kind, verify: fragments.verify, verdict: fragments.verdict, status: fragments.status })
    .from(fragments)
    .where(and(eq(fragments.jobId, jobId), sql`(${fragments.kind} = 'verification' or ${fragments.verify})`));
  const planned = new Set(rows.filter((r) => r.kind === "primary" && r.verify).map((r) => r.seq));
  const out: JobChecks = { planned: planned.size, matched: 0, corrected: 0, inconclusive: 0, waiting: 0 };
  for (const seq of planned) {
    const verdicts = rows.filter((r) => r.seq === seq && r.kind === "verification").map((r) => r.verdict);
    if (verdicts.includes("corrected")) out.corrected += 1;
    else if (verdicts.includes("inconclusive")) out.inconclusive += 1;
    else if (verdicts.includes("match")) out.matched += 1;
    else out.waiting += 1;
  }
  return out;
}

/**
 * Earnings not yet paid out: pay for pieces still waiting for (or in the
 * middle of) their check, and everything a quarantined PC earned. Payouts are
 * simulated, so "held" means the payout run would skip it.
 */
export async function heldEarnings(q: Q, ownerId: string): Promise<number> {
  const [row] = await q
    .select({
      held: sql<string | null>`coalesce(sum(${ownerLedger.amountPaise}), 0)`,
    })
    .from(ownerLedger)
    .innerJoin(nodes, eq(nodes.id, ownerLedger.nodeId))
    .leftJoin(fragments, eq(fragments.id, ownerLedger.fragmentId))
    .where(
      and(
        eq(ownerLedger.ownerId, ownerId),
        sql`(
          ${nodes.status} = 'quarantined'
          or exists (
            select 1 from fragment p
            where p.job_id = ${fragments.jobId} and p.seq = ${fragments.seq} and p.kind = 'primary' and p.verify
              and ${fragments.kind} <> 'verification'
              and not exists (
                select 1 from fragment v
                where v.job_id = p.job_id and v.seq = p.seq and v.kind = 'verification'
                  and v.verdict in ('match', 'corrected', 'inconclusive')
              )
              and exists (
                select 1 from fragment w
                where w.job_id = p.job_id and w.seq = p.seq and w.kind = 'verification' and w.status in ('pending', 'leased', 'done')
              )
          )
        )`,
      ),
    );
  return Number(row?.held ?? 0);
}
