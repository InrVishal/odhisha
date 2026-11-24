/**
 * Operational alerts: something is degraded and the owner should know now,
 * not at the next daily tick. Each one is logged, written to audit_log as
 * "ops.alert" (target = the kind) and emailed straight away through the same
 * path as security alerts (lib/alerts.ts). At most one per kind per server
 * instance, and none if another instance already recorded the same kind in the
 * last 30 minutes, so an outage sends a handful of emails, not thousands.
 *
 * Fire and forget: the request that noticed carries on; a failure to record
 * or send is logged (names only) and dropped.
 */

export type OpsAlertKind = "ratelimit_fallback" | "ratelimit_fail_closed" | "isolation_redis" | "isolation_database";

const DESCRIPTIONS: Record<OpsAlertKind, string> = {
  ratelimit_fallback:
    "The shared rate limiter (Upstash) is failing. Agent and quote limits are running per server instance until it's back (each instance counts on its own).",
  ratelimit_fail_closed:
    "The shared rate limiter (Upstash) is failing. Sign-in, login emails, the waitlist and admin codes are refused (503) until it's back.",
  isolation_redis: "Preview and production are using the same Redis database (its owner marker says otherwise).",
  isolation_database: "A deployment is connected to the wrong environment's database (production endpoint marker mismatch).",
};

export function describeOpsAlert(kind: string): string {
  return DESCRIPTIONS[kind as OpsAlertKind] ?? `Operational alert: ${kind}`;
}

type Sink = (kind: OpsAlertKind, meta: Record<string, string>) => Promise<void>;

const raised = new Set<OpsAlertKind>();
let sink: Sink | null = null;

/** Tests swap the recorder; null restores the real one. */
export function setOpsAlertSink(s: Sink | null): void {
  sink = s;
  raised.clear();
}

export function raiseOpsAlert(kind: OpsAlertKind, meta: Record<string, string> = {}): void {
  if (raised.has(kind)) return;
  raised.add(kind);
  console.error(`[ops-alert] ${kind}: ${DESCRIPTIONS[kind]}`);
  void (sink ?? record)(kind, meta).catch((err: unknown) => {
    console.error(`[ops-alert] ${kind}: could not record or email it (${err instanceof Error ? err.name : typeof err})`);
  });
}

async function record(kind: OpsAlertKind, meta: Record<string, string>): Promise<void> {
  // Imported here: the rate limiter loads this module, and the database and
  // auth modules load the rate limiter.
  const [{ and, eq, gte }, { getDb }, { auditLog }, { audit }, { alertConfig, sendSecurityAlerts }, { getEnv }, { ipHashSecret }] = await Promise.all([
    import("drizzle-orm"),
    import("@/lib/db"),
    import("@/lib/db/schema"),
    import("@/lib/audit"),
    import("@/lib/alerts"),
    import("@/lib/env"),
    import("@/lib/auth"),
  ]);
  const db = await getDb();
  const since = new Date(Date.now() - 30 * 60 * 1000);
  const recent = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, "ops.alert"), eq(auditLog.targetId, kind), gte(auditLog.at, since)))
    .limit(1);
  if (recent.length > 0) return;
  await audit(db, { actorId: null, actorType: "system", action: "ops.alert", targetType: "ops", targetId: kind, meta }, ipHashSecret());
  await sendSecurityAlerts(db, alertConfig(getEnv()));
}
