import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit } from "@/lib/audit";
import { minimalAdapter } from "@/lib/auth/adapter";
import { rows, type Db } from "@/lib/db/client";
import {
  accounts,
  APPEND_ONLY_TABLES,
  auditLog,
  buyerLedger,
  creditLedger,
  nodes,
  nodeTokens,
  ownerLedger,
  users,
} from "@/lib/db/schema";
import { DEFAULT_OWNER_RATE_PAISE_PER_HR } from "@/lib/pricing";
import { generateNodeToken, hashToken } from "@/lib/security/tokens";
import { freshDb } from "../helpers/db";

let db: Db;
let cleanup: () => Promise<void>;
let ownerId: string;
let nodeId: string;

/** Postgres error text, unwrapped from Drizzle's query error. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected the query to fail");
}

beforeAll(async () => {
  const h = await freshDb();
  db = h.db;
  cleanup = h.cleanup;
  const [u] = await db.insert(users).values({ email: "owner@example.in" }).returning();
  ownerId = u!.id;
  const [n] = await db
    .insert(nodes)
    .values({ ownerId, name: "hostel-pc", gpuClass: "rtx4070", defaultWatts: 350, ownerRatePaisePerHr: 2000 })
    .returning();
  nodeId = n!.id;
});

afterAll(async () => cleanup?.());

describe("migrations", () => {
  it("create every table", async () => {
    const res = await rows<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = new Set(res.map((r) => r.table_name));
    for (const t of ["user", "account", "session", "verificationToken", "waitlist", "node", "node_token", "job", "fragment", ...APPEND_ONLY_TABLES]) {
      expect(names).toContain(t);
    }
  });

  it("new nodes default to the ₹25/hr owner rate used by the pricing engine", async () => {
    const [n] = await db.insert(nodes).values({ ownerId, name: "default-rate", gpuClass: "rtx3060", defaultWatts: 320 }).returning();
    expect(n!.ownerRatePaisePerHr).toBe(DEFAULT_OWNER_RATE_PAISE_PER_HR);
  });

  it("apply defaults: role user, trust 500, ₹9/kWh tariff, 23:00–07:00 window", async () => {
    const [u] = await db.select().from(users).where(eq(users.id, ownerId));
    expect(u!.role).toBe("user");
    const [n] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(n).toMatchObject({ trustScore: 500, tariffPaisePerKwh: 900, nightWindowStartMin: 1380, nightWindowEndMin: 420, status: "pending" });
  });
});

describe("append-only ledgers and audit log", () => {
  beforeAll(async () => {
    await db.insert(ownerLedger).values({ ownerId, nodeId, entryType: "compute_pay", amountPaise: 1234, idempotencyKey: "o1" });
    await db.insert(buyerLedger).values({ buyerId: ownerId, entryType: "charge", amountPaise: 34000, idempotencyKey: "b1" });
    await db.insert(creditLedger).values({ userId: ownerId, entryType: "earned", amountGpuSeconds: 3600, idempotencyKey: "c1" });
    await audit(db, { actorId: ownerId, actorType: "user", action: "auth.login" }, "k");
  });

  it.each(APPEND_ONLY_TABLES)("%s rejects UPDATE", async (table) => {
    const column = table === "audit_log" ? "at" : "created_at";
    const msg = await pgError(db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = now()`));
    expect(msg).toMatch(/append-only/);
  });

  it.each(APPEND_ONLY_TABLES)("%s rejects DELETE", async (table) => {
    expect(await pgError(db.execute(sql`delete from ${sql.identifier(table)}`))).toMatch(/append-only/);
  });

  it.each(APPEND_ONLY_TABLES)("%s rejects TRUNCATE", async (table) => {
    expect(await pgError(db.execute(sql`truncate ${sql.identifier(table)}`))).toMatch(/append-only/);
  });

  it("rows are still there after the rejected writes", async () => {
    const [o] = await db.select().from(ownerLedger);
    expect(o!.amountPaise).toBe(1234);
  });

  it("idempotency keys stop double-booking", async () => {
    const msg = await pgError(
      db.insert(ownerLedger).values({ ownerId, entryType: "compute_pay", amountPaise: 1234, idempotencyKey: "o1" }),
    );
    expect(msg).toMatch(/duplicate key|unique/i);
  });

  it("corrections are new reversal rows; the balance is the sum", async () => {
    await db.insert(ownerLedger).values({ ownerId, entryType: "reversal", amountPaise: -234, idempotencyKey: "o1-rev" });
    const res = await rows<{ total: string }>(
      db,
      sql`select coalesce(sum(amount_paise), 0)::text as total from owner_ledger where owner_id = ${ownerId}`,
    );
    expect(Number(res[0]!.total)).toBe(1000);
  });

  it("users referenced by the ledger cannot be hard-deleted", async () => {
    expect(await pgError(db.delete(users).where(eq(users.id, ownerId)))).toMatch(/foreign key|violates/i);
  });
});

describe("check constraints", () => {
  const base = () => ({ ownerId, name: "x", gpuClass: "rtx3060" as const, defaultWatts: 320, ownerRatePaisePerHr: 1000 });

  it("trust score must stay within 0..1000", async () => {
    expect(await pgError(db.insert(nodes).values({ ...base(), trustScore: 1001 }))).toMatch(/node_trust_range/);
    expect(await pgError(db.insert(nodes).values({ ...base(), trustScore: -1 }))).toMatch(/node_trust_range/);
  });

  it("tariff must be positive and watts positive", async () => {
    expect(await pgError(db.insert(nodes).values({ ...base(), tariffPaisePerKwh: 0 }))).toMatch(/node_tariff_positive/);
    expect(await pgError(db.insert(nodes).values({ ...base(), defaultWatts: 0 }))).toMatch(/node_watts_positive/);
    expect(await pgError(db.insert(nodes).values({ ...base(), measuredWatts: -5 }))).toMatch(/node_watts_positive/);
  });

  it("night window minutes must be valid", async () => {
    expect(await pgError(db.insert(nodes).values({ ...base(), nightWindowStartMin: 1440 }))).toMatch(/node_window_range/);
  });
});

describe("node tokens", () => {
  it("store only the hash, and the hash is unique", async () => {
    const token = generateNodeToken();
    await db.insert(nodeTokens).values({ nodeId, tokenHash: hashToken(token) });
    const res = await rows(db, sql`select * from node_token`);
    expect(JSON.stringify(res)).not.toContain(token);
    expect(await pgError(db.insert(nodeTokens).values({ nodeId, tokenHash: hashToken(token) }))).toMatch(/duplicate key|unique/i);
  });
});

describe("audit log", () => {
  it("stores a keyed hash of the IP, never the IP", async () => {
    await audit(db, { actorId: ownerId, actorType: "user", action: "node.token_created", targetType: "node", targetId: nodeId, ip: "203.0.113.7" }, "secret");
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "node.token_created"));
    expect(row!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
  });

  it("skips the hash when the IP is unknown", async () => {
    await audit(db, { actorId: null, actorType: "system", action: "admin.action", ip: "unknown" }, "secret");
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "admin.action"));
    expect(row!.ipHash).toBeNull();
  });
});

describe("auth adapter data minimisation", () => {
  it("never stores name, picture or OAuth tokens", async () => {
    const adapter = minimalAdapter(db);
    const user = await adapter.createUser!({
      id: crypto.randomUUID(),
      email: "g@example.in",
      emailVerified: new Date(),
      name: "Real Name",
      image: "https://example.com/me.jpg",
      role: "user",
    });
    await adapter.linkAccount!({
      userId: user.id,
      type: "oidc",
      provider: "google",
      providerAccountId: "123",
      access_token: "ya29.secret",
      refresh_token: "1//refresh",
      id_token: "eyJ.id",
      expires_at: 123,
      token_type: "bearer",
      scope: "openid email",
    });
    await adapter.updateUser!({ id: user.id, name: "New Name", image: "https://x/y.png" });

    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u!.name).toBeNull();
    expect(u!.image).toBeNull();
    const [a] = await db.select().from(accounts).where(eq(accounts.userId, user.id));
    expect(a!.access_token).toBeNull();
    expect(a!.refresh_token).toBeNull();
    expect(a!.id_token).toBeNull();
  });

  it("deleteSession returns the deleted session so logout can be audited", async () => {
    const adapter = minimalAdapter(db);
    const expires = new Date(Date.now() + 60_000);
    await adapter.createSession!({ sessionToken: "tok-1", userId: ownerId, expires });
    const deleted = await adapter.deleteSession!("tok-1");
    expect(deleted).toMatchObject({ sessionToken: "tok-1", userId: ownerId });
    expect(await adapter.getSessionAndUser!("tok-1")).toBeNull();
    expect(await adapter.deleteSession!("missing")).toBeNull();
  });
});
