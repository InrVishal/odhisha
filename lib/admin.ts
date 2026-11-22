import { count, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { auditLog, buyerLedger, creditLedger, jobs, nodes, ownerLedger, users } from "@/lib/db/schema";

/**
 * Read-only views for the admin panel. Callers must check requireAdmin()
 * first (the page does; tests check a non-admin gets a 404).
 *
 * Deliberately no emails or IP hashes: admins see account ids, which is
 * enough to follow a problem through the ledger and audit log.
 */

export const ADMIN_LIST_LIMIT = 100;

export async function adminTotals(db: Db) {
  const [[u], [n], [j], [charged], [owners]] = await Promise.all([
    db.select({ c: count() }).from(users),
    db.select({ c: count() }).from(nodes),
    db.select({ c: count() }).from(jobs),
    db.select({ t: sql<string | null>`coalesce(sum(${buyerLedger.amountPaise}), 0)` }).from(buyerLedger),
    db.select({ t: sql<string | null>`coalesce(sum(${ownerLedger.amountPaise}), 0)` }).from(ownerLedger),
  ]);
  return {
    users: u?.c ?? 0,
    nodes: n?.c ?? 0,
    jobs: j?.c ?? 0,
    buyerNetPaise: Number(charged?.t ?? 0),
    ownerNetPaise: Number(owners?.t ?? 0),
  };
}

export async function adminNodes(db: Db, quarantinedOnly = false) {
  const q = db
    .select({
      id: nodes.id,
      ownerId: nodes.ownerId,
      name: nodes.name,
      gpuClass: nodes.gpuClass,
      status: nodes.status,
      paused: nodes.paused,
      benchmarkScore: nodes.benchmarkScore,
      measuredWatts: nodes.measuredWatts,
      wattsEstimated: nodes.wattsEstimated,
      trustScore: nodes.trustScore,
      lastSeenAt: nodes.lastSeenAt,
      quarantinedAt: nodes.quarantinedAt,
    })
    .from(nodes);
  return (quarantinedOnly ? q.where(eq(nodes.status, "quarantined")) : q).orderBy(desc(nodes.createdAt)).limit(ADMIN_LIST_LIMIT);
}

export async function adminJobs(db: Db) {
  return db
    .select({
      id: jobs.id,
      buyerId: jobs.buyerId,
      workloadType: jobs.workloadType,
      gpuClass: jobs.gpuClass,
      status: jobs.status,
      itemCount: jobs.itemCount,
      fragmentCount: jobs.fragmentCount,
      pricePaise: jobs.pricePaise,
      deadlineAt: jobs.deadlineAt,
      completedAt: jobs.completedAt,
      refundedAt: jobs.refundedAt,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(ADMIN_LIST_LIMIT);
}

export interface AdminLedgerRow {
  ledger: "owner" | "buyer" | "credit";
  id: number;
  at: Date;
  accountId: string;
  type: string;
  amount: number;
  unit: "paise" | "gpu_seconds";
  jobId: string | null;
  memo: string | null;
}

/** The newest rows of all three ledgers, merged, newest first. */
export async function adminLedger(db: Db): Promise<AdminLedgerRow[]> {
  const [o, b, c] = await Promise.all([
    db.select().from(ownerLedger).orderBy(desc(ownerLedger.id)).limit(ADMIN_LIST_LIMIT),
    db.select().from(buyerLedger).orderBy(desc(buyerLedger.id)).limit(ADMIN_LIST_LIMIT),
    db.select().from(creditLedger).orderBy(desc(creditLedger.id)).limit(ADMIN_LIST_LIMIT),
  ]);
  const rows: AdminLedgerRow[] = [
    ...o.map((r) => ({ ledger: "owner" as const, id: r.id, at: r.createdAt, accountId: r.ownerId, type: r.entryType, amount: r.amountPaise, unit: "paise" as const, jobId: r.jobId, memo: r.memo })),
    ...b.map((r) => ({ ledger: "buyer" as const, id: r.id, at: r.createdAt, accountId: r.buyerId, type: r.entryType, amount: r.amountPaise, unit: "paise" as const, jobId: r.jobId, memo: r.memo })),
    ...c.map((r) => ({ ledger: "credit" as const, id: r.id, at: r.createdAt, accountId: r.userId, type: r.entryType, amount: r.amountGpuSeconds, unit: "gpu_seconds" as const, jobId: r.jobId, memo: r.memo })),
  ];
  return rows.sort((a, z) => z.at.getTime() - a.at.getTime() || z.id - a.id).slice(0, ADMIN_LIST_LIMIT);
}

export async function adminAudit(db: Db) {
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorId: auditLog.actorId,
      actorType: auditLog.actorType,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      meta: auditLog.meta,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(ADMIN_LIST_LIMIT);
}
