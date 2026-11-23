import { and, countDistinct, eq, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { fragments, jobs } from "@/lib/db/schema";
import { bookBuyer, ledgerKeys } from "@/lib/ledger";
import { getPayments } from "@/lib/payments";
import { RETENTION_SEC } from "./schedule";

/**
 * Job and fragment state changes shared by the agent API, the scheduler tick
 * and node management. Every change is a conditional UPDATE (`WHERE status =
 * <expected>`), so two requests racing can't both apply it, and every money
 * movement is idempotent (see lib/ledger.ts).
 *
 * Fragment copies: a piece of a job (`seq`) has one primary fragment and may
 * get backup copies. The piece is done when ANY copy finishes. Verification
 * copies (verification.ts) never count towards finishing.
 */

/** Anything with the query methods: the db itself or a transaction. */
export type Q = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

const COUNTED_KINDS = ["primary", "backup"] as const;

export function purgeTime(now: Date): Date {
  return new Date(now.getTime() + RETENTION_SEC * 1000);
}

/**
 * Takes leased fragments matching `where` off their node. A fragment with
 * attempts left goes back to pending; one with none left fails, and the job
 * fails if that was the last live copy of its piece.
 */
export async function requeueLeased(q: Q, where: SQL, now: Date, ipSecret: string): Promise<number> {
  const changed = await q
    .update(fragments)
    .set({
      status: sql`case when ${fragments.attempts} < ${fragments.maxAttempts} then 'pending'::fragment_status else 'failed'::fragment_status end`,
      leaseExpiresAt: null,
    })
    .where(and(eq(fragments.status, "leased"), where))
    .returning({ jobId: fragments.jobId, seq: fragments.seq, status: fragments.status });
  for (const f of changed) if (f.status === "failed") await failJobIfPieceDead(q, f.jobId, f.seq, now, ipSecret);
  return changed.length;
}

/** Fails the job if no copy of piece `seq` is pending, leased or done. */
export async function failJobIfPieceDead(q: Q, jobId: string, seq: number, now: Date, ipSecret: string): Promise<boolean> {
  const live = await q
    .select({ id: fragments.id })
    .from(fragments)
    .where(
      and(
        eq(fragments.jobId, jobId),
        eq(fragments.seq, seq),
        inArray(fragments.kind, [...COUNTED_KINDS]),
        inArray(fragments.status, ["pending", "leased", "done"]),
      ),
    )
    .limit(1);
  if (live.length > 0) return false;
  return failJob(q, jobId, now, ipSecret);
}

export async function failJob(q: Q, jobId: string, now: Date, ipSecret: string): Promise<boolean> {
  const [job] = await q
    .update(jobs)
    .set({ status: "failed", purgeAfter: purgeTime(now) })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["queued", "running", "deadline_missed"])))
    .returning();
  if (!job) return false;
  await q
    .update(fragments)
    .set({ status: "cancelled" })
    .where(and(eq(fragments.jobId, jobId), eq(fragments.status, "pending")));
  await refundJob(q, job, "job_failed", now, ipSecret);
  return true;
}

/**
 * Refunds the full price, once. A job that missed its deadline or failed
 * costs the buyer ₹0. Owners keep what they earned for finished pieces:
 * NightShift takes that loss.
 */
export async function refundJob(
  q: Q,
  job: typeof jobs.$inferSelect,
  reason: "deadline_missed" | "job_failed",
  now: Date,
  ipSecret: string,
): Promise<boolean> {
  if (job.refundedAt || !job.confirmedAt) return false;
  const key = ledgerKeys.refund(job.id);
  const res = await getPayments().refund({ buyerId: job.buyerId, jobId: job.id, amountPaise: job.pricePaise, reason, idempotencyKey: key });
  if (!res.ok) return false;
  const [marked] = await q
    .update(jobs)
    .set({ refundedAt: now })
    .where(and(eq(jobs.id, job.id), isNull(jobs.refundedAt)))
    .returning({ id: jobs.id });
  if (!marked) return false;
  await bookBuyer(q, {
    buyerId: job.buyerId,
    jobId: job.id,
    entryType: "refund",
    amountPaise: job.pricePaise,
    idempotencyKey: key,
    memo: `${reason === "deadline_missed" ? "Deadline missed" : "Job could not finish"}: full refund (${res.reference})`,
  });
  await audit(
    q as Db,
    { actorId: null, actorType: "system", action: "job.refunded", targetType: "job", targetId: job.id, meta: { reason, amountPaise: job.pricePaise, demo: res.demo } },
    ipSecret,
  );
  return true;
}

/**
 * Marks the job finished once every piece has a done copy. On time → completed.
 * Late → deadline_missed and a full refund (the tick may already have done it).
 */
export async function completeJobIfDone(q: Q, jobId: string, now: Date, ipSecret: string): Promise<boolean> {
  const [{ done } = { done: 0 }] = await q
    .select({ done: countDistinct(fragments.seq) })
    .from(fragments)
    .where(and(eq(fragments.jobId, jobId), eq(fragments.status, "done"), inArray(fragments.kind, [...COUNTED_KINDS])));
  const [job] = await q.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job || job.completedAt || done < job.fragmentCount) return false;

  const late = now.getTime() > job.deadlineAt.getTime();
  const [updated] = await q
    .update(jobs)
    .set({ status: late ? "deadline_missed" : "completed", completedAt: now, purgeAfter: purgeTime(now) })
    .where(and(eq(jobs.id, jobId), isNull(jobs.completedAt), inArray(jobs.status, ["queued", "running", "deadline_missed"])))
    .returning();
  if (!updated) return false;
  if (late) await refundJob(q, updated, "deadline_missed", now, ipSecret);
  // No other copy of any piece needs to run. Checks (verification copies) still do.
  await q
    .update(fragments)
    .set({ status: "cancelled" })
    .where(and(eq(fragments.jobId, jobId), eq(fragments.status, "pending"), inArray(fragments.kind, [...COUNTED_KINDS])));
  return true;
}

/** Jobs past their deadline and not finished: mark them and refund in full. */
export async function markMissedDeadlines(q: Q, now: Date, ipSecret: string): Promise<number> {
  const missed = await q
    .update(jobs)
    .set({ status: "deadline_missed" })
    .where(and(inArray(jobs.status, ["queued", "running"]), lt(jobs.deadlineAt, now)))
    .returning();
  for (const job of missed) await refundJob(q, job, "deadline_missed", now, ipSecret);
  return missed.length;
}

/** Cancels the other copies of a piece once one copy has finished it. */
export async function cancelSiblings(q: Q, f: { id: string; jobId: string; seq: number }): Promise<void> {
  await q
    .update(fragments)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(fragments.jobId, f.jobId),
        eq(fragments.seq, f.seq),
        ne(fragments.id, f.id),
        inArray(fragments.kind, [...COUNTED_KINDS]),
        inArray(fragments.status, ["pending", "leased"]),
      ),
    );
}
