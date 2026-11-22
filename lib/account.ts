import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { CoordinatorError } from "@/lib/coordinator/errors";
import { requeueLeased } from "@/lib/coordinator/lifecycle";
import { deleteJobBlobs } from "@/lib/coordinator/store";
import type { Db } from "@/lib/db/client";
import {
  accounts,
  auditLog,
  buyerLedger,
  creditLedger,
  fragments,
  jobs,
  nodes,
  nodeTokens,
  ownerLedger,
  sessions,
  users,
  verificationTokens,
} from "@/lib/db/schema";

/**
 * "Download your data" and "Delete your account" (DPDP Act: access and
 * erasure).
 *
 * Deleting keeps the ledgers, because money records must stay complete and
 * the ledger tables are append-only. They are keyed by a random account id,
 * and the email that linked that id to a person is removed, along with every
 * login, every PC token and all stored job data.
 */

export const EXPORT_VERSION = 1;

/** Idempotency keys are internal plumbing, not data about you. */
function withoutKey<T extends { idempotencyKey: string }>(row: T): Omit<T, "idempotencyKey"> {
  const copy: Partial<T> = { ...row };
  delete copy.idempotencyKey;
  return copy as Omit<T, "idempotencyKey">;
}

/** Everything we hold about the account, as plain JSON. */
export async function exportAccount(db: Db, userId: string, now: Date) {
  const [me] = await db
    .select({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!me) throw new CoordinatorError(404, "not_found", "Not found.");
  const [myNodes, myJobs, owner, buyer, credit, events, logins] = await Promise.all([
    db
      .select({
        id: nodes.id,
        name: nodes.name,
        gpuClass: nodes.gpuClass,
        gpuModel: nodes.gpuModel,
        status: nodes.status,
        benchmarkScore: nodes.benchmarkScore,
        measuredWatts: nodes.measuredWatts,
        wattsEstimated: nodes.wattsEstimated,
        tariffPaisePerKwh: nodes.tariffPaisePerKwh,
        ownerRatePaisePerHr: nodes.ownerRatePaisePerHr,
        nightWindowStartMin: nodes.nightWindowStartMin,
        nightWindowEndMin: nodes.nightWindowEndMin,
        timezone: nodes.timezone,
        createdAt: nodes.createdAt,
      })
      .from(nodes)
      .where(eq(nodes.ownerId, userId)),
    db
      .select({
        id: jobs.id,
        workloadType: jobs.workloadType,
        gpuClass: jobs.gpuClass,
        params: jobs.params,
        itemCount: jobs.itemCount,
        status: jobs.status,
        pricePaise: jobs.pricePaise,
        breakdown: jobs.breakdown,
        deadlineAt: jobs.deadlineAt,
        confirmedAt: jobs.confirmedAt,
        completedAt: jobs.completedAt,
        refundedAt: jobs.refundedAt,
        purgedAt: jobs.purgedAt,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(eq(jobs.buyerId, userId)),
    db.select().from(ownerLedger).where(eq(ownerLedger.ownerId, userId)),
    db.select().from(buyerLedger).where(eq(buyerLedger.buyerId, userId)),
    db.select().from(creditLedger).where(eq(creditLedger.userId, userId)),
    // Your own actions. The IP hash is left out: it's only useful with our secret.
    db
      .select({ at: auditLog.at, action: auditLog.action, targetType: auditLog.targetType, targetId: auditLog.targetId, meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.actorId, userId))
      .orderBy(desc(auditLog.id)),
    db.select({ provider: accounts.provider }).from(accounts).where(eq(accounts.userId, userId)),
  ]);
  return {
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    note: "Everything NightShift stores about your account. Job inputs and results are not included: download results from each job (they are deleted 7 days after the deadline).",
    account: { ...me, loginMethods: logins.map((l) => l.provider) },
    pcs: myNodes,
    jobs: myJobs,
    ledgers: {
      ownerEarnings: owner.map(withoutKey),
      buyerPayments: buyer.map(withoutKey),
      timeBankCredits: credit.map(withoutKey),
    },
    activity: events,
  };
}

export type AccountExport = Awaited<ReturnType<typeof exportAccount>>;

export async function deleteAccount(
  db: Db,
  userId: string,
  ctx: { now: Date; ip?: string; ipSecret: string },
): Promise<{ jobsPurged: number; pcsRemoved: number }> {
  const result = await db.transaction(async (tx) => {
    const [me] = await tx.select({ email: users.email, deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId)).limit(1);
    if (!me || me.deletedAt) throw new CoordinatorError(404, "not_found", "Not found.");

    const running = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.buyerId, userId), inArray(jobs.status, ["queued", "running"])))
      .limit(1);
    if (running.length) {
      throw new CoordinatorError(409, "jobs_running", "You have a job still running. Wait for it to finish (or miss its deadline and be refunded), then delete your account.");
    }

    // Open quotes are cancelled; every job's stored data goes now, not in 7 days.
    await tx.update(jobs).set({ status: "cancelled" }).where(and(eq(jobs.buyerId, userId), eq(jobs.status, "quoted")));
    const mine = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.buyerId, userId), isNull(jobs.purgedAt)));
    for (const j of mine) await deleteJobBlobs(tx, j.id);
    if (mine.length) {
      const ids = mine.map((j) => j.id);
      await tx.update(jobs).set({ purgedAt: ctx.now }).where(inArray(jobs.id, ids));
      await tx.update(fragments).set({ status: "cancelled" }).where(and(inArray(fragments.jobId, ids), eq(fragments.status, "pending")));
    }

    // PCs: every token revoked, held work back in the queue for other PCs.
    const pcs = await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.ownerId, userId));
    if (pcs.length) {
      const ids = pcs.map((n) => n.id);
      await tx.update(nodeTokens).set({ revokedAt: ctx.now }).where(and(inArray(nodeTokens.nodeId, ids), isNull(nodeTokens.revokedAt)));
      await tx.update(nodes).set({ status: "revoked", paused: true }).where(and(inArray(nodes.id, ids), ne(nodes.status, "quarantined")));
      await requeueLeased(tx, inArray(fragments.leaseNodeId, ids), ctx.now, ctx.ipSecret);
    }

    // Logins, then the email itself.
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(accounts).where(eq(accounts.userId, userId));
    if (me.email) await tx.delete(verificationTokens).where(eq(verificationTokens.identifier, me.email));
    await tx.update(users).set({ email: null, name: null, image: null, emailVerified: null, deletedAt: ctx.now }).where(eq(users.id, userId));
    return { jobsPurged: mine.length, pcsRemoved: pcs.length };
  });
  await audit(db, { actorId: userId, actorType: "user", action: "account.deleted", targetType: "user", targetId: userId, ip: ctx.ip, meta: result }, ctx.ipSecret);
  return result;
}
