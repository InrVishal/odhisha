import { and, eq, sql, sum } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { buyerLedger, ownerLedger } from "@/lib/db/schema";

/**
 * Ledger writes and balances. Ledgers are append-only (a DB trigger rejects
 * UPDATE, DELETE and TRUNCATE). Every write carries an idempotency key that
 * is UNIQUE in the table, so booking the same event twice is a no-op: retries
 * after a timeout or a crash can never double-pay or double-charge.
 *
 * Balances are always computed as SUM(amount), never stored.
 */

type Tx = Pick<Db, "insert" | "select">;

export const ledgerKeys = {
  charge: (jobId: string) => `charge:${jobId}`,
  refund: (jobId: string) => `refund:${jobId}`,
  computePay: (fragmentId: string) => `pay:${fragmentId}`,
  power: (fragmentId: string) => `power:${fragmentId}`,
  reversal: (fragmentId: string) => `reversal:${fragmentId}`,
};

/** Returns true if this call wrote the row, false if it was already booked. */
export async function bookBuyer(
  db: Tx,
  row: { buyerId: string; jobId: string; entryType: "charge" | "refund"; amountPaise: number; idempotencyKey: string; memo: string },
): Promise<boolean> {
  const amount = row.entryType === "refund" ? -Math.abs(row.amountPaise) : Math.abs(row.amountPaise);
  const res = await db
    .insert(buyerLedger)
    .values({ ...row, amountPaise: amount })
    .onConflictDoNothing({ target: buyerLedger.idempotencyKey })
    .returning({ id: buyerLedger.id });
  return res.length === 1;
}

export async function bookOwner(
  db: Tx,
  row: {
    ownerId: string;
    nodeId: string;
    jobId: string;
    fragmentId: string;
    entryType: "power_reimbursement" | "compute_pay";
    amountPaise: number;
    idempotencyKey: string;
    memo: string;
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(row.amountPaise) || row.amountPaise < 0) throw new Error("owner credit must be ≥ 0 paise");
  const res = await db
    .insert(ownerLedger)
    .values(row)
    .onConflictDoNothing({ target: ownerLedger.idempotencyKey })
    .returning({ id: ownerLedger.id });
  return res.length === 1;
}

/**
 * Takes back the compute pay booked for one fragment (it failed its check on
 * two other PCs). Electricity is left alone. Booked once, like every entry.
 */
export async function bookOwnerReversal(
  db: Tx,
  row: { ownerId: string; nodeId: string; jobId: string; fragmentId: string; idempotencyKey: string; memo: string },
): Promise<boolean> {
  const [paid] = await db
    .select({ total: sql<string | null>`coalesce(sum(${ownerLedger.amountPaise}), 0)` })
    .from(ownerLedger)
    .where(and(eq(ownerLedger.ownerId, row.ownerId), eq(ownerLedger.fragmentId, row.fragmentId), eq(ownerLedger.entryType, "compute_pay")));
  const amount = Number(paid?.total ?? 0);
  if (amount <= 0) return false;
  const res = await db
    .insert(ownerLedger)
    .values({ ...row, entryType: "reversal", amountPaise: -amount })
    .onConflictDoNothing({ target: ownerLedger.idempotencyKey })
    .returning({ id: ownerLedger.id });
  return res.length === 1;
}

export interface OwnerEarnings {
  computePayPaise: number;
  powerReimbursementPaise: number;
  paidOutPaise: number;
  /** compute + power − paid out. */
  balancePaise: number;
}

/** An owner's earnings, with power reimbursement as its own line. */
export async function ownerEarnings(db: Tx, ownerId: string, nodeId?: string): Promise<OwnerEarnings> {
  const where = nodeId ? and(eq(ownerLedger.ownerId, ownerId), eq(ownerLedger.nodeId, nodeId)) : eq(ownerLedger.ownerId, ownerId);
  const rowsByType = await db
    .select({ type: ownerLedger.entryType, total: sum(ownerLedger.amountPaise).mapWith(Number) })
    .from(ownerLedger)
    .where(where)
    .groupBy(ownerLedger.entryType);
  const by = Object.fromEntries(rowsByType.map((r) => [r.type, r.total ?? 0])) as Record<string, number>;
  const compute = (by.compute_pay ?? 0) + (by.reversal ?? 0);
  const power = by.power_reimbursement ?? 0;
  const paid = -(by.payout ?? 0);
  return { computePayPaise: compute, powerReimbursementPaise: power, paidOutPaise: paid, balancePaise: compute + power - paid };
}

/** Net amount the buyer has paid for one job (charge − refunds). */
export async function jobNetCharge(db: Tx, buyerId: string, jobId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | null>`coalesce(sum(${buyerLedger.amountPaise}), 0)` })
    .from(buyerLedger)
    .where(and(eq(buyerLedger.buyerId, buyerId), eq(buyerLedger.jobId, jobId)));
  return Number(row?.total ?? 0);
}
