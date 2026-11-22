import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { fragments, jobs, locks, nodes } from "@/lib/db/schema";
import { markMissedDeadlines, requeueLeased } from "./lifecycle";
import { HEARTBEAT_TIMEOUT_SEC, needsBackup } from "./schedule";
import { deleteJobBlobs } from "./store";

/**
 * The scheduler tick. Idempotent: running it twice in a row changes nothing
 * the second time. It runs from three places:
 *
 * - Vercel Cron (`/api/cron/tick`, CRON_SECRET). On the Hobby plan cron runs at
 *   most once a day, so this is only the backstop.
 * - Every agent lease request, at most once per TICK_EVERY_SEC across all
 *   server instances (a row in `lock` with an expiry is the throttle). While
 *   any agent is polling, the scheduler is effectively running.
 * - Tests, directly, with a fake clock.
 */

export const TICK_EVERY_SEC = 15;

export interface TickReport {
  ran: boolean;
  leasesExpired: number;
  nodesOffline: number;
  backupsStarted: number;
  deadlinesMissed: number;
  quotesExpired: number;
  jobsPurged: number;
}

const EMPTY: TickReport = { ran: false, leasesExpired: 0, nodesOffline: 0, backupsStarted: 0, deadlinesMissed: 0, quotesExpired: 0, jobsPurged: 0 };

/**
 * Takes the named lock if it's free or expired. One statement, so two
 * instances can't both get it.
 */
export async function tryLock(db: Db, name: string, now: Date, holdSec: number): Promise<boolean> {
  const until = new Date(now.getTime() + holdSec * 1000);
  const got = await db
    .insert(locks)
    .values({ name, lockedUntil: until })
    .onConflictDoUpdate({ target: locks.name, set: { lockedUntil: until }, setWhere: lt(locks.lockedUntil, now) })
    .returning({ name: locks.name });
  return got.length === 1;
}

/** Runs the tick unless one ran in the last TICK_EVERY_SEC. */
export async function maybeTick(db: Db, now: Date, ipSecret: string): Promise<TickReport> {
  if (!(await tryLock(db, "tick", now, TICK_EVERY_SEC))) return EMPTY;
  return runTick(db, now, ipSecret);
}

export async function runTick(db: Db, now: Date, ipSecret: string): Promise<TickReport> {
  const report: TickReport = { ...EMPTY, ran: true };

  // 1. Leases that ran out: back in the queue, or failed if out of attempts.
  report.leasesExpired = await requeueLeased(db, lt(fragments.leaseExpiresAt, now), now, ipSecret);

  // 2. Nodes that stopped sending heartbeats.
  const offline = await db
    .update(nodes)
    .set({ status: "offline" })
    .where(and(eq(nodes.status, "online"), lt(nodes.lastSeenAt, new Date(now.getTime() - HEARTBEAT_TIMEOUT_SEC * 1000))))
    .returning({ id: nodes.id });
  report.nodesOffline = offline.length;
  // Their leased work can go to someone else now rather than at lease expiry.
  if (offline.length > 0) {
    report.leasesExpired += await requeueLeased(db, inArray(fragments.leaseNodeId, offline.map((n) => n.id)), now, ipSecret);
  }

  // 3. Backup copies of slow pieces near the deadline.
  report.backupsStarted = await startBackups(db, now);

  // 4. Deadlines: unfinished jobs past theirs are refunded in full.
  report.deadlinesMissed = await markMissedDeadlines(db, now, ipSecret);

  // 5. Quotes nobody confirmed: cancel and delete their data.
  const expired = await db
    .update(jobs)
    .set({ status: "cancelled", purgedAt: now })
    .where(and(eq(jobs.status, "quoted"), lt(jobs.quoteExpiresAt, now)))
    .returning({ id: jobs.id });
  for (const j of expired) {
    await db.update(fragments).set({ status: "cancelled" }).where(eq(fragments.jobId, j.id));
    await deleteJobBlobs(db, j.id);
  }
  report.quotesExpired = expired.length;

  // 6. Retention: delete inputs and outputs 7 days after a job ends.
  const due = await db
    .update(jobs)
    .set({ purgedAt: now })
    .where(and(isNull(jobs.purgedAt), lt(jobs.purgeAfter, now)))
    .returning({ id: jobs.id });
  for (const j of due) {
    await db
      .update(fragments)
      .set({ status: "cancelled", leaseExpiresAt: null })
      .where(and(eq(fragments.jobId, j.id), inArray(fragments.status, ["pending", "leased"])));
    await deleteJobBlobs(db, j.id);
  }
  report.jobsPurged = due.length;

  return report;
}

async function startBackups(db: Db, now: Date): Promise<number> {
  const running = await db
    .select({ f: fragments, j: jobs })
    .from(fragments)
    .innerJoin(jobs, eq(jobs.id, fragments.jobId))
    .where(and(eq(fragments.status, "leased"), eq(fragments.kind, "primary"), inArray(jobs.status, ["queued", "running"])));
  let started = 0;
  for (const { f, j } of running) {
    if (!f.startedAt || !f.leaseExpectedSec || !j.confirmedAt) continue;
    if (!needsBackup({ now, deadline: j.deadlineAt, confirmedAt: j.confirmedAt, startedAt: f.startedAt, expectedSec: f.leaseExpectedSec })) continue;
    const existing = await db
      .select({ id: fragments.id })
      .from(fragments)
      .where(
        and(
          eq(fragments.jobId, f.jobId),
          eq(fragments.seq, f.seq),
          eq(fragments.kind, "backup"),
          inArray(fragments.status, ["pending", "leased", "done"]),
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(fragments).values({
      jobId: f.jobId,
      seq: f.seq,
      kind: "backup",
      parentFragmentId: f.id,
      status: "pending",
      estGpuSeconds: f.estGpuSeconds,
      itemCount: f.itemCount,
      inputKey: f.inputKey,
      inputSha256: f.inputSha256,
      wrappedKey: f.wrappedKey,
    });
    started += 1;
  }
  return started;
}
