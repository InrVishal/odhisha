import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { fragments, jobs, nodes } from "@/lib/db/schema";
import type { NodeRow } from "./nodes";
import { toNodeView } from "./nodes";
import { leaseSeconds, nodeBenchmark } from "./schedule";
import { mayCheck, pieceOrigins, type SybilMode } from "./sybil";
import { estimateSeconds, WORKLOADS } from "./workloads";

/**
 * Known-answer canaries: a piece of a real job that two PCs of different
 * owners already agreed on, sent again to a third PC as an ordinary check.
 *
 * To the third PC it is real work in every way: the same input bytes, item
 * count, workload, parameters and lease length as the piece it copies, signed
 * like every task, and checked against the agreed answer with the same
 * tolerance as any check. There is nothing in it to tell it apart, because
 * it isn't made up. (The made-up challenges in challenge.ts are only used
 * while no verified piece is available.)
 *
 * A wrong answer goes through the normal check path: the disagreement is
 * settled by a tie-break on yet another PC before anyone is blamed, so a
 * poisoned "known answer" can't punish an honest PC on its own.
 *
 * Privacy: this sends a buyer's piece to one more PC than the job needed,
 * only while the job's data still exists (7 days after it ends). The privacy
 * page says so.
 */

const SEARCH = 25;

/**
 * Picks a verified piece this PC may check (not run by a PC on the same
 * account, device or network) and leases a canary copy of it to the PC.
 * Null if there is none.
 */
export async function createKnownAnswerCanary(
  db: Db,
  node: NodeRow,
  now: Date,
  mode: SybilMode,
): Promise<{ fragment: typeof fragments.$inferSelect; job: typeof jobs.$inferSelect } | null> {
  const check = aliasedTable(fragments, "agreed_check");
  const checker = aliasedTable(nodes, "agreed_checker");
  const ran = aliasedTable(nodes, "ran");
  const candidates = await db
    .select({ p: fragments, j: jobs })
    .from(fragments)
    .innerJoin(jobs, eq(jobs.id, fragments.jobId))
    .innerJoin(check, and(eq(check.parentFragmentId, fragments.id), eq(check.kind, "verification"), eq(check.verdict, "match"), eq(check.canary, false)))
    .innerJoin(checker, eq(checker.id, check.completedByNodeId))
    .innerJoin(ran, eq(ran.id, fragments.completedByNodeId))
    .where(
      and(
        eq(fragments.status, "done"),
        ne(fragments.kind, "verification"),
        isNotNull(fragments.outputKey),
        isNull(jobs.purgedAt),
        isNull(jobs.challenge),
        // The answer is only "known" if two different owners agreed on it.
        ne(checker.ownerId, ran.ownerId),
        ne(ran.status, "quarantined"),
        ne(checker.status, "quarantined"),
      ),
    )
    .orderBy(desc(sql`${jobs.gpuClass} = ${node.gpuClass}`), sql`random()`)
    .limit(SEARCH);

  const me = { ownerId: node.ownerId, deviceHash: node.deviceHash, subnetHash: node.subnetHash };
  for (const { p, j } of candidates) {
    if (!mayCheck(me, await pieceOrigins(db, p.jobId, p.seq), mode)) continue;
    const expected = estimateSeconds(WORKLOADS[j.workloadType], p.itemCount, nodeBenchmark(toNodeView(node)));
    const leaseUntil = new Date(now.getTime() + leaseSeconds(expected) * 1000);
    return db.transaction(async (tx) => {
      await tx.update(nodes).set({ lastCanaryAt: now }).where(eq(nodes.id, node.id));
      const [fragment] = await tx
        .insert(fragments)
        .values({
          jobId: p.jobId,
          seq: p.seq,
          kind: "verification",
          canary: true,
          parentFragmentId: p.id,
          status: "leased",
          estGpuSeconds: p.estGpuSeconds,
          itemCount: p.itemCount,
          inputKey: p.inputKey,
          inputSha256: p.inputSha256,
          wrappedKey: p.wrappedKey,
          attempts: 1,
          maxAttempts: 1,
          leaseNodeId: node.id,
          leaseExpiresAt: leaseUntil,
          leaseExpectedSec: expected,
          startedAt: now,
        })
        .returning();
      return { fragment: fragment!, job: j };
    });
  }
  return null;
}
