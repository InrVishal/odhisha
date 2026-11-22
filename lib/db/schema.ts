import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/*
 * Conventions
 * - Money is integer paise in `bigint` columns (mode "number": safe up to
 *   2^53 paise, about ₹90 lakh crore). Never floats.
 * - Ledger tables and the audit log are append-only. A trigger in migration
 *   0001 rejects UPDATE, DELETE and TRUNCATE on them. Balances are always
 *   SUM(amount) over the ledger, never a stored number.
 * - Users are never hard-deleted (ledger rows reference them). Account
 *   deletion scrubs personal fields and sets `deletedAt`.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

// ─── Enums ──────────────────────────────────────────────────────────────────

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const gpuClass = pgEnum("gpu_class", ["rtx3060", "rtx4070", "rtx4090", "cpu"]);
export const nodeStatus = pgEnum("node_status", ["pending", "online", "offline", "quarantined", "revoked"]);
export const workloadType = pgEnum("workload_type", ["text_embeddings", "image_captioning", "image_resize"]);
export const jobStatus = pgEnum("job_status", [
  "quoted",
  "queued",
  "running",
  "completed",
  "deadline_missed",
  "failed",
  "cancelled",
]);
export const fragmentStatus = pgEnum("fragment_status", ["pending", "leased", "done", "failed", "cancelled"]);
export const fragmentKind = pgEnum("fragment_kind", ["primary", "verification", "backup"]);
export const ownerEntryType = pgEnum("owner_entry_type", ["power_reimbursement", "compute_pay", "payout", "reversal"]);
export const buyerEntryType = pgEnum("buyer_entry_type", ["charge", "refund"]);
export const creditEntryType = pgEnum("credit_entry_type", ["earned", "spent", "reversal"]);
export const actorType = pgEnum("actor_type", ["user", "admin", "node", "system"]);
export const waitlistInterest = pgEnum("waitlist_interest", ["owner", "buyer", "both"]);

// ─── Auth.js tables (shape required by @auth/drizzle-adapter) ──────────────

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // Always null for Google sign-ins: we drop name and picture (DPDP data
  // minimisation). Email login never sets it either.
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
  // Set in the database only. No UI or API route changes this column.
  role: userRole("role").notNull().default("user"),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    // OAuth tokens are stripped before insert (see lib/auth/adapter.ts). We
    // never call Google APIs, so we have no reason to keep them.
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    // Auth.js stores a SHA-256 hash of the magic-link token, not the token.
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// ─── Marketing ──────────────────────────────────────────────────────────────

export const waitlist = pgTable("waitlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 254 }).notNull().unique(),
  interest: waitlistInterest("interest").notNull(),
  consentAt: timestamp("consent_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
});

// ─── Nodes ──────────────────────────────────────────────────────────────────

export const nodes = pgTable(
  "node",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 64 }).notNull(),
    gpuClass: gpuClass("gpu_class").notNull(),
    gpuModel: varchar("gpu_model", { length: 128 }),
    vramMb: integer("vram_mb"),
    /** Default draw for the class until the agent reports real watts. */
    defaultWatts: integer("default_watts").notNull(),
    /** Rolling average from nvidia-smi telemetry. Used for pricing once set. */
    measuredWatts: integer("measured_watts"),
    benchmarkScore: integer("benchmark_score"),
    /** 0..1000. New nodes start in the middle and move with verification results. */
    trustScore: integer("trust_score").notNull().default(500),
    status: nodeStatus("status").notNull().default("pending"),
    paused: boolean("paused").notNull().default(false),
    tariffPaisePerKwh: integer("tariff_paise_per_kwh").notNull().default(900),
    ownerRatePaisePerHr: integer("owner_rate_paise_per_hr").notNull(),
    /** Minutes after local midnight. Window may wrap past midnight (23:00–07:00). */
    nightWindowStartMin: smallint("night_window_start_min").notNull().default(23 * 60),
    nightWindowEndMin: smallint("night_window_end_min").notNull().default(7 * 60),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Kolkata"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("node_owner_idx").on(t.ownerId),
    index("node_status_idx").on(t.status),
    check("node_trust_range", sql`${t.trustScore} between 0 and 1000`),
    check("node_tariff_positive", sql`${t.tariffPaisePerKwh} > 0`),
    check("node_rate_nonnegative", sql`${t.ownerRatePaisePerHr} >= 0`),
    check("node_watts_positive", sql`${t.defaultWatts} > 0 and (${t.measuredWatts} is null or ${t.measuredWatts} > 0)`),
    check(
      "node_window_range",
      sql`${t.nightWindowStartMin} between 0 and 1439 and ${t.nightWindowEndMin} between 0 and 1439`,
    ),
  ],
);

/**
 * Agent credentials. The raw token (256 random bits) is shown to the owner
 * once. We store only its SHA-256 hash.
 */
export const nodeTokens = pgTable(
  "node_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("node_token_node_idx").on(t.nodeId)],
);

// ─── Jobs and fragments ────────────────────────────────────────────────────

export const jobs = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    workloadType: workloadType("workload_type").notNull(),
    /** Validated parameters for the workload. Never code. */
    params: jsonb("params").notNull(),
    status: jobStatus("status").notNull().default("quoted"),
    pricePaise: bigint("price_paise", { mode: "number" }).notNull(),
    /** Pricing breakdown as returned by lib/pricing (all paise). */
    breakdown: jsonb("breakdown").notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true, mode: "date" }).notNull(),
    quoteExpiresAt: timestamp("quote_expires_at", { withTimezone: true, mode: "date" }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    fragmentCount: integer("fragment_count").notNull().default(0),
    /** Inputs and outputs are deleted after this time (default: 7 days). */
    purgeAfter: timestamp("purge_after", { withTimezone: true, mode: "date" }),
    purgedAt: timestamp("purged_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("job_buyer_idx").on(t.buyerId),
    index("job_status_deadline_idx").on(t.status, t.deadlineAt),
    check("job_price_nonnegative", sql`${t.pricePaise} >= 0`),
  ],
);

export const fragments = pgTable(
  "fragment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: fragmentKind("kind").notNull().default("primary"),
    /** For verification and backup runs: the primary fragment they shadow. */
    parentFragmentId: uuid("parent_fragment_id"),
    status: fragmentStatus("status").notNull().default("pending"),
    estGpuSeconds: integer("est_gpu_seconds").notNull(),
    inputKey: varchar("input_key", { length: 128 }).notNull(),
    outputKey: varchar("output_key", { length: 128 }),
    outputDigest: varchar("output_digest", { length: 64 }),
    /** Per-fragment AES-256-GCM data key, wrapped with DATA_ENCRYPTION_KEY. */
    wrappedKey: text("wrapped_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseNodeId: uuid("lease_node_id").references(() => nodes.id, { onDelete: "set null" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    completedByNodeId: uuid("completed_by_node_id").references(() => nodes.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("fragment_job_idx").on(t.jobId, t.status),
    index("fragment_lease_idx").on(t.status, t.leaseExpiresAt),
    uniqueIndex("fragment_primary_seq_uq").on(t.jobId, t.seq).where(sql`${t.kind} = 'primary'`),
    check("fragment_attempts_range", sql`${t.attempts} >= 0 and ${t.attempts} <= ${t.maxAttempts}`),
    check("fragment_est_positive", sql`${t.estGpuSeconds} > 0`),
  ],
);

// ─── Append-only ledgers ───────────────────────────────────────────────────

/** Sign: + = owed to the owner, − = paid out to the owner. */
export const ownerLedger = pgTable(
  "owner_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "restrict" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    fragmentId: uuid("fragment_id"),
    entryType: ownerEntryType("entry_type").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    /** Makes retries safe: the same event can never be booked twice. */
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull().unique(),
    memo: varchar("memo", { length: 256 }),
    createdAt: createdAt(),
  },
  (t) => [index("owner_ledger_owner_idx").on(t.ownerId, t.createdAt)],
);

/** Sign: + = charged to the buyer, − = refunded to the buyer. */
export const buyerLedger = pgTable(
  "buyer_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    entryType: buyerEntryType("entry_type").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull().unique(),
    memo: varchar("memo", { length: 256 }),
    createdAt: createdAt(),
  },
  (t) => [index("buyer_ledger_buyer_idx").on(t.buyerId, t.createdAt)],
);

/** Time-Bank credits in GPU-seconds. + = earned, − = spent. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "restrict" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    entryType: creditEntryType("entry_type").notNull(),
    amountGpuSeconds: bigint("amount_gpu_seconds", { mode: "number" }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull().unique(),
    memo: varchar("memo", { length: 256 }),
    createdAt: createdAt(),
  },
  (t) => [index("credit_ledger_user_idx").on(t.userId, t.createdAt)],
);

// ─── Audit log (append-only) ───────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // No FK: the log must outlive whatever it describes.
    actorId: text("actor_id"),
    actorType: actorType("actor_type").notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }),
    targetId: text("target_id"),
    /** HMAC of the client IP, so we can spot abuse without storing the IP. */
    ipHash: varchar("ip_hash", { length: 64 }),
    meta: jsonb("meta"),
  },
  (t) => [index("audit_actor_idx").on(t.actorId, t.at), index("audit_action_idx").on(t.action, t.at)],
);

/** Tables that the append-only trigger protects. Tests iterate over this. */
export const APPEND_ONLY_TABLES = ["owner_ledger", "buyer_ledger", "credit_ledger", "audit_log"] as const;
