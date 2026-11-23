import { and, asc, eq, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { creditLedger, users } from "@/lib/db/schema";
import { CoordinatorError } from "@/lib/coordinator/errors";
import type { Q } from "@/lib/coordinator/lifecycle";
import { earnedStandardSeconds } from "@/lib/timebank";

export { creditCost } from "@/lib/timebank";

/**
 * Time-Bank credits, database side (the unit maths is in lib/timebank.ts).
 *
 * - A PC set to earn credits gets them for pieces of buyers' jobs instead of
 *   compute pay (electricity is still paid in rupees). One grant per piece,
 *   in standard GPU-seconds of the piece, weighting frozen at 1.0×.
 * - A grant is PENDING until the work is verified: its check matched, or
 *   (for pieces not picked for a check) 24 hours have passed and the PC isn't
 *   quarantined. Only verified credits can be spent.
 * - Clawed back in full if the piece is corrected (it was wrong), its check
 *   is inconclusive, its check can't run before the data is deleted, or the
 *   PC is quarantined while the grant is still pending.
 * - Each grant expires 6 months after it was earned.
 * - Credits pay for jobs. They can't be cashed out or given to anyone: there
 *   is no entry type, function or route for either.
 *
 * Everything is a row in the append-only credit_ledger, keyed for
 * idempotency like the money ledgers. Balances are sums, never stored.
 */

export const CREDIT_TTL_MONTHS = 6;
export const SETTLE_AFTER_SEC = 24 * 3600;
/** "Expiring soon" on the wallet. */
export const EXPIRING_SOON_SEC = 30 * 24 * 3600;

export const creditKeys = {
  earn: (fragmentId: string) => `credit:${fragmentId}`,
  clawback: (fragmentId: string) => `claw:${fragmentId}`,
  spend: (jobId: string, grantId: number) => `spend:${jobId}:${grantId}`,
  refund: (spentId: number) => `crefund:${spentId}`,
  expire: (grantId: number, n: number) => `expire:${grantId}:${n}`,
};

/** Same day-of-month n calendar months later (UTC), clamped to the month's end. */
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/**
 * The outer row in correlated subqueries, fully qualified: a bare column name
 * would resolve to the subquery's own credit_ledger alias.
 */
const LEDGER = sql.identifier("credit_ledger");
const OUTER_ID = sql`${LEDGER}.${sql.identifier("id")}`;
const OUTER_FRAGMENT = sql`${LEDGER}.${sql.identifier("fragment_id")}`;
const OUTER_NODE = sql`${LEDGER}.${sql.identifier("node_id")}`;

export type GrantState = "pending" | "available" | "expired" | "clawed_back";

export interface Grant {
  id: number;
  nodeId: string | null;
  jobId: string | null;
  fragmentId: string | null;
  earnedAt: Date;
  expiresAt: Date;
  amount: number;
  /** amount + every spent/refund/clawback/expired row on it. */
  remaining: number;
  state: GrantState;
}

/** Every grant of a user with what's left of it and its state at `now`. */
export async function grants(q: Q, userId: string, now: Date, where?: { nodeId?: string; jobId?: string }): Promise<Grant[]> {
  const g = creditLedger;
  const at = now.toISOString();
  const settled = new Date(now.getTime() - SETTLE_AFTER_SEC * 1000).toISOString();
  const rows = await q
    .select({
      id: g.id,
      nodeId: g.nodeId,
      jobId: g.jobId,
      fragmentId: g.fragmentId,
      earnedAt: g.createdAt,
      expiresAt: g.expiresAt,
      amount: g.amountGpuSeconds,
      adjust: sql<string>`coalesce((select sum(c.amount_gpu_seconds) from credit_ledger c where c.grant_id = ${OUTER_ID}), 0)`,
      clawed: sql<boolean>`exists (select 1 from credit_ledger c where c.grant_id = ${OUTER_ID} and c.entry_type = 'clawback')`,
      // Its check (or the tie-break) agreed with it.
      matched: sql<boolean>`exists (select 1 from fragment v where v.parent_fragment_id = ${OUTER_FRAGMENT} and v.kind = 'verification' and v.verdict = 'match')`,
      // Canary-only: no independent PC could check it, and a canary after it passed.
      covered: sql<boolean>`exists (select 1 from canary_cover cc where cc.fragment_id = ${OUTER_FRAGMENT} and cc.status = 'passed')`,
      picked: sql<boolean>`exists (select 1 from fragment f join fragment p on p.job_id = f.job_id and p.seq = f.seq and p.kind = 'primary' and p.verify where f.id = ${OUTER_FRAGMENT})`,
      standing: sql<boolean>`exists (select 1 from node n where n.id = ${OUTER_NODE} and n.status not in ('quarantined', 'revoked'))`,
      old: sql<boolean>`${g.createdAt} <= ${settled}::timestamptz`,
      expired: sql<boolean>`${g.expiresAt} <= ${at}::timestamptz`,
    })
    .from(g)
    .where(
      and(
        eq(g.userId, userId),
        eq(g.entryType, "earned"),
        where?.nodeId ? eq(g.nodeId, where.nodeId) : undefined,
        where?.jobId ? eq(g.jobId, where.jobId) : undefined,
      ),
    )
    .orderBy(asc(g.expiresAt), asc(g.id));
  return rows.map((r) => {
    const verified = Boolean(r.matched) || Boolean(r.covered) || (!r.picked && Boolean(r.old) && Boolean(r.standing));
    const state: GrantState = r.clawed ? "clawed_back" : r.expired ? "expired" : verified ? "available" : "pending";
    return {
      id: r.id,
      nodeId: r.nodeId,
      jobId: r.jobId,
      fragmentId: r.fragmentId,
      earnedAt: r.earnedAt,
      expiresAt: r.expiresAt!,
      amount: Number(r.amount),
      remaining: Number(r.amount) + Number(r.adjust),
      state,
    };
  });
}

export interface CreditWallet {
  /** Spendable now: verified, not expired, minus any debt from clawed-back credits already spent. */
  availableSec: number;
  /** Earned, waiting to be verified. */
  pendingSec: number;
  /** Part of available that expires within 30 days. */
  expiringSoonSec: number;
  earnedSec: number;
  spentSec: number;
  clawedBackSec: number;
  expiredSec: number;
  /** SUM of every row: available + pending (+ expired not yet booked). */
  balanceSec: number;
}

export async function creditWallet(q: Q, userId: string, now: Date): Promise<CreditWallet> {
  const gs = await grants(q, userId, now);
  const byType = await q
    .select({ type: creditLedger.entryType, total: sql<string>`coalesce(sum(${creditLedger.amountGpuSeconds}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .groupBy(creditLedger.entryType);
  const t = Object.fromEntries(byType.map((r) => [r.type, Number(r.total)])) as Record<string, number>;
  const soon = now.getTime() + EXPIRING_SOON_SEC * 1000;
  let available = 0;
  let pending = 0;
  let expiringSoon = 0;
  for (const g of gs) {
    if (g.state === "available") {
      available += g.remaining;
      if (g.expiresAt.getTime() <= soon) expiringSoon += g.remaining;
    } else if (g.state === "pending") pending += g.remaining;
    else if (g.state === "clawed_back" && g.remaining < 0) available += g.remaining;
  }
  return {
    availableSec: available,
    pendingSec: pending,
    expiringSoonSec: Math.max(0, Math.min(expiringSoon, available)),
    earnedSec: t.earned ?? 0,
    spentSec: -((t.spent ?? 0) + (t.refund ?? 0)),
    clawedBackSec: -(t.clawback ?? 0),
    expiredSec: -(t.expired ?? 0),
    balanceSec: Object.values(t).reduce((s, x) => s + x, 0),
  };
}

/** Books the credits one piece earned (pending until verified). Once per piece. */
export async function earnCredits(
  q: Q,
  row: { userId: string; nodeId: string; jobId: string; fragmentId: string; gpuSeconds: number; now: Date; memo: string },
): Promise<number> {
  const amount = earnedStandardSeconds(Math.max(0, Math.round(row.gpuSeconds)), 0);
  if (amount <= 0) return 0;
  const res = await q
    .insert(creditLedger)
    .values({
      userId: row.userId,
      nodeId: row.nodeId,
      jobId: row.jobId,
      fragmentId: row.fragmentId,
      entryType: "earned",
      amountGpuSeconds: amount,
      expiresAt: addMonths(row.now, CREDIT_TTL_MONTHS),
      idempotencyKey: creditKeys.earn(row.fragmentId),
      memo: row.memo.slice(0, 256),
      createdAt: row.now,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey })
    .returning({ id: creditLedger.id });
  return res.length ? amount : 0;
}

/** Takes back the whole grant a piece earned. Once. Returns the seconds taken back. */
export async function clawBack(q: Q, fragmentId: string, reason: string, now: Date, ipSecret: string): Promise<number> {
  const [grant] = await q
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.fragmentId, fragmentId), eq(creditLedger.entryType, "earned")))
    .limit(1);
  if (!grant) return 0;
  const res = await q
    .insert(creditLedger)
    .values({
      userId: grant.userId,
      nodeId: grant.nodeId,
      jobId: grant.jobId,
      grantId: grant.id,
      entryType: "clawback",
      amountGpuSeconds: -Number(grant.amountGpuSeconds),
      idempotencyKey: creditKeys.clawback(fragmentId),
      memo: `Clawed back: ${reason}`.slice(0, 256),
      createdAt: now,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey })
    .returning({ id: creditLedger.id });
  if (!res.length) return 0;
  await audit(
    q as Db,
    { actorId: null, actorType: "system", action: "credits.clawed_back", targetType: "user", targetId: grant.userId, meta: { fragmentId, seconds: Number(grant.amountGpuSeconds), reason } },
    ipSecret,
  );
  return Number(grant.amountGpuSeconds);
}

/** Claws back every grant a PC earned that isn't verified yet (it was quarantined). */
export async function clawBackPending(q: Q, node: { id: string; ownerId: string }, reason: string, now: Date, ipSecret: string): Promise<number> {
  let total = 0;
  for (const g of await grants(q, node.ownerId, now, { nodeId: node.id })) {
    if (g.state === "pending" && g.fragmentId) total += await clawBack(q, g.fragmentId, reason, now, ipSecret);
  }
  return total;
}

/** Claws back grants on a job's pieces that are still unverified when its data is deleted. */
export async function clawBackUnverifiedJob(q: Q, jobId: string, now: Date, ipSecret: string): Promise<number> {
  const owners = await q
    .selectDistinct({ userId: creditLedger.userId })
    .from(creditLedger)
    .where(and(eq(creditLedger.jobId, jobId), eq(creditLedger.entryType, "earned")));
  let total = 0;
  for (const { userId } of owners) {
    for (const g of await grants(q, userId, now, { jobId })) {
      if (g.state === "pending" && g.fragmentId) total += await clawBack(q, g.fragmentId, "its check couldn't run before the job's data was deleted", now, ipSecret);
    }
  }
  return total;
}

/**
 * Spends `cost` seconds of a user's verified credits on a job, oldest-expiring
 * first. Call inside a transaction: the user row is locked, so two spends
 * can't use the same credits.
 */
export async function spendCredits(tx: Q, userId: string, cost: number, jobId: string, now: Date): Promise<void> {
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error("credit cost must be a positive whole number");
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
  const gs = await grants(tx, userId, now);
  const debt = gs.filter((g) => g.state === "clawed_back" && g.remaining < 0).reduce((s, g) => s + g.remaining, 0);
  const usable = gs.filter((g) => g.state === "available" && g.remaining > 0);
  const available = usable.reduce((s, g) => s + g.remaining, 0) + debt;
  if (available < cost) {
    throw new CoordinatorError(409, "not_enough_credits", "You don't have enough verified Time-Bank credits for this job.");
  }
  let left = cost;
  for (const g of usable) {
    if (left <= 0) break;
    const take = Math.min(left, g.remaining);
    await tx.insert(creditLedger).values({
      userId,
      jobId,
      grantId: g.id,
      entryType: "spent",
      amountGpuSeconds: -take,
      idempotencyKey: creditKeys.spend(jobId, g.id),
      memo: "Spent on a job",
      createdAt: now,
    });
    left -= take;
  }
}

/** Puts back the credits a job used (it missed its deadline or failed). Once per spend. */
export async function refundCredits(q: Q, jobId: string, now: Date): Promise<number> {
  const spent = await q
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.jobId, jobId), eq(creditLedger.entryType, "spent")));
  let total = 0;
  for (const s of spent) {
    const res = await q
      .insert(creditLedger)
      .values({
        userId: s.userId,
        jobId,
        grantId: s.grantId,
        entryType: "refund",
        amountGpuSeconds: -Number(s.amountGpuSeconds),
        idempotencyKey: creditKeys.refund(s.id),
        memo: "Refunded: the job didn't finish on time",
        createdAt: now,
      })
      .onConflictDoNothing({ target: creditLedger.idempotencyKey })
      .returning({ id: creditLedger.id });
    if (res.length) total += -Number(s.amountGpuSeconds);
  }
  return total;
}

/** Books what's left of every grant past its expiry. Run by the tick. */
export async function expireCredits(q: Q, now: Date): Promise<number> {
  const due = await q
    .select({
      id: creditLedger.id,
      userId: creditLedger.userId,
      nodeId: creditLedger.nodeId,
      remaining: sql<string>`${creditLedger.amountGpuSeconds} + coalesce((select sum(c.amount_gpu_seconds) from credit_ledger c where c.grant_id = ${OUTER_ID}), 0)`,
      booked: sql<string>`(select count(*) from credit_ledger c where c.grant_id = ${OUTER_ID} and c.entry_type = 'expired')`,
    })
    .from(creditLedger)
    .where(and(eq(creditLedger.entryType, "earned"), sql`${creditLedger.expiresAt} <= ${now.toISOString()}::timestamptz`));
  let total = 0;
  for (const g of due) {
    const left = Number(g.remaining);
    if (left <= 0) continue;
    const res = await q
      .insert(creditLedger)
      .values({
        userId: g.userId,
        nodeId: g.nodeId,
        grantId: g.id,
        entryType: "expired",
        amountGpuSeconds: -left,
        idempotencyKey: creditKeys.expire(g.id, Number(g.booked)),
        memo: "Expired (credits last 6 months)",
        createdAt: now,
      })
      .onConflictDoNothing({ target: creditLedger.idempotencyKey })
      .returning({ id: creditLedger.id });
    if (res.length) total += left;
  }
  return total;
}

/** The user's credit rows, newest first, for the wallet's history. */
export async function creditHistory(q: Q, userId: string, limit = 100) {
  return q
    .select({
      id: creditLedger.id,
      at: creditLedger.createdAt,
      type: creditLedger.entryType,
      seconds: creditLedger.amountGpuSeconds,
      memo: creditLedger.memo,
      jobId: creditLedger.jobId,
      expiresAt: creditLedger.expiresAt,
    })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(sql`${creditLedger.createdAt} desc`, sql`${creditLedger.id} desc`)
    .limit(limit);
}
