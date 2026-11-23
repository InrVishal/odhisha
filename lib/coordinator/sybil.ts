import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { and, desc, eq, ne, or } from "drizzle-orm";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { auditLog, fragments, nodes, users } from "@/lib/db/schema";
import { CoordinatorError } from "./errors";
import type { Q } from "./lifecycle";

/**
 * Fake accounts and fake PCs (Sybil attacks). We don't check identity, so
 * these are anchors, not proof:
 *
 * - Payout UPI ID: one UPI ID can belong to one account. Linking one that
 *   another account holds is refused and flagged.
 * - Device: the agent sends a hash of its machine ID. Two PCs (on any
 *   accounts) with the same device are flagged.
 * - Network: the /24 (IPv4) or /48 (IPv6) a PC calls from. PCs of different
 *   accounts on one network are flagged. Hostels, labs and mobile networks
 *   share addresses, so a flag is for an admin to look at, not a ban.
 *
 * Checks are never given to a PC on the same account, device or network as
 * any PC that ran the piece (lib/coordinator/agent.ts).
 *
 * Everything is stored as a keyed hash (HMAC with the server secret), so the
 * database holds no raw IPs, device IDs or UPI IDs.
 */

export type SybilKind = "upi" | "device" | "subnet";

/**
 * "enforce": checks skip PCs sharing a device or network with the PC they
 * check. "report": flags only (preview deployments, where every test agent
 * runs on one CI machine). The account rule is always enforced. Production
 * refuses "report" (lib/env.ts).
 */
export type SybilMode = "enforce" | "report";

function keyed(secret: string, label: string, value: string): string {
  return createHmac("sha256", secret).update(`${label}:${value}`).digest("hex");
}

/** "203.0.113.7" → "203.0.113.0/24"; IPv6 → its /48. Null when there's no usable address. */
export function subnetOf(ip: string): string | null {
  const v = ip.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  const addr = mapped ? mapped[1]! : v;
  const kind = isIP(addr);
  if (kind === 4) return `${addr.split(".").slice(0, 3).join(".")}.0/24`;
  if (kind === 6) {
    const [head, tail = ""] = addr.toLowerCase().split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = addr.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
    return `${groups.slice(0, 3).map((g) => g.padStart(4, "0")).join(":")}::/48`;
  }
  return null;
}

export const subnetHash = (secret: string, ip: string): string | null => {
  const s = subnetOf(ip);
  return s ? keyed(secret, "subnet", s) : null;
};
export const deviceHash = (secret: string, deviceId: string): string => keyed(secret, "device", deviceId.toLowerCase());

/** Normalises a UPI ID (name@handle), or null if it isn't one. */
export function normaliseUpi(input: string): string | null {
  const v = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9]{1,63}$/.test(v) ? v : null;
}

/** "ravi.k@okaxis" → "ra•••@okaxis". */
export function maskUpi(upi: string): string {
  const [name, handle] = upi.split("@") as [string, string];
  return `${name.slice(0, 2)}•••@${handle}`;
}

export const upiHash = (secret: string, upi: string): string => keyed(secret, "upi", upi);

async function flag(q: Q, kind: SybilKind, accounts: string[], extra: { nodes?: string[]; sameAccount?: boolean }, ipSecret: string): Promise<void> {
  await audit(
    q as Db,
    {
      actorId: null,
      actorType: "system",
      action: "sybil.flagged",
      targetType: "user",
      targetId: accounts[0],
      meta: { kind, accounts: accounts.join(","), nodes: (extra.nodes ?? []).join(","), sameAccount: extra.sameAccount ?? false },
    },
    ipSecret,
  );
}

/**
 * Records the device and network a PC is calling from. When either changes,
 * flags other PCs that share it: on other accounts (possible fake accounts),
 * or on the same account for a device (one PC registered twice).
 */
export async function recordOrigin(q: Q, node: { id: string; ownerId: string; deviceHash: string | null; subnetHash: string | null }, seen: { device?: string | null; subnet?: string | null }, ipSecret: string): Promise<void> {
  const patch: { deviceHash?: string; subnetHash?: string } = {};
  if (seen.device && seen.device !== node.deviceHash) patch.deviceHash = seen.device;
  if (seen.subnet && seen.subnet !== node.subnetHash) patch.subnetHash = seen.subnet;
  if (!patch.deviceHash && !patch.subnetHash) return;
  await q.update(nodes).set(patch).where(eq(nodes.id, node.id));

  if (patch.deviceHash) {
    const twins = await q
      .select({ id: nodes.id, ownerId: nodes.ownerId })
      .from(nodes)
      .where(and(eq(nodes.deviceHash, patch.deviceHash), ne(nodes.id, node.id), ne(nodes.status, "revoked")));
    if (twins.length) {
      const accounts = [...new Set([node.ownerId, ...twins.map((t) => t.ownerId)])];
      await flag(q, "device", accounts, { nodes: [node.id, ...twins.map((t) => t.id)], sameAccount: accounts.length === 1 }, ipSecret);
    }
  }
  if (patch.subnetHash) {
    const neighbours = await q
      .select({ id: nodes.id, ownerId: nodes.ownerId })
      .from(nodes)
      .where(and(eq(nodes.subnetHash, patch.subnetHash), ne(nodes.ownerId, node.ownerId), ne(nodes.status, "revoked")));
    if (neighbours.length) {
      const accounts = [...new Set([node.ownerId, ...neighbours.map((t) => t.ownerId)])];
      await flag(q, "subnet", accounts, { nodes: [node.id, ...neighbours.map((t) => t.id)] }, ipSecret);
    }
  }
}

export interface Origin {
  ownerId: string;
  deviceHash: string | null;
  subnetHash: string | null;
}

/** Owner, device and network of every PC that ran or holds a copy of this piece. */
export async function pieceOrigins(q: Q, jobId: string, seq: number): Promise<Origin[]> {
  return q
    .select({ ownerId: nodes.ownerId, deviceHash: nodes.deviceHash, subnetHash: nodes.subnetHash })
    .from(fragments)
    .innerJoin(nodes, or(eq(nodes.id, fragments.completedByNodeId), eq(nodes.id, fragments.leaseNodeId)))
    .where(and(eq(fragments.jobId, jobId), eq(fragments.seq, seq)));
}

/**
 * May `me` check work done by PCs with these origins? Never on the same
 * account; in "enforce" mode also never on the same device or network.
 */
export function mayCheck(me: Origin, origins: readonly Origin[], mode: SybilMode): boolean {
  return origins.every(
    (o) =>
      o.ownerId !== me.ownerId &&
      (mode === "report" ||
        ((!me.deviceHash || o.deviceHash !== me.deviceHash) && (!me.subnetHash || o.subnetHash !== me.subnetHash))),
  );
}

/**
 * Links a payout UPI ID to an account. One UPI ID, one account: if another
 * account already has it, nothing changes, both accounts are flagged, and
 * the caller gets a 409.
 */
export async function linkUpi(db: Db, userId: string, input: string, ipSecret: string): Promise<{ upiMasked: string }> {
  const upi = normaliseUpi(input);
  if (!upi) throw new CoordinatorError(400, "invalid_upi", "That isn't a UPI ID (it looks like name@bank).");
  const hash = upiHash(ipSecret, upi);
  const [holder] = await db.select({ id: users.id }).from(users).where(eq(users.upiHash, hash)).limit(1);
  if (holder && holder.id !== userId) {
    await flag(db, "upi", [userId, holder.id], {}, ipSecret);
    throw new CoordinatorError(409, "upi_in_use", "That UPI ID is linked to another account. One UPI ID can be used by one account only.");
  }
  const masked = maskUpi(upi);
  try {
    await db.update(users).set({ upiHash: hash, upiMasked: masked }).where(eq(users.id, userId));
  } catch (e) {
    // Two accounts racing for the same UPI ID: the unique index lets one win.
    if (/unique|duplicate/i.test(String((e as { message?: string }).message ?? e))) {
      throw new CoordinatorError(409, "upi_in_use", "That UPI ID is linked to another account. One UPI ID can be used by one account only.");
    }
    throw e;
  }
  return { upiMasked: masked };
}

export interface SybilFlag {
  at: Date;
  kind: SybilKind;
  accounts: string[];
  nodes: string[];
}

/** Recent flags, newest first, for the admin panel. */
export async function recentFlags(db: Db, limit = 50): Promise<SybilFlag[]> {
  const rows = await db
    .select({ at: auditLog.at, meta: auditLog.meta })
    .from(auditLog)
    .where(eq(auditLog.action, "sybil.flagged"))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit);
  return rows.map((r) => {
    const m = (r.meta ?? {}) as { kind?: SybilKind; accounts?: string; nodes?: string };
    const list = (v?: string) => (v ? v.split(",").filter(Boolean) : []);
    return { at: r.at, kind: m.kind ?? "device", accounts: list(m.accounts), nodes: list(m.nodes) };
  });
}

