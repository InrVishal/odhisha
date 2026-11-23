import { and, desc, eq, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { benchmarkSamples, fragments, jobs, nodes, users } from "@/lib/db/schema";
import { newDataKey } from "@/lib/security/envelope";
import { sha256Hex } from "@/lib/security/signing";
import { buildChallenge, checkChallenge, medianScore, SAMPLE_WINDOW, type ChallengeSpec } from "./challenge";
import { CLASS_SPECS } from "./classes";
import type { Q } from "./lifecycle";
import type { NodeRow } from "./nodes";
import { leaseSeconds } from "./schedule";
import { keyOwner, putBlob } from "./store";
import { applyCheck } from "./verification";
import { encodeFragmentInput, estimateSeconds, WORKLOADS } from "./workloads";

/** Challenge jobs belong to this account: no email, can't log in, never billed. */
export const SYSTEM_USER_ID = "nightshift-system";

export interface StoredChallenge extends ChallengeSpec {
  nodeId: string;
}

async function ensureSystemUser(db: Q): Promise<void> {
  await db.insert(users).values({ id: SYSTEM_USER_ID, email: null }).onConflictDoNothing({ target: users.id });
}

export async function lastChallengeAt(db: Q, nodeId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: jobs.createdAt })
    .from(jobs)
    .where(sql`${jobs.challenge} ->> 'nodeId' = ${nodeId}`)
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/**
 * Creates a challenge piece already leased to this node, so no other PC can
 * take it. Returns the fragment and job to sign like any other task: the
 * agent can't tell it apart from real work.
 */
export async function createChallenge(
  db: Db,
  node: NodeRow,
  now: Date,
  masterKey: Buffer,
  rand?: (max: number) => number,
): Promise<{ fragment: typeof fragments.$inferSelect; job: typeof jobs.$inferSelect }> {
  const { texts, spec } = buildChallenge(rand);
  const workload = WORKLOADS.text_embeddings;
  const expected = estimateSeconds(workload, texts.length, CLASS_SPECS[node.gpuClass].defaultBenchmark);
  const leaseUntil = new Date(now.getTime() + leaseSeconds(expected) * 1000);
  return db.transaction(async (tx) => {
    await ensureSystemUser(tx);
    const stored: StoredChallenge = { ...spec, nodeId: node.id };
    const [job] = await tx
      .insert(jobs)
      .values({
        buyerId: SYSTEM_USER_ID,
        workloadType: "text_embeddings",
        gpuClass: node.gpuClass,
        params: workload.params.parse({}),
        itemCount: texts.length,
        maxWattTariff: 2_147_483_647,
        maxOwnerRate: 2_147_483_647,
        status: "running",
        pricePaise: 0,
        breakdown: { challenge: true },
        deadlineAt: leaseUntil,
        quoteExpiresAt: now,
        fragmentCount: 1,
        purgeAfter: new Date(leaseUntil.getTime() + 3600_000),
        challenge: stored,
        // The scheduler's clock, not the database's: "when was the last
        // challenge" is compared with the scheduler's now.
        createdAt: now,
      })
      .returning();
    const input = encodeFragmentInput(texts.map((text) => ({ kind: "text" as const, text })));
    const { dataKey, wrapped } = newDataKey(masterKey, keyOwner(job!.id, 0));
    const inputKey = await putBlob(tx, { dataKey, jobId: job!.id, plaintext: input });
    const [fragment] = await tx
      .insert(fragments)
      .values({
        jobId: job!.id,
        seq: 0,
        kind: "primary",
        status: "leased",
        estGpuSeconds: expected,
        itemCount: texts.length,
        inputKey,
        inputSha256: sha256Hex(input),
        wrappedKey: wrapped,
        attempts: 1,
        maxAttempts: 1,
        leaseNodeId: node.id,
        leaseExpiresAt: leaseUntil,
        leaseExpectedSec: expected,
        startedAt: now,
      })
      .returning();
    return { fragment: fragment!, job: job! };
  });
}

/**
 * Settles a finished challenge. Pass: the run is timed on the coordinator's
 * clock and the PC's score becomes the median of its recent runs. Fail: a
 * failed check (trust −250, quarantine below 200) and no pay.
 */
export async function settleChallenge(
  q: Q,
  node: Pick<NodeRow, "id">,
  args: { spec: StoredChallenge; output: Uint8Array; startedAt: Date; now: Date; ipSecret: string },
): Promise<{ passed: boolean; failures: string[]; score: number | null }> {
  const result = checkChallenge(args.spec, args.output);
  if (!result.passed) {
    await applyCheck(q, node.id, "fail", args.now, args.ipSecret);
    await audit(
      q as Db,
      { actorId: null, actorType: "system", action: "node.canary_failed", targetType: "node", targetId: node.id, meta: { failures: result.failures.join("; ").slice(0, 200) } },
      args.ipSecret,
    );
    return { ...result, score: null };
  }
  const millis = Math.max(1, args.now.getTime() - args.startedAt.getTime());
  await q.insert(benchmarkSamples).values({ nodeId: node.id, items: args.spec.items, millis });
  const recent = await q
    .select({ items: benchmarkSamples.items, millis: benchmarkSamples.millis })
    .from(benchmarkSamples)
    .where(eq(benchmarkSamples.nodeId, node.id))
    .orderBy(desc(benchmarkSamples.createdAt), desc(benchmarkSamples.id))
    .limit(SAMPLE_WINDOW);
  const score = medianScore(recent);
  if (score !== null) await q.update(nodes).set({ benchmarkScore: score }).where(and(eq(nodes.id, node.id)));
  return { ...result, score };
}

export async function nodeSampleCount(db: Q, nodeId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(benchmarkSamples).where(eq(benchmarkSamples.nodeId, nodeId));
  return row?.n ?? 0;
}
