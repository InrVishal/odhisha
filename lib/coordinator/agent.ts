import { aliasedTable, and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { fragments, jobs, nodes, nodeTokens } from "@/lib/db/schema";
import { bookOwner, ledgerKeys } from "@/lib/ledger";
import { safeEqual } from "@/lib/security/tokens";
import { hashToken, isWellFormedNodeToken } from "@/lib/security/tokens";
import { newNonce, sha256Hex, signTask, TASK_VERSION, type SignedTask } from "@/lib/security/signing";
import type { CoordinatorKeys } from "@/lib/security/keys";
import { MAX_BENCHMARK_SCORE } from "@/lib/timebank";
import { CoordinatorError } from "./errors";
import { cancelSiblings, completeJobIfDone, failJobIfPieceDead, type Q } from "./lifecycle";
import { queueCheckIfPicked, resolveCheck, applyCheck } from "./verification";
import { wantsChallenge } from "./challenge";
import { createChallenge, lastChallengeAt, settleChallenge, type StoredChallenge } from "./challenge-db";
import { clampWatts } from "./classes";
import { toNodeView, type NodeRow } from "./nodes";
import {
  fragmentPay,
  leaseSeconds,
  nextMeasuredWatts,
  nodeBenchmark,
  unavailableReason,
  wattTariff,
  windowEndsAt,
  type Unavailable,
} from "./schedule";
import { fragmentDataKey, getBlob, putBlob } from "./store";
import { estimateSeconds, parseOutput, WORKLOADS } from "./workloads";

/**
 * The agent API. Agents authenticate with their node token (Bearer), only
 * ever pull work (no inbound connections to owners' PCs), and receive every
 * task signed with the coordinator's Ed25519 key.
 */

export interface AuthedNode {
  node: NodeRow;
  tokenId: string;
}

/** Looks up a node by token. Revoked tokens and revoked nodes get nothing. */
export async function authenticateAgent(db: Db, authorization: string | null, now: Date): Promise<AuthedNode | null> {
  const m = /^Bearer (\S+)$/.exec(authorization ?? "");
  if (!m || !isWellFormedNodeToken(m[1]!)) return null;
  const hash = hashToken(m[1]!);
  const [row] = await db
    .select({ node: nodes, tokenId: nodeTokens.id, tokenHash: nodeTokens.tokenHash })
    .from(nodeTokens)
    .innerJoin(nodes, eq(nodes.id, nodeTokens.nodeId))
    .where(and(eq(nodeTokens.tokenHash, hash), isNull(nodeTokens.revokedAt)))
    .limit(1);
  // The lookup is by hash, so this compare is belt and braces, not timing-critical.
  if (!row || !safeEqual(row.tokenHash, hash) || row.node.status === "revoked") return null;
  await db.update(nodeTokens).set({ lastUsedAt: now }).where(eq(nodeTokens.id, row.tokenId));
  return { node: row.node, tokenId: row.tokenId };
}

export const heartbeatInput = z.strictObject({
  /** Whole-PC draw from nvidia-smi (or a CPU estimate), in watts. */
  watts: z.int().min(1).max(5000).optional(),
  /** "nvidia-smi" (measured) or "estimated" (CPU mode, declared by the owner). */
  wattsSource: z.enum(["nvidia-smi", "estimated"]).optional(),
  gpuModel: z.string().trim().min(1).max(128).optional(),
  vramMb: z.int().min(0).max(1_048_576).optional(),
  /** What the agent measured itself. Stored for display only: scheduling uses the coordinator's own challenge timings. */
  benchmarkScore: z.int().min(1).max(MAX_BENCHMARK_SCORE).optional(),
  agentVersion: z.string().max(32).optional(),
});

export interface HeartbeatReply {
  /** The node this token belongs to. The agent pins it and refuses tasks for any other. */
  nodeId: string;
  status: NodeRow["status"];
  paused: boolean;
  canWork: boolean;
  reason: Unavailable | null;
  /** How long the agent should wait before its next request. */
  pollAfterSec: number;
}

/** Folds a power report into the node's rolling average, capped at the class ceiling. */
async function powerPatch(db: Db, node: NodeRow, watts: number, source: "nvidia-smi" | "estimated" | undefined, ipSecret?: string) {
  const { watts: capped, clamped } = clampWatts(node.gpuClass, watts);
  if (clamped && ipSecret) {
    await audit(db, { actorId: null, actorType: "node", action: "node.watts_clamped", targetType: "node", targetId: node.id, meta: { reported: watts, used: capped } }, ipSecret);
  }
  return { measuredWatts: nextMeasuredWatts(node.measuredWatts, capped), wattsEstimated: source === "estimated" };
}

export async function heartbeat(db: Db, node: NodeRow, input: z.infer<typeof heartbeatInput>, now: Date, ipSecret?: string): Promise<HeartbeatReply> {
  let patch: Partial<typeof nodes.$inferInsert> = { lastSeenAt: now };
  if (node.status === "pending" || node.status === "offline") patch.status = "online";
  if (input.watts) patch = { ...patch, ...(await powerPatch(db, node, input.watts, input.wattsSource, ipSecret)) };
  if (input.gpuModel) patch.gpuModel = input.gpuModel;
  if (input.vramMb !== undefined) patch.vramMb = input.vramMb;
  if (input.benchmarkScore) patch.reportedBenchmark = input.benchmarkScore;
  const [updated] = await db.update(nodes).set(patch).where(eq(nodes.id, node.id)).returning();
  const reason = unavailableReason(toNodeView(updated!), now);
  return {
    nodeId: updated!.id,
    status: updated!.status,
    paused: updated!.paused,
    canWork: reason === null,
    reason,
    pollAfterSec: reason === null ? 5 : 30,
  };
}

export interface LeaseReply {
  task: SignedTask;
  /** The fragment's input, base64. sha256 of the decoded bytes is in the task. */
  input: string;
  leaseExpiresAt: string;
}

/**
 * Hands this node the most urgent fragment it may run, or null.
 *
 * Eligible: pending, its job is confirmed and not finished, same node class,
 * the node costs no more than the quote assumed, attempts left, the node has
 * no other copy of the same piece, and it can finish before its night window
 * closes. Backups first, then earliest deadline, then piece order.
 *
 * Taking the fragment is one conditional UPDATE (`WHERE status = 'pending'`):
 * if two nodes race for it, exactly one wins and the other tries the next.
 */
/** Before this, a check isn't given to a PC of the same owner as the PC it checks. */
export const SAME_OWNER_CHECK_AFTER_SEC = 30 * 60;

export interface LeaseOptions {
  /** Issue coordinator challenges (canary + timing). On in production; tests switch it on when they test it. */
  challenges?: boolean;
  rand?: (max: number) => number;
}

export async function leaseFragment(
  db: Db,
  node: NodeRow,
  now: Date,
  keys: Pick<CoordinatorKeys, "signingKey" | "publicKey" | "dataKey">,
  opts: LeaseOptions = {},
): Promise<{ lease: LeaseReply | null; reason: Unavailable | "no_work" | "busy" | null }> {
  const [fresh] = await db
    .update(nodes)
    .set({ lastSeenAt: now, ...(node.status === "pending" || node.status === "offline" ? { status: "online" as const } : {}) })
    .where(eq(nodes.id, node.id))
    .returning();
  const view = toNodeView(fresh!);
  const reason = unavailableReason(view, now);
  if (reason) return { lease: null, reason };

  // One piece at a time. A PC can't sit on a pile of leases (hoarding):
  // the agent runs one container at a time anyway.
  const holding = await db
    .select({ id: fragments.id })
    .from(fragments)
    .where(and(eq(fragments.leaseNodeId, node.id), eq(fragments.status, "leased"), gt(fragments.leaseExpiresAt, now)))
    .limit(1);
  if (holding.length) return { lease: null, reason: "busy" };

  if (opts.challenges && wantsChallenge({ measured: fresh!.benchmarkScore !== null, lastChallengeAt: await lastChallengeAt(db, node.id), now, rand: opts.rand })) {
    const { fragment, job } = await createChallenge(db, fresh!, now, keys.dataKey, opts.rand);
    return { lease: await signLease(db, node, fragment, job, keys, now), reason: null };
  }

  const sibling = aliasedTable(fragments, "sibling");
  const candidates = await db
    .select({ f: fragments, j: jobs })
    .from(fragments)
    .innerJoin(jobs, eq(jobs.id, fragments.jobId))
    .where(
      and(
        eq(fragments.status, "pending"),
        // Challenges are made for one PC and leased on creation, never from the pool.
        isNull(jobs.challenge),
        lt(fragments.attempts, fragments.maxAttempts),
        or(
          and(inArray(fragments.kind, ["primary", "backup"]), inArray(jobs.status, ["queued", "running", "deadline_missed"])),
          // Checks also run after the job has finished (until its data is purged).
          and(eq(fragments.kind, "verification"), inArray(jobs.status, ["queued", "running", "completed", "deadline_missed"])),
        ),
        isNull(jobs.purgedAt),
        eq(jobs.gpuClass, fresh!.gpuClass),
        gte(jobs.maxWattTariff, wattTariff(view)),
        gte(jobs.maxOwnerRate, fresh!.ownerRatePaisePerHr),
        notExists(
          db
            .select({ one: sql`1` })
            .from(sibling)
            .where(
              and(
                eq(sibling.jobId, fragments.jobId),
                eq(sibling.seq, fragments.seq),
                ne(sibling.id, fragments.id),
                or(eq(sibling.leaseNodeId, node.id), eq(sibling.completedByNodeId, node.id)),
              ),
            ),
        ),
      ),
    )
    // Backups first (a deadline is at risk), checks last (they never hold up a job).
    .orderBy(desc(sql`${fragments.kind} = 'backup'`), asc(sql`${fragments.kind} = 'verification'`), asc(jobs.deadlineAt), asc(fragments.seq))
    .limit(10);

  const closes = windowEndsAt(now, view.window);
  for (const { f, j } of candidates) {
    // Prefer a different owner for checks (two PCs of one person could agree
    // on a wrong answer). Small setups with one owner still get checked, later.
    if (f.kind === "verification" && f.parentFragmentId) {
      const [checked] = await db
        .select({ ownerId: nodes.ownerId, doneAt: fragments.completedAt })
        .from(fragments)
        .innerJoin(nodes, eq(nodes.id, fragments.completedByNodeId))
        .where(eq(fragments.id, f.parentFragmentId))
        .limit(1);
      if (checked?.ownerId === fresh!.ownerId && checked.doneAt && now.getTime() - checked.doneAt.getTime() < SAME_OWNER_CHECK_AFTER_SEC * 1000) continue;
    }
    const spec = WORKLOADS[j.workloadType];
    const expected = estimateSeconds(spec, f.itemCount, nodeBenchmark(view));
    if (closes && now.getTime() + expected * 1000 > closes.getTime()) continue;
    const leaseUntil = new Date(now.getTime() + leaseSeconds(expected) * 1000);
    const [taken] = await db
      .update(fragments)
      .set({
        status: "leased",
        leaseNodeId: node.id,
        leaseExpiresAt: leaseUntil,
        leaseExpectedSec: expected,
        startedAt: now,
        attempts: sql`${fragments.attempts} + 1`,
      })
      .where(and(eq(fragments.id, f.id), eq(fragments.status, "pending"), lt(fragments.attempts, fragments.maxAttempts)))
      .returning();
    if (!taken) continue;
    await db.update(jobs).set({ status: "running" }).where(and(eq(jobs.id, j.id), eq(jobs.status, "queued")));
    return { lease: await signLease(db, node, taken, j, keys, now), reason: null };
  }
  return { lease: null, reason: "no_work" };
}

/** Signs a leased fragment into a task for this node, with its input. */
async function signLease(
  db: Db,
  node: Pick<NodeRow, "id">,
  taken: typeof fragments.$inferSelect,
  j: typeof jobs.$inferSelect,
  keys: Pick<CoordinatorKeys, "signingKey" | "publicKey" | "dataKey">,
  now: Date,
): Promise<LeaseReply> {
  const spec = WORKLOADS[j.workloadType];
  const leaseUntil = taken.leaseExpiresAt!;
  {
    const input = await getBlob(db, { dataKey: fragmentDataKey(keys.dataKey, taken), jobId: j.id, key: taken.inputKey });
    if (!input || sha256Hex(input) !== taken.inputSha256) throw new Error("fragment input missing or corrupt");
    const task = signTask(
      {
        v: TASK_VERSION,
        taskId: taken.id,
        jobId: j.id,
        nodeId: node.id,
        attempt: taken.attempts,
        workload: j.workloadType,
        image: spec.image,
        params: j.params,
        itemCount: taken.itemCount,
        inputSha256: taken.inputSha256,
        iat: Math.floor(now.getTime() / 1000),
        exp: Math.floor(leaseUntil.getTime() / 1000),
        nonce: newNonce(),
      },
      keys.signingKey,
      keys.publicKey,
    );
    return { task, input: input.toString("base64"), leaseExpiresAt: leaseUntil.toISOString() };
  }
}

async function leasedFragment(db: Q, nodeId: string, fragmentId: string, attempt: number, now: Date) {
  if (!z.uuid().safeParse(fragmentId).success) return null;
  const [row] = await db
    .select({ f: fragments, j: jobs })
    .from(fragments)
    .innerJoin(jobs, eq(jobs.id, fragments.jobId))
    .where(and(eq(fragments.id, fragmentId), eq(fragments.leaseNodeId, nodeId), eq(fragments.attempts, attempt)))
    .limit(1);
  if (!row || !row.f.leaseExpiresAt || row.f.leaseExpiresAt <= now) return null;
  if (row.f.status !== "leased" && row.f.status !== "cancelled") return null;
  return row;
}

/** A power reading sent with a fragment result (X-Power-Watts / X-Power-Source). */
export interface PowerReport {
  watts: number;
  source: "nvidia-smi" | "estimated";
}

export function parsePowerHeaders(headers: Headers): PowerReport | null {
  const watts = Number(headers.get("x-power-watts"));
  const source = headers.get("x-power-source");
  if (!Number.isInteger(watts) || watts < 1 || watts > 5000) return null;
  if (source !== "nvidia-smi" && source !== "estimated") return null;
  return { watts, source };
}

export interface CompleteReply {
  /** False if another copy finished the piece first. The owner is still paid. */
  accepted: boolean;
  paidPaise: number;
}

/**
 * Stores a fragment's output and pays the owner. The caller has already
 * checked the size. Rejects outputs that don't match the declared sha256 or
 * the workload's output schema.
 */
export async function completeFragment(
  db: Db,
  node: NodeRow,
  args: { fragmentId: string; attempt: number; sha256: string; body: Uint8Array; now: Date; dataKey: Buffer; ipSecret: string; power?: PowerReport | null },
): Promise<CompleteReply> {
  if (!/^[0-9a-f]{64}$/.test(args.sha256) || sha256Hex(args.body) !== args.sha256) {
    throw new CoordinatorError(400, "digest_mismatch", "Output doesn't match its sha256.");
  }
  const found = await leasedFragment(db, node.id, args.fragmentId, args.attempt, args.now);
  if (!found) throw new CoordinatorError(409, "lease_lost", "This lease is no longer yours. Drop the result.");
  const { f, j } = found;

  if (!parseOutput(WORKLOADS[j.workloadType], f.itemCount, j.params, args.body)) {
    await failFragment(db, node, { fragmentId: f.id, attempt: args.attempt, now: args.now, ipSecret: args.ipSecret });
    throw new CoordinatorError(422, "bad_output", "The output isn't valid for this workload.");
  }

  // The reading taken while this fragment ran updates the node's watts first,
  // so the owner is paid for the electricity this work actually drew.
  // Replay: the exact output of a DIFFERENT piece handed in again. Only for
  // workloads where two different inputs can't honestly give identical output.
  if (j.workloadType !== "image_captioning") {
    const [seen] = await db
      .select({ id: fragments.id })
      .from(fragments)
      .where(and(eq(fragments.outputDigest, args.sha256), ne(fragments.inputSha256, f.inputSha256)))
      .limit(1);
    if (seen) {
      await failFragment(db, node, { fragmentId: f.id, attempt: args.attempt, now: args.now, ipSecret: args.ipSecret });
      await applyCheck(db, node.id, "fail", args.now, args.ipSecret);
      await audit(db, { actorId: null, actorType: "system", action: "node.replay_rejected", targetType: "node", targetId: node.id, meta: { fragmentId: f.id } }, args.ipSecret);
      throw new CoordinatorError(422, "replayed_output", "This output belongs to a different piece.");
    }
  }

  let payNode = node;
  if (args.power) {
    const [updated] = await db
      .update(nodes)
      .set(await powerPatch(db, node, args.power.watts, args.power.source, args.ipSecret))
      .where(eq(nodes.id, node.id))
      .returning();
    if (updated) payNode = updated;
  }
  const view = toNodeView(payNode);
  const pay = fragmentPay(view, f.estGpuSeconds);

  if (j.challenge) {
    // A coordinator challenge: never billed; paid only if it passes.
    return db.transaction(async (tx) => {
      const [done] = await tx
        .update(fragments)
        .set({ status: "done", outputDigest: args.sha256, completedAt: args.now, completedByNodeId: node.id, leaseExpiresAt: null })
        .where(and(eq(fragments.id, f.id), eq(fragments.status, "leased"), eq(fragments.attempts, args.attempt), eq(fragments.leaseNodeId, node.id)))
        .returning({ id: fragments.id });
      if (!done) throw new CoordinatorError(409, "lease_lost", "This lease is no longer yours. Drop the result.");
      await tx.update(jobs).set({ status: "completed", completedAt: args.now }).where(eq(jobs.id, j.id));
      const result = await settleChallenge(tx, node, { spec: j.challenge as StoredChallenge, output: args.body, startedAt: f.startedAt ?? args.now, now: args.now, ipSecret: args.ipSecret });
      if (!result.passed) return { accepted: true, paidPaise: 0 };
      const memo = "speed and accuracy check";
      await bookOwner(tx, { ownerId: node.ownerId, nodeId: node.id, jobId: j.id, fragmentId: f.id, entryType: "power_reimbursement", amountPaise: pay.electricityPaise, idempotencyKey: ledgerKeys.power(f.id), memo: `Electricity for ${memo}` });
      await bookOwner(tx, { ownerId: node.ownerId, nodeId: node.id, jobId: j.id, fragmentId: f.id, entryType: "compute_pay", amountPaise: pay.ownerPayPaise, idempotencyKey: ledgerKeys.computePay(f.id), memo: `Compute for ${memo}` });
      return { accepted: true, paidPaise: pay.electricityPaise + pay.ownerPayPaise };
    });
  }

  return db.transaction(async (tx) => {
    let accepted = false;
    if (f.status === "leased") {
      const outputKey = await putBlob(tx, { dataKey: fragmentDataKey(args.dataKey, f), jobId: j.id, plaintext: args.body });
      const [done] = await tx
        .update(fragments)
        .set({ status: "done", outputKey, outputDigest: args.sha256, completedAt: args.now, completedByNodeId: node.id, leaseExpiresAt: null })
        .where(and(eq(fragments.id, f.id), eq(fragments.status, "leased"), eq(fragments.attempts, args.attempt), eq(fragments.leaseNodeId, node.id)))
        .returning({ id: fragments.id });
      if (!done) throw new CoordinatorError(409, "lease_lost", "This lease is no longer yours. Drop the result.");
      accepted = true;
      if (f.kind === "verification") {
        await resolveCheck(tx, { ...f, status: "done", outputKey, outputDigest: args.sha256, completedAt: args.now, completedByNodeId: node.id }, {
          workload: j.workloadType,
          output: args.body,
          dataKey: args.dataKey,
          now: args.now,
          ipSecret: args.ipSecret,
        });
      } else {
        await cancelSiblings(tx, f);
        await queueCheckIfPicked(tx, { ...f, status: "done", outputKey, outputDigest: args.sha256, completedAt: args.now, completedByNodeId: node.id });
      }
    } else {
      // A cancelled copy: another node finished the piece while this one was
      // still working. We asked for this work, so the owner is paid for it.
      await tx
        .update(fragments)
        .set({ completedAt: args.now, completedByNodeId: node.id, leaseExpiresAt: null })
        .where(and(eq(fragments.id, f.id), eq(fragments.status, "cancelled"), eq(fragments.attempts, args.attempt)));
    }

    const memo = `${f.kind === "verification" ? "check of " : ""}${j.workloadType} piece ${f.seq + 1}/${j.fragmentCount}`;
    await bookOwner(tx, {
      ownerId: node.ownerId,
      nodeId: node.id,
      jobId: j.id,
      fragmentId: f.id,
      entryType: "power_reimbursement",
      amountPaise: pay.electricityPaise,
      idempotencyKey: ledgerKeys.power(f.id),
      memo: `Electricity for ${memo}`,
    });
    await bookOwner(tx, {
      ownerId: node.ownerId,
      nodeId: node.id,
      jobId: j.id,
      fragmentId: f.id,
      entryType: "compute_pay",
      amountPaise: pay.ownerPayPaise,
      idempotencyKey: ledgerKeys.computePay(f.id),
      memo: `Compute for ${memo}`,
    });
    if (accepted && f.kind !== "verification") await completeJobIfDone(tx, j.id, args.now, args.ipSecret);
    return { accepted, paidPaise: pay.electricityPaise + pay.ownerPayPaise };
  });
}

export const failInput = z.strictObject({
  attempt: z.int().min(1).max(100),
  reason: z.enum(["timeout", "crashed", "out_of_memory", "bad_input", "stopped", "other"]),
});

/** The agent gives a fragment back. It goes to another node, or fails for good. */
export async function failFragment(
  db: Q,
  node: Pick<NodeRow, "id">,
  args: { fragmentId: string; attempt: number; now: Date; ipSecret: string },
): Promise<{ requeued: boolean }> {
  if (!z.uuid().safeParse(args.fragmentId).success) throw new CoordinatorError(409, "lease_lost", "This lease is no longer yours.");
  const [row] = await db
    .update(fragments)
    .set({
      status: sql`case when ${fragments.attempts} < ${fragments.maxAttempts} then 'pending'::fragment_status else 'failed'::fragment_status end`,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(fragments.id, args.fragmentId),
        eq(fragments.leaseNodeId, node.id),
        eq(fragments.attempts, args.attempt),
        eq(fragments.status, "leased"),
      ),
    )
    .returning({ status: fragments.status, jobId: fragments.jobId, seq: fragments.seq });
  if (!row) throw new CoordinatorError(409, "lease_lost", "This lease is no longer yours.");
  if (row.status === "failed") await failJobIfPieceDead(db, row.jobId, row.seq, args.now, args.ipSecret);
  return { requeued: row.status === "pending" };
}
