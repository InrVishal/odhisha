import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { fragments, nodes, nodeTokens } from "@/lib/db/schema";
import { LIMITS } from "@/lib/pricing";
import { generateNodeToken, hashToken } from "@/lib/security/tokens";
import { CLASS_SPECS, NODE_CLASSES } from "./classes";
import { CoordinatorError, notFound } from "./errors";
import { requeueLeased } from "./lifecycle";
import { unavailableReason, type NodeView } from "./schedule";

/**
 * Owner-side node management. Every function takes the owner's id from the
 * session and scopes every query to it: an owner can only see or change
 * their own nodes (tested in tests/integration/idor.test.ts).
 */

export const MAX_NODES_PER_OWNER = 20;

export type NodeRow = typeof nodes.$inferSelect;

export function toNodeView(n: NodeRow): NodeView {
  return {
    id: n.id,
    nodeClass: n.gpuClass,
    status: n.status,
    paused: n.paused,
    lastSeenAt: n.lastSeenAt,
    trustScore: n.trustScore,
    benchmarkScore: n.benchmarkScore,
    measuredWatts: n.measuredWatts,
    tariffPaisePerKwh: n.tariffPaisePerKwh,
    ownerRatePaisePerHr: n.ownerRatePaisePerHr,
    window: { startMin: n.nightWindowStartMin, endMin: n.nightWindowEndMin, timezone: n.timezone },
  };
}

const nodeName = z
  .string()
  .trim()
  .min(1, "Give the PC a name.")
  .max(64)
  .regex(/^[\p{L}\p{N} ._'()-]+$/u, "Use letters, numbers, spaces and . _ - ' ( ) only.");

export const registerNodeInput = z.strictObject({
  name: nodeName,
  gpuClass: z.enum(NODE_CLASSES),
});

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const minuteOfDay = z.int().min(0).max(1439);

export const updateNodeInput = z
  .strictObject({
    name: nodeName,
    /** Paise per kWh: the owner's own electricity tariff. */
    tariffPaisePerKwh: z.int().min(1).max(LIMITS.maxTariffPaisePerKwh),
    /** Paise per GPU-hour on top of electricity. */
    ownerRatePaisePerHr: z.int().min(0).max(100_000),
    nightWindowStartMin: minuteOfDay,
    nightWindowEndMin: minuteOfDay,
    timezone: z.string().max(64).refine(isTimeZone, "Unknown time zone."),
    paused: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");

export interface PublicNode {
  id: string;
  name: string;
  gpuClass: NodeRow["gpuClass"];
  gpuModel: string | null;
  status: NodeRow["status"];
  /** True when it can take work right now. */
  available: boolean;
  unavailableReason: string | null;
  paused: boolean;
  benchmarkScore: number | null;
  defaultWatts: number;
  measuredWatts: number | null;
  /** True when the watts are the owner's declared estimate (CPU mode). */
  wattsEstimated: boolean;
  trustScore: number;
  tariffPaisePerKwh: number;
  ownerRatePaisePerHr: number;
  nightWindowStartMin: number;
  nightWindowEndMin: number;
  timezone: string;
  lastSeenAt: string | null;
}

export function toPublicNode(n: NodeRow, now: Date): PublicNode {
  const reason = unavailableReason(toNodeView(n), now);
  return {
    id: n.id,
    name: n.name,
    gpuClass: n.gpuClass,
    gpuModel: n.gpuModel,
    status: n.status,
    available: reason === null,
    unavailableReason: reason,
    paused: n.paused,
    benchmarkScore: n.benchmarkScore,
    defaultWatts: n.defaultWatts,
    measuredWatts: n.measuredWatts,
    wattsEstimated: n.wattsEstimated,
    trustScore: n.trustScore,
    tariffPaisePerKwh: n.tariffPaisePerKwh,
    ownerRatePaisePerHr: n.ownerRatePaisePerHr,
    nightWindowStartMin: n.nightWindowStartMin,
    nightWindowEndMin: n.nightWindowEndMin,
    timezone: n.timezone,
    lastSeenAt: n.lastSeenAt?.toISOString() ?? null,
  };
}

interface Ctx {
  db: Db;
  ownerId: string;
  now: Date;
  ip?: string;
  ipSecret: string;
}

/** Registers a node and returns its install token. The token is shown ONCE. */
export async function registerNode(ctx: Ctx, input: z.infer<typeof registerNodeInput>): Promise<{ node: PublicNode; token: string }> {
  const [{ n } = { n: 0 }] = await ctx.db.select({ n: count() }).from(nodes).where(eq(nodes.ownerId, ctx.ownerId));
  if (n >= MAX_NODES_PER_OWNER) {
    throw new CoordinatorError(409, "too_many_nodes", `You can register up to ${MAX_NODES_PER_OWNER} PCs.`);
  }
  const token = generateNodeToken();
  const node = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(nodes)
      .values({
        ownerId: ctx.ownerId,
        name: input.name,
        gpuClass: input.gpuClass,
        defaultWatts: CLASS_SPECS[input.gpuClass].defaultWatts,
      })
      .returning();
    await tx.insert(nodeTokens).values({ nodeId: row!.id, tokenHash: hashToken(token) });
    return row!;
  });
  await audit(
    ctx.db,
    { actorId: ctx.ownerId, actorType: "user", action: "node.registered", targetType: "node", targetId: node.id, ip: ctx.ip, meta: { gpuClass: node.gpuClass } },
    ctx.ipSecret,
  );
  await audit(
    ctx.db,
    { actorId: ctx.ownerId, actorType: "user", action: "node.token_created", targetType: "node", targetId: node.id, ip: ctx.ip },
    ctx.ipSecret,
  );
  return { node: toPublicNode(node, ctx.now), token };
}

export async function listNodes(ctx: Pick<Ctx, "db" | "ownerId" | "now">): Promise<PublicNode[]> {
  const rows = await ctx.db.select().from(nodes).where(eq(nodes.ownerId, ctx.ownerId)).orderBy(nodes.createdAt);
  return rows.map((r) => toPublicNode(r, ctx.now));
}

async function ownNode(db: Db, ownerId: string, nodeId: string): Promise<NodeRow> {
  if (!z.uuid().safeParse(nodeId).success) throw notFound();
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function getNode(ctx: Pick<Ctx, "db" | "ownerId" | "now">, nodeId: string): Promise<PublicNode> {
  return toPublicNode(await ownNode(ctx.db, ctx.ownerId, nodeId), ctx.now);
}

export async function updateNode(ctx: Ctx, nodeId: string, patch: z.infer<typeof updateNodeInput>): Promise<PublicNode> {
  await ownNode(ctx.db, ctx.ownerId, nodeId);
  const [row] = await ctx.db
    .update(nodes)
    .set(patch)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
    .returning();
  if (!row) throw notFound();
  await audit(
    ctx.db,
    {
      actorId: ctx.ownerId,
      actorType: "user",
      action: "node.updated",
      targetType: "node",
      targetId: nodeId,
      ip: ctx.ip,
      meta: { fields: Object.keys(patch).sort().join(",") },
    },
    ctx.ipSecret,
  );
  return toPublicNode(row, ctx.now);
}

/**
 * Revokes the node's current token(s) and issues a new one, shown once. Use
 * when a token may have leaked, or to move the agent to a new install.
 */
export async function rotateNodeToken(ctx: Ctx, nodeId: string): Promise<{ token: string }> {
  const node = await ownNode(ctx.db, ctx.ownerId, nodeId);
  const token = generateNodeToken();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(nodeTokens)
      .set({ revokedAt: ctx.now })
      .where(and(eq(nodeTokens.nodeId, nodeId), isNull(nodeTokens.revokedAt)));
    await tx.insert(nodeTokens).values({ nodeId, tokenHash: hashToken(token) });
    if (node.status === "revoked") await tx.update(nodes).set({ status: "pending" }).where(eq(nodes.id, nodeId));
    await requeueLeased(tx, eq(fragments.leaseNodeId, nodeId), ctx.now, ctx.ipSecret);
  });
  await audit(ctx.db, { actorId: ctx.ownerId, actorType: "user", action: "node.token_revoked", targetType: "node", targetId: nodeId, ip: ctx.ip }, ctx.ipSecret);
  await audit(ctx.db, { actorId: ctx.ownerId, actorType: "user", action: "node.token_created", targetType: "node", targetId: nodeId, ip: ctx.ip }, ctx.ipSecret);
  return { token };
}

/**
 * Revokes every token for the node: its agent is locked out on its next
 * request. Work it was holding goes back in the queue straight away.
 */
export async function revokeNode(ctx: Ctx, nodeId: string): Promise<void> {
  const node = await ownNode(ctx.db, ctx.ownerId, nodeId);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(nodeTokens)
      .set({ revokedAt: ctx.now })
      .where(and(eq(nodeTokens.nodeId, nodeId), isNull(nodeTokens.revokedAt)));
    // A quarantined node stays quarantined: revoking must not clear that.
    if (node.status !== "quarantined") await tx.update(nodes).set({ status: "revoked" }).where(eq(nodes.id, nodeId));
    await requeueLeased(tx, eq(fragments.leaseNodeId, nodeId), ctx.now, ctx.ipSecret);
  });
  await audit(ctx.db, { actorId: ctx.ownerId, actorType: "user", action: "node.token_revoked", targetType: "node", targetId: nodeId, ip: ctx.ip }, ctx.ipSecret);
}

