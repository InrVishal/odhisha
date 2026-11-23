import { randomInt } from "node:crypto";
import { aliasedTable, and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { fragments, jobs, nodes, nodeTokens } from "@/lib/db/schema";
import { earnCredits } from "@/lib/credits";
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
import { createKnownAnswerCanary } from "./canary";
import { CANARY_ONLY_RATE, owesCanary, settleCovers } from "./canary-only";
import { deviceHash, mayCheck, pieceOrigins, recordOrigin, subnetHash, type SybilMode } from "./sybil";
import { checkRate } from "./verify";
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
import { estimateSeconds, parseOutput, standardWorkSeconds, WORKLOADS } from "./workloads";

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
/** How stale a token's "last used" time may get before it's rewritten. */
export const TOKEN_LAST_USED_EVERY_MS = 5 * 60_000;

export async function authenticateAgent(db: Db, authorization: string | null, now: Date): Promise<AuthedNode | null> {
  const m = /^Bearer (\S+)$/.exec(authorization ?? "");
  if (!m || !isWellFormedNodeToken(m[1]!)) return null;
  const hash = hashToken(m[1]!);
  const [row] = await db
    .select({ node: nodes, tokenId: nodeTokens.id, tokenHash: nodeTokens.tokenHash, lastUsedAt: nodeTokens.lastUsedAt })
    .from(nodeTokens)
    .innerJoin(nodes, eq(nodes.id, nodeTokens.nodeId))
    .where(and(eq(nodeTokens.tokenHash, hash), isNull(nodeTokens.revokedAt)))
    .limit(1);
  // The lookup is by hash, so this compare is belt and braces, not timing-critical.
  if (!row || !safeEqual(row.tokenHash, hash) || row.node.status === "revoked") return null;
  // "Last used" is shown to the owner to spot a forgotten or stolen token; to
  // the nearest few minutes is enough, so it's written at most every 5 minutes
  // instead of on every agent request.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOKEN_LAST_USED_EVERY_MS) {
    await db.update(nodeTokens).set({ lastUsedAt: now }).where(eq(nodeTokens.id, row.tokenId));
  }
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
  /** sha256 of the machine's ID, made by the agent. Stored as a keyed hash; used to spot one PC registered as many. */
  deviceId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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

export async function heartbeat(db: Db, node: NodeRow, input: z.infer<typeof heartbeatInput>, now: Date, ipSecret?: string, ip?: string): Promise<HeartbeatReply> {
  if (ipSecret) {
    await recordOrigin(db, node, { device: input.deviceId ? deviceHash(ipSecret, input.deviceId) : null, subnet: ip ? subnetHash(ipSecret, ip) : null }, ipSecret);
  }
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
export interface LeaseOptions {
  /** Issue canaries (known-answer pieces, or made-up challenges) that also time the PC. On in production; tests switch it on when they test it. */
  challenges?: boolean;
  rand?: (max: number) => number;
  /** Whether checks also skip PCs on the same device or network (always on in production). */
  sybil?: SybilMode;
  /** Where the request came from, for the network rule. */
  ip?: string;
  ipSecret?: string;
  /** Random number in [0, 1) for the canary-only rate. Tests pass a fixed one. */
  coverRand?: () => number;
}

export async function leaseFragment(
  db: Db,
  node: NodeRow,
  now: Date,
  keys: Pick<CoordinatorKeys, "signingKey" | "publicKey" | "dataKey">,
  opts: LeaseOptions = {},
): Promise<{ lease: LeaseReply | null; reason: Unavailable | "no_work" | "busy" | null }> {
  if (opts.ip && opts.ipSecret) await recordOrigin(db, node, { subnet: subnetHash(opts.ipSecret, opts.ip) }, opts.ipSecret);
  const [fresh] = await db
    .update(nodes)
    .set({ lastSeenAt: now, ...(node.status === "pending" || node.status === "offline" ? { status: "online" as const } : {}) })
    .where(eq(nodes.id, node.id))
    .returning();
  const mode: SybilMode = opts.sybil ?? "enforce";
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

  // A re-run of a verified real piece if there is one; a made-up challenge otherwise.
  const sendCanary = async () => {
    const { fragment, job } = (await createKnownAnswerCanary(db, fresh!, now, mode)) ?? (await createChallenge(db, fresh!, now, keys.dataKey, opts.rand));
    return { lease: await signLease(db, node, fragment, job, keys, now), reason: null };
  };
  // Canary-only verification (canary-only.ts): while this PC has pieces no
  // independent PC could check, 30% of its leases are canaries.
  const owed = opts.challenges ? await owesCanary(db, node.id) : false;
  const coverRand = opts.coverRand ?? (() => randomInt(1_000_000_000) / 1_000_000_000);
  if (opts.challenges) {
    if (wantsChallenge({ measured: fresh!.benchmarkScore !== null, lastChallengeAt: await lastChallengeAt(db, node.id), now, rand: opts.rand })) return sendCanary();
    if (owed && coverRand() < CANARY_ONLY_RATE) return sendCanary();
  }

  const closes = windowEndsAt(now, view.window);
  const me = { ownerId: fresh!.ownerId, deviceHash: fresh!.deviceHash, subnetHash: fresh!.subnetHash };
  // Take the first suitable pending piece in queue order. The candidates are
  // locked with SKIP LOCKED for this short transaction: PCs asking at the same
  // moment each get different pieces instead of queueing on the same rows.
  // fragment_queue_idx holds exactly this order (pending only), so this reads
  // a few index entries however long the queue is.
  const picked = await db.transaction(async (tx) => {
    const sibling = aliasedTable(fragments, "sibling");
    const candidates = await tx
      .select({ f: fragments, j: jobs })
      .from(fragments)
      .innerJoin(jobs, eq(jobs.id, fragments.jobId))
      .where(
        and(
          // A literal (not a parameter), so the partial index applies.
          sql`${fragments.status} = 'pending'`,
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
            tx
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
      .orderBy(desc(sql`${fragments.kind} = 'backup'`), asc(sql`${fragments.kind} = 'verification'`), asc(fragments.deadlineAt), asc(fragments.seq))
      .limit(10)
      .for("update", { of: fragments, skipLocked: true });

    for (const { f, j } of candidates) {
      // A check never goes to a PC on the same account, device or network as
      // any PC that ran or checked the piece: two PCs of one person could
      // agree on a wrong answer.
      if (f.kind === "verification" && !mayCheck(me, await pieceOrigins(tx, f.jobId, f.seq), mode)) continue;
      const spec = WORKLOADS[j.workloadType];
      const expected = estimateSeconds(spec, f.itemCount, nodeBenchmark(view));
      if (closes && now.getTime() + expected * 1000 > closes.getTime()) continue;
      const leaseUntil = new Date(now.getTime() + leaseSeconds(expected) * 1000);
      const [taken] = await tx
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
      if (j.status === "queued") await tx.update(jobs).set({ status: "running" }).where(and(eq(jobs.id, j.id), eq(jobs.status, "queued")));
      return { taken, j };
    }
    return null;
  });
  if (picked) return { lease: await signLease(db, node, picked.taken, picked.j, keys, now), reason: null };
  // Nothing else to do and pay is waiting on a canary: send one now.
  if (owed) return sendCanary();
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
  /** Time-Bank PCs: credits earned for the piece (pending until verified). */
  creditSeconds?: number;
}

/**
 * Stores a fragment's output and pays the owner. The caller has already
 * checked the size. Rejects outputs that don't match the declared sha256 or
 * the workload's output schema.
 */
export async function completeFragment(
  db: Db,
  node: NodeRow,
  args: {
    fragmentId: string;
    attempt: number;
    sha256: string;
    body: Uint8Array;
    now: Date;
    dataKey: Buffer;
    ipSecret: string;
    power?: PowerReport | null;
    /** For the extra checks of new and low-trust PCs. Tests pass a fixed one. */
    checkRand?: () => number;
  },
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
      // Caught cheating: pieces of this PC waiting on a canary (canary-only) fail with it.
      await settleCovers(db, { nodeId: node.id, canaryFragmentId: f.id, passed: false, issuedAt: f.startedAt ?? args.now, now: args.now, ipSecret: args.ipSecret });
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
      await settleCovers(tx, { nodeId: node.id, canaryFragmentId: f.id, passed: result.passed, issuedAt: f.startedAt ?? args.now, now: args.now, ipSecret: args.ipSecret });
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
        // The rate depends on how many pieces this PC had done before this one.
        const [counted] = await tx
          .update(nodes)
          .set({ piecesDone: sql`${nodes.piecesDone} + 1` })
          .where(eq(nodes.id, node.id))
          .returning({ piecesDone: nodes.piecesDone, trustScore: nodes.trustScore });
        const rate = checkRate({ piecesDone: (counted?.piecesDone ?? 1) - 1, trustScore: counted?.trustScore ?? payNode.trustScore });
        await queueCheckIfPicked(tx, { ...f, status: "done", outputKey, outputDigest: args.sha256, completedAt: args.now, completedByNodeId: node.id }, { rate, rand: args.checkRand });
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
    // Time-Bank: a buyer's piece earns credits instead of compute pay
    // (pending until verified). Checks and lost races are paid in rupees.
    const credits = accepted && f.kind !== "verification" && payNode.earnsCredits;
    // Per unit of verified work (the piece's standard GPU-seconds), not per second this PC took.
    const creditUnits = standardWorkSeconds(WORKLOADS[j.workloadType], f.itemCount);
    if (credits) {
      await earnCredits(tx, { userId: node.ownerId, nodeId: node.id, jobId: j.id, fragmentId: f.id, gpuSeconds: creditUnits, now: args.now, memo: `Earned for ${memo}` });
    }
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
    if (!credits) {
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
    }
    if (accepted && f.kind !== "verification") await completeJobIfDone(tx, j.id, args.now, args.ipSecret);
    return { accepted, paidPaise: pay.electricityPaise + (credits ? 0 : pay.ownerPayPaise), ...(credits ? { creditSeconds: creditUnits } : {}) };
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
