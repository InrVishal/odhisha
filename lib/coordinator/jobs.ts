import { randomUUID } from "node:crypto";
import { and, count, countDistinct, desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { fragments, jobs, nodes } from "@/lib/db/schema";
import { bookBuyer, jobNetCharge, ledgerKeys } from "@/lib/ledger";
import { getPayments } from "@/lib/payments";
import { priceJob, type PriceBreakdown } from "@/lib/pricing";
import { newDataKey } from "@/lib/security/envelope";
import { sha256Hex } from "@/lib/security/signing";
import { CLASS_SPECS, NODE_CLASSES, type NodeClass } from "./classes";
import { CoordinatorError, notFound } from "./errors";
import { purgeTime } from "./lifecycle";
import { toNodeView } from "./nodes";
import { jobChecks, planVerification, type JobChecks } from "./verification";
import {
  nodeWatts,
  planFragments,
  QUOTE_TTL_SEC,
  quotedDeadline,
  unavailableReason,
  wattTariff,
  type NodeView,
} from "./schedule";
import { deleteJobBlobs, fragmentDataKey, getBlob, keyOwner, putBlob } from "./store";
import {
  checkItems,
  encodeFragmentInput,
  estimateSeconds,
  splitItems,
  WORKLOAD_TYPES,
  WORKLOADS,
  type InputItem,
  type WorkloadType,
} from "./workloads";

/**
 * Buyer-side job lifecycle: quote → confirm → (agents run it) → results.
 * Every query is scoped to the buyer id from the session.
 */

/** A buyer can hold this many unconfirmed quotes at once (each stores data). */
export const MAX_OPEN_QUOTES = 5;

export const quoteRequest = z.strictObject({
  workloadType: z.enum(WORKLOAD_TYPES),
  gpuClass: z.enum(NODE_CLASSES),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const textQuoteRequest = quoteRequest.extend({
  texts: z.array(z.string()).min(1).max(WORKLOADS.text_embeddings.limits.maxItems),
});

interface Ctx {
  db: Db;
  buyerId: string;
  now: Date;
  masterKey: Buffer;
  ip?: string;
  ipSecret: string;
}

/** The pricing breakdown we store and show. All paise. */
export interface QuoteBreakdown extends PriceBreakdown {
  /** The reference machine the price assumes: no node costing more may run it. */
  reference: { watts: number; tariffPaisePerKwh: number; ownerRatePaisePerHr: number };
  fragments: number;
}

export interface PublicJob {
  id: string;
  workloadType: WorkloadType;
  gpuClass: NodeClass;
  status: (typeof jobs.$inferSelect)["status"];
  itemCount: number;
  pricePaise: number;
  breakdown: QuoteBreakdown;
  deadlineAt: string;
  quoteExpiresAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  refunded: boolean;
  /** What the buyer has actually paid for this job (charge − refunds). */
  netChargedPaise: number;
  progress: { fragmentsDone: number; fragmentsTotal: number; nodesWorking: number };
  /** Pieces re-run on a second PC to check them, and how that went. */
  checks: JobChecks;
  resultsAvailable: boolean;
  purged: boolean;
  /** Payments are simulated in this prototype. */
  demo: true;
}

/** Available nodes of a class, for planning a quote. */
async function availableNodes(db: Db, gpuClass: NodeClass, now: Date): Promise<NodeView[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.gpuClass, gpuClass), eq(nodes.status, "online"), eq(nodes.paused, false)));
  return rows.map(toNodeView).filter((n) => unavailableReason(n, now) === null);
}

/**
 * Prices a job and holds the quote for 10 minutes. The data is split into
 * fragments and stored encrypted right away, so confirming runs exactly what
 * was quoted.
 */
export async function quoteJob(
  ctx: Ctx,
  req: { workloadType: WorkloadType; gpuClass: NodeClass; params: unknown; items: InputItem[] },
): Promise<PublicJob> {
  const spec = WORKLOADS[req.workloadType];
  // No pinned image means no agent can run it: refuse rather than take money
  // for a job that would only end in a deadline refund.
  if (!spec.image) throw new CoordinatorError(503, "workload_unavailable", `${spec.label} isn't available yet.`);
  const parsedParams = spec.params.safeParse(req.params);
  if (!parsedParams.success) throw new CoordinatorError(400, "bad_params", "Those settings aren't valid for this job type.");
  const params = parsedParams.data;
  checkItems(spec, req.items);

  const [{ open } = { open: 0 }] = await ctx.db
    .select({ open: count() })
    .from(jobs)
    .where(and(eq(jobs.buyerId, ctx.buyerId), eq(jobs.status, "quoted"), gt(jobs.quoteExpiresAt, ctx.now)));
  if (open >= MAX_OPEN_QUOTES) {
    throw new CoordinatorError(409, "too_many_quotes", "You have too many open quotes. Confirm or cancel one first.");
  }

  const pool = await availableNodes(ctx.db, req.gpuClass, ctx.now);
  if (pool.length === 0) {
    throw new CoordinatorError(503, "no_capacity", `No ${CLASS_SPECS[req.gpuClass].label}s are taking work right now. Try another class or later.`);
  }

  const ranges = splitItems(spec, req.items);
  const counts = ranges.map(([a, b]) => b - a);
  const plan = planFragments(spec, counts, pool, ctx.now);
  const deadline = plan ? quotedDeadline(ctx.now, plan.makespanSec) : null;
  if (!plan || !deadline || (plan.latestWindowEnd && deadline > plan.latestWindowEnd)) {
    throw new CoordinatorError(503, "no_capacity", "There isn't enough time left in tonight's window for this job. Try fewer items.");
  }

  // Price cap: the most expensive available node in each dimension. Any node
  // that costs more is not allowed to run this job (see schedule.withinCap).
  const priciestPower = pool.reduce((a, b) => (wattTariff(b) > wattTariff(a) ? b : a));
  const reference = {
    watts: nodeWatts(priciestPower),
    tariffPaisePerKwh: priciestPower.tariffPaisePerKwh,
    ownerRatePaisePerHr: Math.max(...pool.map((n) => n.ownerRatePaisePerHr)),
  };
  // Every fragment is priced at its estimated time on the class's standard
  // machine, so the price doesn't depend on which node happens to run it.
  const classBenchmark = CLASS_SPECS[req.gpuClass].defaultBenchmark;
  const fragmentSeconds = counts.map((c) => estimateSeconds(spec, c, classBenchmark));
  const price = priceJob(
    fragmentSeconds.map((s) => ({ gpuSeconds: s, ...reference })),
    { roundPerFragment: true },
  );
  const breakdown: QuoteBreakdown = { ...price, reference, fragments: counts.length };

  const jobId = randomUUID();
  const quoteExpiresAt = new Date(ctx.now.getTime() + QUOTE_TTL_SEC * 1000);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(jobs).values({
      id: jobId,
      buyerId: ctx.buyerId,
      workloadType: req.workloadType,
      gpuClass: req.gpuClass,
      params,
      itemCount: req.items.length,
      maxWattTariff: wattTariff(priciestPower),
      maxOwnerRate: reference.ownerRatePaisePerHr,
      status: "quoted",
      pricePaise: price.totalPaise,
      breakdown,
      deadlineAt: deadline,
      quoteExpiresAt,
      fragmentCount: counts.length,
      // An unconfirmed quote's data goes when the quote expires.
      purgeAfter: quoteExpiresAt,
    });
    for (const [seq, [a, b]] of ranges.entries()) {
      const { dataKey, wrapped } = newDataKey(ctx.masterKey, keyOwner(jobId, seq));
      const input = encodeFragmentInput(req.items.slice(a, b));
      const inputKey = await putBlob(tx, { dataKey, jobId, plaintext: input });
      await tx.insert(fragments).values({
        jobId,
        seq,
        kind: "primary",
        status: "pending",
        estGpuSeconds: fragmentSeconds[seq]!,
        itemCount: b - a,
        inputKey,
        inputSha256: sha256Hex(input),
        wrappedKey: wrapped,
      });
    }
  });
  return getJob(ctx, jobId);
}

async function ownJob(db: Db, buyerId: string, jobId: string): Promise<typeof jobs.$inferSelect> {
  if (!z.uuid().safeParse(jobId).success) throw notFound();
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.buyerId, buyerId)))
    .limit(1);
  if (!job) throw notFound();
  return job;
}

/** Confirms a quote: charges the buyer (simulated) and queues the fragments. */
export async function confirmJob(ctx: Ctx, jobId: string): Promise<PublicJob> {
  const job = await ownJob(ctx.db, ctx.buyerId, jobId);
  if (job.status !== "quoted") throw new CoordinatorError(409, "not_quoted", "This job was already confirmed or cancelled.");
  if (job.quoteExpiresAt <= ctx.now) throw new CoordinatorError(409, "quote_expired", "This quote has expired. Ask for a new one.");

  const key = ledgerKeys.charge(job.id);
  const charge = await getPayments().charge({ buyerId: ctx.buyerId, jobId, amountPaise: job.pricePaise, idempotencyKey: key });
  if (!charge.ok) throw new CoordinatorError(409, "payment_failed", "The payment didn't go through.");

  await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(jobs)
      .set({ status: "queued", confirmedAt: ctx.now, purgeAfter: purgeTime(job.deadlineAt) })
      .where(and(eq(jobs.id, jobId), eq(jobs.buyerId, ctx.buyerId), eq(jobs.status, "quoted"), gt(jobs.quoteExpiresAt, ctx.now)))
      .returning({ id: jobs.id });
    if (!updated) throw new CoordinatorError(409, "not_quoted", "This job was already confirmed or cancelled.");
    // About 1 piece in 10 (at least one) will be re-run on a second PC.
    await planVerification(tx, jobId, job.fragmentCount);
    await bookBuyer(tx, {
      buyerId: ctx.buyerId,
      jobId,
      entryType: "charge",
      amountPaise: job.pricePaise,
      idempotencyKey: key,
      memo: `Job charge (${charge.reference})`,
    });
  });
  await audit(
    ctx.db,
    { actorId: ctx.buyerId, actorType: "user", action: "job.confirmed", targetType: "job", targetId: jobId, ip: ctx.ip, meta: { pricePaise: job.pricePaise, demo: charge.demo } },
    ctx.ipSecret,
  );
  return getJob(ctx, jobId);
}

/** Cancels an unconfirmed quote and deletes its data now. */
export async function cancelQuote(ctx: Ctx, jobId: string): Promise<PublicJob> {
  await ownJob(ctx.db, ctx.buyerId, jobId);
  await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(jobs)
      .set({ status: "cancelled", purgedAt: ctx.now })
      .where(and(eq(jobs.id, jobId), eq(jobs.buyerId, ctx.buyerId), eq(jobs.status, "quoted")))
      .returning({ id: jobs.id });
    if (!updated) throw new CoordinatorError(409, "not_quoted", "Only an unconfirmed quote can be cancelled.");
    await tx.update(fragments).set({ status: "cancelled" }).where(eq(fragments.jobId, jobId));
    await deleteJobBlobs(tx, jobId);
  });
  return getJob(ctx, jobId);
}

async function toPublicJob(db: Db, job: typeof jobs.$inferSelect): Promise<PublicJob> {
  const [{ done } = { done: 0 }] = await db
    .select({ done: countDistinct(fragments.seq) })
    .from(fragments)
    .where(and(eq(fragments.jobId, job.id), eq(fragments.status, "done"), inArray(fragments.kind, ["primary", "backup"])));
  const [{ working } = { working: 0 }] = await db
    .select({ working: countDistinct(fragments.leaseNodeId) })
    .from(fragments)
    .where(and(eq(fragments.jobId, job.id), eq(fragments.status, "leased")));
  const finished = Boolean(job.completedAt);
  return {
    id: job.id,
    workloadType: job.workloadType,
    gpuClass: job.gpuClass,
    status: job.status,
    itemCount: job.itemCount,
    pricePaise: job.pricePaise,
    breakdown: job.breakdown as QuoteBreakdown,
    deadlineAt: job.deadlineAt.toISOString(),
    quoteExpiresAt: job.quoteExpiresAt.toISOString(),
    confirmedAt: job.confirmedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    refunded: Boolean(job.refundedAt),
    netChargedPaise: await jobNetCharge(db, job.buyerId, job.id),
    progress: { fragmentsDone: done, fragmentsTotal: job.fragmentCount, nodesWorking: working },
    checks: await jobChecks(db, job.id),
    resultsAvailable: finished && !job.purgedAt,
    purged: Boolean(job.purgedAt),
    demo: true,
  };
}

export async function getJob(ctx: Pick<Ctx, "db" | "buyerId">, jobId: string): Promise<PublicJob> {
  return toPublicJob(ctx.db, await ownJob(ctx.db, ctx.buyerId, jobId));
}

export async function listJobs(ctx: Pick<Ctx, "db" | "buyerId">, limit = 50): Promise<PublicJob[]> {
  const rows = await ctx.db.select().from(jobs).where(eq(jobs.buyerId, ctx.buyerId)).orderBy(desc(jobs.createdAt)).limit(limit);
  return Promise.all(rows.map((r) => toPublicJob(ctx.db, r)));
}

/**
 * The job's results, one entry per input item in input order, as a stream of
 * JSON text: {"workloadType": ..., "items": [...]}. Streams piece by piece so a
 * large result never sits in memory (or hits a response size limit) at once.
 */
export async function openResults(
  ctx: Pick<Ctx, "db" | "buyerId" | "masterKey">,
  jobId: string,
): Promise<{ filename: string; stream: ReadableStream<Uint8Array> }> {
  const job = await ownJob(ctx.db, ctx.buyerId, jobId);
  if (job.purgedAt) throw new CoordinatorError(410, "purged", "This job's data was deleted after 7 days.");
  if (!job.completedAt) throw new CoordinatorError(409, "not_finished", "Results are ready when the job finishes.");

  const done = await ctx.db
    .select()
    .from(fragments)
    .where(and(eq(fragments.jobId, jobId), eq(fragments.status, "done"), inArray(fragments.kind, ["primary", "backup"])))
    .orderBy(fragments.seq);
  const bySeq = new Map<number, (typeof done)[number]>();
  for (const f of done) if (!bySeq.has(f.seq)) bySeq.set(f.seq, f);

  const db = ctx.db;
  const masterKey = ctx.masterKey;
  const enc = new TextEncoder();
  let seq = 0;
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(`{"jobId":${JSON.stringify(job.id)},"workloadType":${JSON.stringify(job.workloadType)},"items":[`));
    },
    async pull(controller) {
      if (seq >= job.fragmentCount) {
        controller.enqueue(enc.encode("]}"));
        controller.close();
        return;
      }
      const f = bySeq.get(seq);
      if (!f?.outputKey) {
        controller.error(new Error("missing output"));
        return;
      }
      const bytes = await getBlob(db, { dataKey: fragmentDataKey(masterKey, f), jobId, key: f.outputKey });
      if (!bytes) {
        controller.error(new Error("missing output"));
        return;
      }
      const { items } = JSON.parse(bytes.toString("utf8")) as { items: unknown[] };
      for (const item of items) {
        controller.enqueue(enc.encode((first ? "" : ",") + JSON.stringify(item)));
        first = false;
      }
      seq += 1;
    },
  });
  return { filename: `nightshift-${job.id}.json`, stream };
}
