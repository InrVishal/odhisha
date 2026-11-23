import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
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

/** Raw bytes. Every driver hands back a Buffer or a Uint8Array; normalise to Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (v) => v,
  fromDriver: (v) => Buffer.from(v),
});

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
/**
 * A verification copy's result. match: agrees with the copy it checks.
 * mismatch: disagrees, so a tie-break copy runs. corrected: a tie-break that
 * sided with the first checker, so the checked copy was wrong and its output
 * was replaced. inconclusive: a tie-break that agreed with nobody.
 */
export const checkVerdict = pgEnum("check_verdict", ["match", "mismatch", "corrected", "inconclusive"]);
export const ownerEntryType = pgEnum("owner_entry_type", ["power_reimbursement", "compute_pay", "payout", "reversal"]);
export const buyerEntryType = pgEnum("buyer_entry_type", ["charge", "refund"]);
/**
 * earned: + for one piece (pending until verified). spent: − against one
 * grant. refund: + back onto a grant (job paid with credits missed its
 * deadline). clawback: − the whole grant (its work was reversed or couldn't be
 * verified). expired: − what was left of a grant after 6 months. reversal:
 * unused, kept for the enum's history. There is no cash-out or transfer type.
 */
export const creditEntryType = pgEnum("credit_entry_type", ["earned", "spent", "reversal", "clawback", "expired", "refund"]);
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
  /**
   * Payout UPI ID, as a keyed hash (HMAC) so one UPI ID can belong to one
   * account only, plus a masked copy to show. Payouts are simulated, so the
   * full ID isn't kept.
   */
  upiHash: varchar("upi_hash", { length: 64 }).unique(),
  upiMasked: varchar("upi_masked", { length: 80 }),
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
    /** True when the reported watts are a declared estimate (CPU mode, no nvidia-smi). */
    wattsEstimated: boolean("watts_estimated").notNull().default(false),
    /**
     * Speed score (RTX 3060 = 1000) measured BY THE COORDINATOR from signed
     * challenge pieces it timed itself: the median of recent runs, outliers
     * dropped. Null until there are enough runs; the class default is used then.
     */
    benchmarkScore: integer("benchmark_score"),
    /** What the agent says its benchmark is. Shown, never used for anything. */
    reportedBenchmark: integer("reported_benchmark"),
    /** Pieces of buyers' jobs this PC has handed in (counted copies). New PCs are checked more. */
    piecesDone: integer("pieces_done").notNull().default(0),
    /** Time-Bank: pieces of buyers' jobs earn credits instead of compute pay (electricity is still paid). */
    earnsCredits: boolean("earns_credits").notNull().default(false),
    /** Keyed hash of the agent's device ID, and of the network (/24 or /48) it last called from. */
    deviceHash: varchar("device_hash", { length: 64 }),
    subnetHash: varchar("subnet_hash", { length: 64 }),
    /** When this PC was last sent a canary (a challenge or a known-answer piece). */
    lastCanaryAt: timestamp("last_canary_at", { withTimezone: true, mode: "date" }),
    /** 0..1000. New nodes start in the middle and move with verification results. */
    trustScore: integer("trust_score").notNull().default(500),
    /** Verification results for work this PC did (as the checked or the checking PC). */
    checksPassed: integer("checks_passed").notNull().default(0),
    checksFailed: integer("checks_failed").notNull().default(0),
    status: nodeStatus("status").notNull().default("pending"),
    paused: boolean("paused").notNull().default(false),
    tariffPaisePerKwh: integer("tariff_paise_per_kwh").notNull().default(900),
    /** ₹25/hr by default (DEFAULT_OWNER_RATE_PAISE_PER_HR in lib/pricing.ts). */
    ownerRatePaisePerHr: integer("owner_rate_paise_per_hr").notNull().default(2500),
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
    index("node_device_idx").on(t.deviceHash),
    index("node_subnet_idx").on(t.subnetHash),
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
    /** Node class the job was quoted for. Only nodes of this class run it. */
    gpuClass: gpuClass("gpu_class").notNull(),
    /** Validated parameters for the workload. Never code. */
    params: jsonb("params").notNull(),
    itemCount: integer("item_count").notNull(),
    /**
     * Price cap from the quote: a node may run this job only if its
     * watts × tariff and its rate are no higher than these, so what owners
     * are paid can never exceed what the buyer was quoted.
     */
    maxWattTariff: integer("max_watt_tariff").notNull(),
    maxOwnerRate: integer("max_owner_rate").notNull(),
    status: jobStatus("status").notNull().default("quoted"),
    pricePaise: bigint("price_paise", { mode: "number" }).notNull(),
    /** Pricing breakdown as returned by lib/pricing (all paise). */
    breakdown: jsonb("breakdown").notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true, mode: "date" }).notNull(),
    quoteExpiresAt: timestamp("quote_expires_at", { withTimezone: true, mode: "date" }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    /** Set when the full price was refunded (deadline missed or job failed). */
    refundedAt: timestamp("refunded_at", { withTimezone: true, mode: "date" }),
    fragmentCount: integer("fragment_count").notNull().default(0),
    /**
     * Set only on coordinator challenge jobs (known-answer pieces that also
     * time a PC). Holds what the output must satisfy; never sent to agents.
     */
    challenge: jsonb("challenge"),
    /** Paid with Time-Bank credits (standard GPU-seconds) instead of money. Null: paid in money. */
    creditsSpent: bigint("credits_spent", { mode: "number" }),
    /** Inputs and outputs are deleted after this time (default: 7 days). */
    purgeAfter: timestamp("purge_after", { withTimezone: true, mode: "date" }),
    purgedAt: timestamp("purged_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("job_buyer_idx").on(t.buyerId),
    index("job_status_deadline_idx").on(t.status, t.deadlineAt),
    check("job_price_nonnegative", sql`${t.pricePaise} >= 0`),
    check("job_items_positive", sql`${t.itemCount} > 0`),
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
    /** Primary fragments picked at confirm time to be re-run on a second PC once done. */
    verify: boolean("verify").notNull().default(false),
    /** Verification copies only: did its output agree with the copy it checked? */
    verdict: checkVerdict("verdict"),
    /**
     * A known-answer canary: a re-run of a piece two PCs of different owners
     * already agreed on, sent to a third PC as an ordinary check.
     */
    canary: boolean("canary").notNull().default(false),
    /** GPU-seconds this fragment was priced at, on the job's node class. */
    estGpuSeconds: integer("est_gpu_seconds").notNull(),
    itemCount: integer("item_count").notNull(),
    inputKey: varchar("input_key", { length: 128 }).notNull(),
    /** sha256 of the plaintext input, signed into the task so agents can check it. */
    inputSha256: varchar("input_sha256", { length: 64 }).notNull(),
    outputKey: varchar("output_key", { length: 128 }),
    outputDigest: varchar("output_digest", { length: 64 }),
    /** Per-fragment AES-256-GCM data key, wrapped with DATA_ENCRYPTION_KEY. */
    wrappedKey: text("wrapped_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseNodeId: uuid("lease_node_id").references(() => nodes.id, { onDelete: "set null" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    /** Expected run time on the leasing node, for spotting slow fragments. */
    leaseExpectedSec: integer("lease_expected_sec"),
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

/** One timed, passed challenge run: the coordinator's own clock, lease to result. */
export const benchmarkSamples = pgTable(
  "benchmark_sample",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    items: integer("items").notNull(),
    millis: integer("millis").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("benchmark_sample_node_idx").on(t.nodeId, t.createdAt), check("benchmark_sample_positive", sql`${t.items} > 0 and ${t.millis} > 0`)],
);

/**
 * Encrypted job data (fragment inputs and outputs). Kept in Postgres so the
 * prototype needs no extra storage service. Every value is AES-256-GCM sealed
 * under its fragment's own data key (lib/security/envelope.ts). Keys are
 * random, so they reveal nothing. Rows are deleted when the job is purged.
 */
export const blobs = pgTable(
  "blob",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    data: bytea("data").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("blob_job_idx").on(t.jobId)],
);

/**
 * Cross-instance locks with an expiry. The scheduler tick takes one so that
 * cron and agent polls never run it twice at once.
 */
export const locks = pgTable("lock", {
  name: varchar("name", { length: 64 }).primaryKey(),
  lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }).notNull(),
});

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

/**
 * Time-Bank credits in standard GPU-seconds (weighting is frozen at 1.0×,
 * see lib/timebank.ts). Balance = SUM(amount). Per grant: earned + its
 * spent/refund/clawback/expired rows = what is left of it.
 * Credits are not money: there is no cash-out entry type.
 */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "restrict" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    /** earned: the piece that earned it. */
    fragmentId: uuid("fragment_id"),
    /** spent, refund, clawback, expired: the earned row (grant) they apply to. */
    grantId: bigint("grant_id", { mode: "number" }),
    /** earned only: 6 months after it was earned. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    entryType: creditEntryType("entry_type").notNull(),
    amountGpuSeconds: bigint("amount_gpu_seconds", { mode: "number" }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull().unique(),
    memo: varchar("memo", { length: 256 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("credit_ledger_user_idx").on(t.userId, t.createdAt),
    index("credit_ledger_grant_idx").on(t.grantId),
    index("credit_ledger_fragment_idx").on(t.fragmentId),
  ],
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
