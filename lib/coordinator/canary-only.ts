import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { clawBack } from "@/lib/credits";
import type { Db } from "@/lib/db/client";
import { canaryCovers, fragments, jobs, nodes } from "@/lib/db/schema";
import { bookOwnerReversal, ledgerKeys } from "@/lib/ledger";
import type { Q } from "./lifecycle";
import { toNodeView } from "./nodes";
import { wattTariff } from "./schedule";
import { mayCheck, pieceOrigins, type SybilMode } from "./sybil";

/**
 * Canary-only verification, for when no independent PC exists to check a
 * piece: every PC that could take the check shares the account, device or
 * network of a PC that ran the piece (a college lab, or one person's three
 * laptops at home). Such a check could only ever be two of one person's PCs
 * agreeing, which proves nothing, so it never runs.
 *
 * Instead:
 * - The check is cancelled and the piece is "covered": its pay stays held.
 * - While a PC has covered pieces, 30% of its leases are canaries (and when
 *   it has no other work, a canary anyway), so it can't tell which pieces
 *   matter.
 * - A canary issued after the cover that passes releases the pay of every
 *   covered piece of that PC. It earns NO trust: nothing independent was
 *   checked.
 * - A canary that fails reverses the pay of every covered piece (and claws
 *   back their Time-Bank credits). The failed canary itself costs trust as
 *   usual (−250).
 *
 * There is no switch to turn this off for demos: pay for an unchecked piece
 * is only ever released by a passed canary.
 */

export const CANARY_ONLY_RATE = 0.3;
/** A PC seen this recently that could check the piece is worth waiting for. */
export const INDEPENDENT_SEEN_SEC = 24 * 3600;
/** Checks looked at per tick, picked at random so none is starved. */
const PER_TICK = 10;

/**
 * Tick step: covers the first checks that no independent PC can run.
 * Returns how many were switched to canary-only.
 */
export async function coverUncheckablePieces(db: Db, now: Date, mode: SybilMode): Promise<number> {
  const waiting = await db
    .select({ f: fragments, j: jobs })
    .from(fragments)
    .innerJoin(jobs, eq(jobs.id, fragments.jobId))
    .where(and(eq(fragments.kind, "verification"), eq(fragments.status, "pending"), eq(fragments.canary, false), isNull(jobs.purgedAt), isNull(jobs.challenge)))
    .orderBy(sql`random()`)
    .limit(PER_TICK);
  let covered = 0;
  const seenSince = new Date(now.getTime() - INDEPENDENT_SEEN_SEC * 1000);
  for (const { f, j } of waiting) {
    if (!f.parentFragmentId) continue;
    // Tie-breaks wait for a third PC: an independent one already disagreed, so one exists.
    const [mismatch] = await db
      .select({ id: fragments.id })
      .from(fragments)
      .where(and(eq(fragments.parentFragmentId, f.parentFragmentId), eq(fragments.kind, "verification"), eq(fragments.verdict, "mismatch")))
      .limit(1);
    if (mismatch) continue;
    const origins = await pieceOrigins(db, f.jobId, f.seq);
    const candidates = await db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.gpuClass, j.gpuClass),
          inArray(nodes.status, ["pending", "online", "offline"]),
          gt(nodes.lastSeenAt, seenSince),
          lte(nodes.ownerRatePaisePerHr, j.maxOwnerRate),
        ),
      );
    const independent = candidates.some(
      (n) => wattTariff(toNodeView(n)) <= j.maxWattTariff && mayCheck({ ownerId: n.ownerId, deviceHash: n.deviceHash, subnetHash: n.subnetHash }, origins, mode),
    );
    if (independent) continue;
    const [paid] = await db.select().from(fragments).where(eq(fragments.id, f.parentFragmentId)).limit(1);
    if (!paid?.completedByNodeId || paid.status !== "done") continue;
    const done = await db.transaction(async (tx) => {
      const [cancelled] = await tx
        .update(fragments)
        .set({ status: "cancelled" })
        .where(and(eq(fragments.id, f.id), eq(fragments.status, "pending")))
        .returning({ id: fragments.id });
      if (!cancelled) return false;
      await tx
        .insert(canaryCovers)
        .values({ jobId: f.jobId, seq: f.seq, fragmentId: paid.id, nodeId: paid.completedByNodeId!, createdAt: now })
        .onConflictDoNothing({ target: canaryCovers.fragmentId });
      return true;
    });
    if (done) covered += 1;
  }
  return covered;
}

/** True while this PC has covered pieces waiting for a canary. */
export async function owesCanary(q: Q, nodeId: string): Promise<boolean> {
  const [row] = await q
    .select({ id: canaryCovers.id })
    .from(canaryCovers)
    .where(and(eq(canaryCovers.nodeId, nodeId), eq(canaryCovers.status, "waiting")))
    .limit(1);
  return Boolean(row);
}

/**
 * A canary this PC was sent at `issuedAt` has been settled. Every piece of the
 * PC covered before then is released (passed) or reversed (failed).
 * Returns how many covers it settled.
 */
export async function settleCovers(
  q: Q,
  args: { nodeId: string; canaryFragmentId: string; passed: boolean; issuedAt: Date; now: Date; ipSecret: string },
): Promise<number> {
  const settled = await q
    .update(canaryCovers)
    .set({ status: args.passed ? "passed" : "failed", canaryFragmentId: args.canaryFragmentId, settledAt: args.now })
    .where(and(eq(canaryCovers.nodeId, args.nodeId), eq(canaryCovers.status, "waiting"), lte(canaryCovers.createdAt, args.issuedAt)))
    .returning();
  if (settled.length === 0) return 0;
  if (!args.passed) {
    const [node] = await q.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, args.nodeId)).limit(1);
    for (const c of settled) {
      if (node) {
        await bookOwnerReversal(q, {
          ownerId: node.ownerId,
          nodeId: args.nodeId,
          jobId: c.jobId,
          fragmentId: c.fragmentId,
          idempotencyKey: ledgerKeys.reversal(c.fragmentId),
          memo: "Pay reversed: this PC failed a canary while this piece was waiting for one",
        });
      }
      await clawBack(q, c.fragmentId, "this PC failed a canary while this piece was waiting for one", args.now, args.ipSecret);
    }
  }
  await audit(
    q as Db,
    {
      actorId: null,
      actorType: "system",
      action: args.passed ? "canary.cover_passed" : "canary.cover_failed",
      targetType: "node",
      targetId: args.nodeId,
      meta: { pieces: settled.length, canaryFragmentId: args.canaryFragmentId },
    },
    args.ipSecret,
  );
  return settled.length;
}

export interface JobCovers {
  waiting: number;
  passed: number;
  failed: number;
}

export async function jobCovers(q: Q, jobId: string): Promise<JobCovers> {
  const rows = await q
    .select({ status: canaryCovers.status, n: sql<number>`count(*)`.mapWith(Number) })
    .from(canaryCovers)
    .where(eq(canaryCovers.jobId, jobId))
    .groupBy(canaryCovers.status);
  const out: JobCovers = { waiting: 0, passed: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

