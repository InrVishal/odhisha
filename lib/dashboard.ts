import { and, desc, eq, sql, sum } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { creditLedger, ownerLedger } from "@/lib/db/schema";

/**
 * Read-only queries for the owner dashboard. Like everything user-facing,
 * each one is scoped to the id from the session, never one from the client.
 */

export interface OwnerEntry {
  id: number;
  at: Date;
  type: (typeof ownerLedger.$inferSelect)["entryType"];
  nodeId: string | null;
  jobId: string | null;
  amountPaise: number;
  memo: string | null;
}

/** An owner's most recent ledger rows, newest first. */
export async function ownerLedgerEntries(db: Db, ownerId: string, limit = 50): Promise<OwnerEntry[]> {
  const rows = await db
    .select()
    .from(ownerLedger)
    .where(eq(ownerLedger.ownerId, ownerId))
    .orderBy(desc(ownerLedger.createdAt), desc(ownerLedger.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({ id: r.id, at: r.createdAt, type: r.entryType, nodeId: r.nodeId, jobId: r.jobId, amountPaise: r.amountPaise, memo: r.memo }));
}

export interface NodeEarnings {
  nodeId: string;
  computePayPaise: number;
  powerReimbursementPaise: number;
  pieces: number;
}

/** Earnings per PC, with electricity kept separate. */
export async function earningsByNode(db: Db, ownerId: string): Promise<NodeEarnings[]> {
  const rows = await db
    .select({
      nodeId: ownerLedger.nodeId,
      type: ownerLedger.entryType,
      total: sum(ownerLedger.amountPaise).mapWith(Number),
      pieces: sql<number>`count(distinct ${ownerLedger.fragmentId})`.mapWith(Number),
    })
    .from(ownerLedger)
    .where(and(eq(ownerLedger.ownerId, ownerId), sql`${ownerLedger.nodeId} is not null`))
    .groupBy(ownerLedger.nodeId, ownerLedger.entryType);
  const by = new Map<string, NodeEarnings>();
  for (const r of rows) {
    const id = r.nodeId!;
    const e = by.get(id) ?? { nodeId: id, computePayPaise: 0, powerReimbursementPaise: 0, pieces: 0 };
    if (r.type === "compute_pay" || r.type === "reversal") e.computePayPaise += r.total ?? 0;
    if (r.type === "power_reimbursement") e.powerReimbursementPaise += r.total ?? 0;
    if (r.type === "compute_pay") e.pieces = r.pieces;
    by.set(id, e);
  }
  return [...by.values()];
}

export interface OwnerPiece {
  fragmentId: string;
  at: Date;
  nodeId: string | null;
  jobId: string | null;
  computePayPaise: number;
  powerReimbursementPaise: number;
}

/** Every piece the owner's PCs ran (newest first), with its pay and electricity. */
export async function ownerPieces(db: Db, ownerId: string, limit = 200): Promise<OwnerPiece[]> {
  const rows = await db
    .select({
      fragmentId: ownerLedger.fragmentId,
      at: sql<Date>`min(${ownerLedger.createdAt})`.mapWith((v: string | Date) => new Date(v)),
      nodeId: sql<string | null>`min(${ownerLedger.nodeId}::text)`,
      jobId: sql<string | null>`min(${ownerLedger.jobId}::text)`,
      compute: sql<number>`coalesce(sum(${ownerLedger.amountPaise}) filter (where ${ownerLedger.entryType} in ('compute_pay', 'reversal')), 0)`.mapWith(Number),
      power: sql<number>`coalesce(sum(${ownerLedger.amountPaise}) filter (where ${ownerLedger.entryType} = 'power_reimbursement'), 0)`.mapWith(Number),
    })
    .from(ownerLedger)
    .where(and(eq(ownerLedger.ownerId, ownerId), sql`${ownerLedger.fragmentId} is not null`))
    .groupBy(ownerLedger.fragmentId)
    .orderBy(desc(sql`min(${ownerLedger.createdAt})`))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({ fragmentId: r.fragmentId!, at: r.at, nodeId: r.nodeId, jobId: r.jobId, computePayPaise: r.compute, powerReimbursementPaise: r.power }));
}

/** Time-Bank balance in standard GPU-seconds (never negative in practice). */
export async function creditBalance(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | null>`coalesce(sum(${creditLedger.amountGpuSeconds}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.total ?? 0);
}
